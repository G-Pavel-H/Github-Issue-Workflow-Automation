import { describe, it, expect, beforeEach } from 'vitest';
import { handleReview } from '../../src/worker/handlers.js';
import { LlmGateway } from '../../src/llm/gateway.js';
import { InMemoryStore } from '../../src/store/memory-store.js';
import { RunState, type Job } from '../../src/store/types.js';
import type { Plan, Spec } from '../../src/pipeline/schemas.js';
import { FakeLlmProvider, textResponse } from '../llm/fake-provider.js';
import { fakeGitHub, silentLog } from '../helpers.js';

const job: Job = {
  id: 40,
  type: 'review',
  status: 'in_progress',
  attempts: 1,
  payload: { installationId: 7, owner: 'acme', repo: 'widgets', issueNumber: 42 },
};

const specData: Spec = {
  summary: 'Add a JSON export.',
  requirements: [{ id: 'R1', statement: 'Export is JSON.', confidence: 'explicit' }],
  acceptanceCriteria: [{ id: 'AC1', given: 'data', when: 'export', then: 'json' }],
  nonGoals: ['CSV'],
  edgeCases: [],
  assumptions: ['UTC timestamps'],
  openQuestions: [],
};

const planData: Plan = {
  summary: 'exporter module',
  approach: 'reuse serializer',
  affectedFiles: [{ path: 'src/export.ts', change: 'add', reason: 'exporter' }],
  contracts: [],
  dataChanges: [],
  testStrategy: ['unit test'],
};

const reviewJson = (verdict: 'approve' | 'request_changes') =>
  JSON.stringify({ verdict, summary: 'Looks good.', findings: [] });

async function seedReviewingRun(store: InMemoryStore): Promise<number> {
  const { run } = await store.findOrCreateRun(job.payload, RunState.Received);
  await store.updateRunState(run.id, RunState.Reviewing);
  await store.updateRunContext(run.id, { spec: { title: 'JSON export' }, specData, planData });
  await store.recordArtifact({ runId: run.id, kind: 'spec', path: '.tsukinome/42/spec.md', content: '# spec' });
  await store.recordArtifact({ runId: run.id, kind: 'plan', path: '.tsukinome/42/plan.md', content: '# plan' });
  return run.id;
}

function deps(store: InMemoryStore, provider: FakeLlmProvider) {
  const github = fakeGitHub({ language: 'TypeScript' });
  return { store, github, gateway: new LlmGateway(provider, store, silentLog), log: silentLog };
}

describe('handleReview', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('reviews the diff, opens a PR, comments, and parks awaiting PR review', async () => {
    const runId = await seedReviewingRun(store);
    const provider = new FakeLlmProvider([textResponse(reviewJson('approve'), { inputTokens: 400, outputTokens: 100 })]);
    const d = deps(store, provider);

    await handleReview(job, d);

    expect(d.github.compareDiff).toHaveBeenCalledTimes(1);
    expect(d.github.openPullRequest).toHaveBeenCalledTimes(1);
    const prCall = d.github.openPullRequest.mock.calls[0]![0];
    expect(prCall.head).toBe('tsukinome/issue-42');
    expect(prCall.body).toContain('Resolves #42');
    expect(prCall.body).toContain('UTC timestamps'); // assumptions in the body
    // Issue comment links the PR.
    expect(d.github.calls.at(-1)!.body).toContain('https://github.com/acme/widgets/pull/7');
    // No agent writes — only the Integrator/comment touched the repo (no file commits in review).
    expect(d.github.commitFiles).not.toHaveBeenCalled();
    expect(d.github.commitFile).not.toHaveBeenCalled();
    expect((await store.getRunById(runId))!.state).toBe(RunState.AwaitingPrReview);
  });

  it('opens the PR even on a request_changes verdict (review is advisory)', async () => {
    await seedReviewingRun(store);
    const d = deps(store, new FakeLlmProvider([textResponse(reviewJson('request_changes'))]));

    await handleReview(job, d);

    expect(d.github.openPullRequest).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — skips when the run is not Reviewing', async () => {
    const { run } = await store.findOrCreateRun(job.payload, RunState.Received);
    await store.updateRunState(run.id, RunState.AwaitingPrReview);
    const provider = new FakeLlmProvider();
    const d = deps(store, provider);

    await handleReview(job, d);

    expect(provider.requests).toHaveLength(0);
    expect(d.github.openPullRequest).not.toHaveBeenCalled();
  });

  it('stops gracefully when the run budget is exhausted', async () => {
    const runId = await seedReviewingRun(store);
    await store.setRunBudget(runId, 0);
    const d = deps(store, new FakeLlmProvider([textResponse(reviewJson('approve'))]));

    await handleReview(job, d);

    expect(d.github.openPullRequest).not.toHaveBeenCalled();
    expect((await store.getRunById(runId))!.state).toBe(RunState.Failed);
    expect(d.github.postIssueComment).toHaveBeenCalled();
  });
});
