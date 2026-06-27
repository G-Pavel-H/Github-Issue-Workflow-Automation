import { describe, it, expect, beforeEach } from 'vitest';
import { handleResumeClarification } from '../../src/worker/handlers.js';
import { LlmGateway } from '../../src/llm/gateway.js';
import { InMemoryStore } from '../../src/store/memory-store.js';
import { RunState, type Job } from '../../src/store/types.js';
import { FakeLlmProvider, textResponse } from '../llm/fake-provider.js';
import { fakeGitHub, silentLog } from '../helpers.js';

const job: Job = {
  id: 12,
  type: 'resume_clarification',
  status: 'in_progress',
  attempts: 1,
  payload: {
    installationId: 7,
    owner: 'acme',
    repo: 'widgets',
    issueNumber: 42,
    commentBody: 'Use JSON export, and timestamps in UTC.',
  },
};

const finalizedSpecJson = JSON.stringify({
  summary: 'Add an export with the maintainer-confirmed format.',
  requirements: [
    { id: 'R1', statement: 'Export is JSON.', confidence: 'explicit' },
    { id: 'R2', statement: 'Timestamps are UTC.', confidence: 'explicit' },
  ],
  acceptanceCriteria: [
    { id: 'AC1', given: 'data exists', when: 'export runs', then: 'a JSON file is produced' },
  ],
  nonGoals: [],
  edgeCases: [],
  assumptions: [],
  openQuestions: [],
});

function poProvider(): FakeLlmProvider {
  return new FakeLlmProvider([
    textResponse(finalizedSpecJson, { inputTokens: 500, outputTokens: 250 }),
  ]);
}

/** A run parked at AwaitingClarification with the prior questions persisted + a draft spec. */
async function seedParkedRun(store: InMemoryStore): Promise<number> {
  const { run } = await store.findOrCreateRun(job.payload, RunState.Received);
  await store.updateRunState(run.id, RunState.AwaitingClarification);
  await store.updateRunContext(run.id, {
    clarification: { questions: ['CSV or JSON export?', 'Which timezone?'] },
  });
  await store.recordArtifact({
    runId: run.id,
    kind: 'spec',
    path: '.tsukinome/42/spec.md',
    content: '# Spec — draft\n\nDraft with open questions.',
    commitSha: 'aaa',
  });
  return run.id;
}

describe('handleResumeClarification', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('folds the answer into the spec, re-commits, comments, and advances to Specified', async () => {
    const runId = await seedParkedRun(store);
    const github = fakeGitHub({ language: 'TypeScript' });
    const gateway = new LlmGateway(poProvider(), store, silentLog);

    await handleResumeClarification(job, { store, github, gateway, log: silentLog });

    // Spec re-committed to the working branch.
    expect(github.commitFile).toHaveBeenCalledTimes(1);
    const commit = github.commitFile.mock.calls[0]![0];
    expect(commit.branch).toBe('tsukinome/issue-42');
    expect(commit.path).toBe('.tsukinome/42/spec.md');
    expect(commit.content).toContain('JSON');

    // Artifact updated with the finalized spec.
    const artifact = await store.getArtifact(runId, 'spec');
    expect(artifact!.content).toContain('JSON');

    // "Spec updated" comment posted; run advanced.
    expect(github.postIssueComment).toHaveBeenCalledTimes(1);
    expect(github.calls[0]!.body.toLowerCase()).toContain('updated');
    expect((await store.getRunById(runId))!.state).toBe(RunState.Specified);
  });

  it('is idempotent — skips when the run is not awaiting clarification', async () => {
    const runId = await seedParkedRun(store);
    await store.updateRunState(runId, RunState.Specified); // already resumed
    const provider = poProvider();
    const github = fakeGitHub({ language: 'TypeScript' });

    await handleResumeClarification(job, {
      store,
      github,
      gateway: new LlmGateway(provider, store, silentLog),
      log: silentLog,
    });

    expect(provider.requests).toHaveLength(0);
    expect(github.commitFile).not.toHaveBeenCalled();
    expect(github.postIssueComment).not.toHaveBeenCalled();
  });

  it('stops gracefully when the run budget is exhausted', async () => {
    const runId = await seedParkedRun(store);
    await store.setRunBudget(runId, 0);
    const github = fakeGitHub({ language: 'TypeScript' });
    const gateway = new LlmGateway(poProvider(), store, silentLog);

    await handleResumeClarification(job, { store, github, gateway, log: silentLog });

    expect(github.commitFile).not.toHaveBeenCalled();
    expect((await store.getRunById(runId))!.state).toBe(RunState.Failed);
    expect(github.postIssueComment).toHaveBeenCalled();
  });
});
