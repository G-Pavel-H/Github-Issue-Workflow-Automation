import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStore } from '../../src/store/memory-store.js';
import { RunState, type RunKey } from '../../src/store/types.js';

const payload = {
  installationId: 1,
  owner: 'acme',
  repo: 'widgets',
  issueNumber: 42,
  deliveryId: 'delivery-1',
};

const key: RunKey = {
  installationId: 1,
  owner: 'acme',
  repo: 'widgets',
  issueNumber: 42,
};

describe('InMemoryStore — job queue', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('enqueues then claims a job, marking it in_progress', async () => {
    const job = await store.enqueueJob({ type: 'issue_opened', payload });
    expect(job.status).toBe('queued');

    const claimed = await store.claimNextJob();
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(job.id);
    expect(claimed!.status).toBe('in_progress');
    expect(claimed!.payload).toEqual(payload);
  });

  it('claims jobs FIFO and returns null when the queue is empty', async () => {
    const a = await store.enqueueJob({ type: 'issue_opened', payload });
    const b = await store.enqueueJob({ type: 'issue_opened', payload });

    expect((await store.claimNextJob())!.id).toBe(a.id);
    expect((await store.claimNextJob())!.id).toBe(b.id);
    expect(await store.claimNextJob()).toBeNull();
  });

  it('does not re-claim a job that is done', async () => {
    const job = await store.enqueueJob({ type: 'issue_opened', payload });
    await store.claimNextJob();
    await store.markJobDone(job.id);
    expect(await store.claimNextJob()).toBeNull();
  });

  it('marks a job failed with an error and does not re-claim it', async () => {
    const job = await store.enqueueJob({ type: 'issue_opened', payload });
    await store.claimNextJob();
    await store.markJobFailed(job.id, 'boom');
    expect(await store.claimNextJob()).toBeNull();
  });
});

describe('InMemoryStore — job retries & lease recovery', () => {
  let clock: number;
  let store: InMemoryStore;
  beforeEach(() => {
    clock = 1_000_000;
    store = new InMemoryStore({ now: () => clock });
  });

  it('re-queues a failed job with a backoff delay; not claimable until due', async () => {
    const job = await store.enqueueJob({ type: 'issue_opened', payload });
    await store.claimNextJob(); // attempts -> 1
    const res = await store.failOrRetryJob(job.id, 'boom', { maxAttempts: 3, backoffMs: 1000 });
    expect(res).toEqual({ status: 'queued', attempts: 1 });

    // Still backing off — nothing due yet.
    expect(await store.claimNextJob()).toBeNull();

    // After the backoff elapses it becomes claimable again.
    clock += 1000;
    const reclaimed = await store.claimNextJob();
    expect(reclaimed!.id).toBe(job.id);
    expect(reclaimed!.attempts).toBe(2);
  });

  it('dead-letters once the attempt cap is reached', async () => {
    const job = await store.enqueueJob({ type: 'issue_opened', payload });
    await store.claimNextJob(); // attempts -> 1
    await store.failOrRetryJob(job.id, 'boom', { maxAttempts: 1, backoffMs: 1000 });
    expect(store.getJob(job.id)!.status).toBe('failed');
    clock += 10_000;
    expect(await store.claimNextJob()).toBeNull();
  });

  it('reclaims an in_progress job whose worker died (lease expired)', async () => {
    const job = await store.enqueueJob({ type: 'issue_opened', payload });
    const first = await store.claimNextJob(60_000);
    expect(first!.id).toBe(job.id);

    // Worker never finished; before the lease lapses it stays locked.
    clock += 30_000;
    expect(await store.claimNextJob(60_000)).toBeNull();

    // After the lease lapses, a live worker reclaims it (attempts bumped again).
    clock += 31_000;
    const reclaimed = await store.claimNextJob(60_000);
    expect(reclaimed!.id).toBe(job.id);
    expect(reclaimed!.attempts).toBe(2);
  });
});

describe('InMemoryStore — stale runs', () => {
  let clock: number;
  let store: InMemoryStore;
  beforeEach(() => {
    clock = 1_000_000;
    store = new InMemoryStore({ now: () => clock });
  });

  it('lists parked runs untouched since the cutoff and tracks pings without resetting the clock', async () => {
    const { run } = await store.findOrCreateRun(key, RunState.AwaitingPlanApproval);
    const createdAt = clock;

    // Not stale yet.
    expect(await store.getStaleRuns([RunState.AwaitingPlanApproval], createdAt)).toHaveLength(0);

    clock += 5000;
    const stale = await store.getStaleRuns([RunState.AwaitingPlanApproval], clock);
    expect(stale.map((r) => r.id)).toEqual([run.id]);
    expect(stale[0]!.stalePingedAt).toBeNull();

    // A ping is recorded but does NOT reset updatedAt — the run is still stale.
    await store.markRunPinged(run.id, clock);
    const after = await store.getStaleRuns([RunState.AwaitingPlanApproval], clock + 1);
    expect(after.map((r) => r.id)).toEqual([run.id]);
    expect(after[0]!.stalePingedAt).toBe(clock);
  });

  it('filters by state', async () => {
    const { run } = await store.findOrCreateRun(key, RunState.AwaitingPlanApproval);
    clock += 5000;
    expect(await store.getStaleRuns([RunState.AwaitingPrReview], clock)).toHaveLength(0);
    await store.updateRunState(run.id, RunState.AwaitingPrReview);
    expect(await store.getStaleRuns([RunState.AwaitingPrReview], clock)).toHaveLength(0); // updatedAt just bumped
    clock += 5000;
    expect(await store.getStaleRuns([RunState.AwaitingPrReview], clock).then((r) => r.length)).toBe(1);
  });
});

describe('InMemoryStore — cost metrics', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('reports zeros with no runs', async () => {
    expect(await store.getCostMetrics()).toEqual({ runCount: 0, totalNanoUsd: 0, avgCostNanoUsd: 0 });
  });

  it('aggregates measured spend across runs', async () => {
    const a = await store.findOrCreateRun(key, RunState.Received);
    const b = await store.findOrCreateRun(
      { ...key, issueNumber: 43 },
      RunState.Received,
    );
    await store.recordLlmCall({
      runId: a.run.id,
      role: 'triage',
      model: 'm',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costNanoUsd: 300,
    });
    await store.recordLlmCall({
      runId: b.run.id,
      role: 'triage',
      model: 'm',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costNanoUsd: 100,
    });
    expect(await store.getCostMetrics()).toEqual({ runCount: 2, totalNanoUsd: 400, avgCostNanoUsd: 200 });
  });
});

describe('InMemoryStore — runs', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('creates a run on first findOrCreateRun and returns it thereafter', async () => {
    const first = await store.findOrCreateRun(key, RunState.Received);
    expect(first.created).toBe(true);
    expect(first.run.state).toBe(RunState.Received);

    const second = await store.findOrCreateRun(key, RunState.Received);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
  });

  it('updates run state', async () => {
    const { run } = await store.findOrCreateRun(key, RunState.Received);
    await store.updateRunState(run.id, RunState.Acknowledged);
    const fetched = await store.getRun(key);
    expect(fetched!.state).toBe(RunState.Acknowledged);
  });

  it('persists and reads back the run context blob', async () => {
    const { run } = await store.findOrCreateRun(key, RunState.Received);
    expect(run.context).toEqual({});
    await store.updateRunContext(run.id, { clarification: { questions: ['Q1', 'Q2'] } });
    const fetched = await store.getRun(key);
    expect(fetched!.context).toEqual({ clarification: { questions: ['Q1', 'Q2'] } });
  });
});

describe('InMemoryStore — test runs', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('records and lists test runs for a run', async () => {
    const { run } = await store.findOrCreateRun(key, RunState.Received);
    const recorded = await store.recordTestRun({
      runId: run.id,
      status: 'failed',
      exitCode: 1,
      durationMs: 1200,
      command: 'npm test',
      failureStage: 'test',
      outputTail: '1 failing',
    });
    expect(recorded.id).toBeGreaterThan(0);

    const list = await store.getTestRuns(run.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'failed', exitCode: 1, command: 'npm test' });
  });
});

describe('InMemoryStore — llm calls & budget', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('records an llm call and atomically decrements the run budget', async () => {
    const { run } = await store.findOrCreateRun(key, RunState.Received);
    await store.setRunBudget(run.id, 1_000_000);

    const { call, budgetRemainingNanoUsd } = await store.recordLlmCall({
      runId: run.id,
      role: 'triage',
      model: 'claude-haiku-4-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costNanoUsd: 350_000,
    });

    expect(call.id).toBeGreaterThan(0);
    expect(budgetRemainingNanoUsd).toBe(1_000_000 - 350_000);
    expect((await store.getRunById(run.id))!.spentNanoUsd).toBe(350_000);
    expect(await store.getLlmCalls(run.id)).toHaveLength(1);
  });
});

describe('InMemoryStore — artifacts', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('records an artifact and reads it back; re-record upserts on (run, kind)', async () => {
    const { run } = await store.findOrCreateRun(key, RunState.Received);
    await store.recordArtifact({
      runId: run.id,
      kind: 'spec',
      path: '.tsukinome/42/spec.md',
      content: '# Spec v1',
      commitSha: 'aaa',
    });
    await store.recordArtifact({
      runId: run.id,
      kind: 'spec',
      path: '.tsukinome/42/spec.md',
      content: '# Spec v2',
      commitSha: 'bbb',
    });

    const artifact = await store.getArtifact(run.id, 'spec');
    expect(artifact!.content).toBe('# Spec v2');
    expect(artifact!.commitSha).toBe('bbb');
    expect(await store.getArtifact(run.id, 'plan')).toBeNull();
  });
});

describe('InMemoryStore — tasks', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('records tasks, lists them ordered by idx, and patches them', async () => {
    const { run } = await store.findOrCreateRun(key, RunState.Received);
    const t1 = await store.recordTask({
      runId: run.id,
      idx: 1,
      title: 'second',
      description: 'b',
      acceptanceCriteria: ['c2'],
    });
    await store.recordTask({
      runId: run.id,
      idx: 0,
      title: 'first',
      description: 'a',
      acceptanceCriteria: ['c1'],
    });

    const tasks = await store.getTasks(run.id);
    expect(tasks.map((t) => t.title)).toEqual(['first', 'second']);
    expect(tasks[0]!.status).toBe('pending');

    await store.updateTask(t1.id, { status: 'done', redObserved: true, greenObserved: true, commitSha: 'abc' });
    const updated = (await store.getTasks(run.id)).find((t) => t.id === t1.id)!;
    expect(updated).toMatchObject({ status: 'done', redObserved: true, greenObserved: true, commitSha: 'abc' });
  });
});

describe('InMemoryStore — processed events', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('marks a delivery once and reports duplicates', async () => {
    expect(await store.tryMarkEventProcessed('d-1')).toBe(true);
    expect(await store.tryMarkEventProcessed('d-1')).toBe(false);
    expect(await store.tryMarkEventProcessed('d-2')).toBe(true);
  });
});
