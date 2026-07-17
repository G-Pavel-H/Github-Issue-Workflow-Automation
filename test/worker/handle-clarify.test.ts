import { describe, it, expect, beforeEach, type Mock } from 'vitest';
import { handleClarify, type PlanHandlerDeps } from '../../src/worker/handlers.js';
import { LlmGateway } from '../../src/llm/gateway.js';
import { InMemoryStore } from '../../src/store/memory-store.js';
import { RunState, type Job } from '../../src/store/types.js';
import type { CodeChunk } from '../../src/index/types.js';
import { FakeLlmProvider, textResponse } from '../llm/fake-provider.js';
import { fakeCloneRepo, fakeCodeIndex, fakeGitHub, silentLog } from '../helpers.js';

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

/**
 * Build clarify deps with a spy code index + clone fn (defaults degrade to text-only). Returns the
 * spies so tests can assert the code-grounding lifecycle.
 */
function clarifyDeps(
  store: InMemoryStore,
  provider: FakeLlmProvider,
  opts: { chunks?: CodeChunk[]; github?: ReturnType<typeof fakeGitHub> } = {},
) {
  const github = opts.github ?? fakeGitHub({ language: 'TypeScript' });
  const codeIndex = fakeCodeIndex(opts.chunks ?? []);
  const clone = fakeCloneRepo();
  const deps: PlanHandlerDeps = {
    store,
    github,
    gateway: new LlmGateway(provider, store, silentLog),
    codeIndex,
    cloneRepo: clone.fn,
    log: silentLog,
  };
  return { deps, github, codeIndex, clone };
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
    const { deps, github } = clarifyDeps(store, clarifierProvider([]));

    await handleClarify(job, deps);

    expect(github.postIssueComment).not.toHaveBeenCalled();
    expect((await store.getRunById(runId))!.state).toBe(RunState.Specified);
    // Gate passed → planning is chained.
    expect((await store.claimNextJob())!.type).toBe('produce_plan');
  });

  it('parks with a single batched question comment when within the cap', async () => {
    const runId = await seedSpecifyingRun(store);
    const questions = ['CSV or JSON export?', 'Which timezone for timestamps?'];
    const { deps, github } = clarifyDeps(store, clarifierProvider(questions));

    await handleClarify(job, deps);

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
    const tooMany = ['q1', 'q2', 'q3', 'q4', 'q5'];
    const { deps, github } = clarifyDeps(store, clarifierProvider(tooMany));

    await handleClarify(job, deps);

    expect(github.postIssueComment).toHaveBeenCalledTimes(1);
    expect(github.calls[0]!.body.toLowerCase()).toContain('underspecified');
    expect((await store.getRunById(runId))!.state).toBe(RunState.Failed);
  });

  it('is idempotent — skips when the run is not in the Specifying state', async () => {
    const runId = await seedSpecifyingRun(store);
    await store.updateRunState(runId, RunState.AwaitingClarification); // already gated
    const provider = clarifierProvider(['q1']);
    const { deps, github, codeIndex, clone } = clarifyDeps(store, provider);

    await handleClarify(job, deps);

    expect(provider.requests).toHaveLength(0);
    expect(github.postIssueComment).not.toHaveBeenCalled();
    // Skipped before any code grounding — no clone/index work done.
    expect(clone.fn).not.toHaveBeenCalled();
    expect(codeIndex.indexRepo).not.toHaveBeenCalled();
  });

  it('stops gracefully when the run budget is exhausted', async () => {
    const runId = await seedSpecifyingRun(store);
    await store.setRunBudget(runId, 0); // already exhausted — gateway refuses
    const { deps, github } = clarifyDeps(store, clarifierProvider(['q1']));

    await handleClarify(job, deps);

    expect((await store.getRunById(runId))!.state).toBe(RunState.Failed);
    expect(github.postIssueComment).toHaveBeenCalled();
  });

  it('grounds the Clarifier in code — passes the repo map + retrieved chunks into its prompt, then tears down', async () => {
    await seedSpecifyingRun(store);
    const chunks: CodeChunk[] = [
      { path: 'src/export.ts', startLine: 10, endLine: 14, content: 'export function exportJson() {}' },
    ];
    const provider = clarifierProvider([]);
    const { deps, codeIndex, clone } = clarifyDeps(store, provider, { chunks });

    await handleClarify(job, deps);

    // The single Clarifier request carries the retrieved chunk content (+ the draft spec).
    expect(provider.requests).toHaveLength(1);
    const content = provider.requests[0]!.messages[0]!.content as string;
    expect(content).toContain('Some drafted spec content.'); // still text-grounded
    expect(content).toContain('src/export.ts'); // retrieved chunk header
    expect(content).toContain('export function exportJson() {}'); // retrieved chunk body

    // Retrieval keyed on the draft spec, with guaranteed teardown.
    expect(clone.fn).toHaveBeenCalledTimes(1);
    expect(codeIndex.indexRepo).toHaveBeenCalledTimes(1);
    expect(codeIndex.retrieve).toHaveBeenCalledTimes(1);
    expect(codeIndex.retrieve.mock.calls[0]![1]).toContain('Some drafted spec content.');
    expect(codeIndex.dropNamespace).toHaveBeenCalledTimes(1);
    expect(clone.cleanup).toHaveBeenCalledTimes(1);
  });

  it('still runs (text-only) when code grounding fails — clone throws', async () => {
    const runId = await seedSpecifyingRun(store);
    const provider = clarifierProvider(['CSV or JSON export?']);
    const { deps, github, codeIndex, clone } = clarifyDeps(store, provider);
    // Clone blows up (e.g. transient git error) — the gate must still run exactly as before.
    (clone.fn as Mock).mockRejectedValue(new Error('git clone failed'));

    await handleClarify(job, deps);

    // Clarifier still ran, from the spec text alone, and parked normally.
    expect(provider.requests).toHaveLength(1);
    const content = provider.requests[0]!.messages[0]!.content as string;
    expect(content).toContain('Some drafted spec content.');
    expect(codeIndex.indexRepo).not.toHaveBeenCalled(); // never got past the clone
    expect(github.postIssueComment).toHaveBeenCalledTimes(1);
    expect((await store.getRunById(runId))!.state).toBe(RunState.AwaitingClarification);
  });
});
