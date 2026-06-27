import { describe, it, expect, beforeEach } from 'vitest';
import { handleClarify } from '../../src/worker/handlers.js';
import { LlmGateway } from '../../src/llm/gateway.js';
import { InMemoryStore } from '../../src/store/memory-store.js';
import { RunState, type Job } from '../../src/store/types.js';
import { FakeLlmProvider, textResponse } from '../llm/fake-provider.js';
import { fakeGitHub, silentLog } from '../helpers.js';

const job: Job = {
  id: 11,
  type: 'clarify',
  status: 'in_progress',
  attempts: 1,
  payload: { installationId: 7, owner: 'acme', repo: 'widgets', issueNumber: 42 },
};

const specMarkdown = '# Spec — Issue #42\n\nSome drafted spec content.';

function clarifierProvider(questions: string[]): FakeLlmProvider {
  return new FakeLlmProvider([
    textResponse(JSON.stringify({ questions }), { inputTokens: 300, outputTokens: 40 }),
  ]);
}

/** Set up a run parked at `Specifying` with a committed draft spec artifact. */
async function seedSpecifyingRun(store: InMemoryStore): Promise<number> {
  const { run } = await store.findOrCreateRun(job.payload, RunState.Received);
  await store.updateRunState(run.id, RunState.Specifying);
  await store.recordArtifact({
    runId: run.id,
    kind: 'spec',
    path: '.tsukinome/42/spec.md',
    content: specMarkdown,
    commitSha: 'aaa',
  });
  return run.id;
}

describe('handleClarify', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('passes the gate silently when there are no questions', async () => {
    const runId = await seedSpecifyingRun(store);
    const github = fakeGitHub({ language: 'TypeScript' });
    const gateway = new LlmGateway(clarifierProvider([]), store, silentLog);

    await handleClarify(job, { store, github, gateway, log: silentLog });

    expect(github.postIssueComment).not.toHaveBeenCalled();
    expect((await store.getRunById(runId))!.state).toBe(RunState.Specified);
  });

  it('parks with a single batched question comment when within the cap', async () => {
    const runId = await seedSpecifyingRun(store);
    const github = fakeGitHub({ language: 'TypeScript' });
    const questions = ['CSV or JSON export?', 'Which timezone for timestamps?'];
    const gateway = new LlmGateway(clarifierProvider(questions), store, silentLog);

    await handleClarify(job, { store, github, gateway, log: silentLog });

    // Exactly one comment, containing every question.
    expect(github.postIssueComment).toHaveBeenCalledTimes(1);
    const body = github.calls[0]!.body;
    expect(body).toContain('CSV or JSON export?');
    expect(body).toContain('Which timezone for timestamps?');

    const run = await store.getRunById(runId);
    expect(run!.state).toBe(RunState.AwaitingClarification);
    // The questions are persisted in context so resume can pair them with the answer.
    expect(run!.context).toEqual({ clarification: { questions } });
  });

  it('bounces a too-underspecified issue when over the cap', async () => {
    const runId = await seedSpecifyingRun(store);
    const github = fakeGitHub({ language: 'TypeScript' });
    const tooMany = ['q1', 'q2', 'q3', 'q4', 'q5'];
    const gateway = new LlmGateway(clarifierProvider(tooMany), store, silentLog);

    await handleClarify(job, { store, github, gateway, log: silentLog });

    expect(github.postIssueComment).toHaveBeenCalledTimes(1);
    expect(github.calls[0]!.body.toLowerCase()).toContain('underspecified');
    expect((await store.getRunById(runId))!.state).toBe(RunState.Failed);
  });

  it('is idempotent — skips when the run is not in the Specifying state', async () => {
    const runId = await seedSpecifyingRun(store);
    await store.updateRunState(runId, RunState.AwaitingClarification); // already gated
    const provider = clarifierProvider(['q1']);
    const github = fakeGitHub({ language: 'TypeScript' });

    await handleClarify(job, {
      store,
      github,
      gateway: new LlmGateway(provider, store, silentLog),
      log: silentLog,
    });

    expect(provider.requests).toHaveLength(0);
    expect(github.postIssueComment).not.toHaveBeenCalled();
  });

  it('stops gracefully when the run budget is exhausted', async () => {
    const runId = await seedSpecifyingRun(store);
    await store.setRunBudget(runId, 0); // already exhausted — gateway refuses
    const github = fakeGitHub({ language: 'TypeScript' });
    const gateway = new LlmGateway(clarifierProvider(['q1']), store, silentLog);

    await handleClarify(job, { store, github, gateway, log: silentLog });

    expect((await store.getRunById(runId))!.state).toBe(RunState.Failed);
    expect(github.postIssueComment).toHaveBeenCalled();
  });
});
