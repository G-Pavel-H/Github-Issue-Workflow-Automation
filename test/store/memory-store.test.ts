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
