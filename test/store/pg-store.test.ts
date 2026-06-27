import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { PgStore } from '../../src/store/pg-store.js';
import { RunState, type RunKey } from '../../src/store/types.js';

const DATABASE_URL = process.env.DATABASE_URL;

const payload = {
  installationId: 1,
  owner: 'acme',
  repo: 'widgets',
  issueNumber: 42,
  deliveryId: 'd-1',
};

const key: RunKey = {
  installationId: 1,
  owner: 'acme',
  repo: 'widgets',
  issueNumber: 42,
};

// Integration test against a real Postgres. Skipped locally when DATABASE_URL is
// unset; runs in CI against the service container (after `npm run migrate up`).
describe.skipIf(!DATABASE_URL)('PgStore (integration)', () => {
  let pool: Pool;
  let store: PgStore;

  beforeAll(() => {
    pool = createPool(DATABASE_URL!);
    store = new PgStore(pool);
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE jobs, runs, processed_events, test_runs, llm_calls, artifacts RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it('enqueues, claims, and completes a job', async () => {
    const job = await store.enqueueJob({ type: 'issue_opened', payload });
    expect(job.status).toBe('queued');

    const claimed = await store.claimNextJob();
    expect(claimed!.id).toBe(job.id);
    expect(claimed!.status).toBe('in_progress');
    expect(claimed!.payload).toEqual(payload);

    await store.markJobDone(job.id);
    expect(await store.claimNextJob()).toBeNull();
  });

  it('hands distinct jobs to concurrent claimers (FOR UPDATE SKIP LOCKED)', async () => {
    const a = await store.enqueueJob({ type: 'issue_opened', payload });
    const b = await store.enqueueJob({ type: 'issue_opened', payload });

    const [first, second] = await Promise.all([store.claimNextJob(), store.claimNextJob()]);
    const ids = [first!.id, second!.id].sort((x, y) => x - y);
    expect(ids).toEqual([a.id, b.id].sort((x, y) => x - y));
  });

  it('creates a run once per issue (unique key)', async () => {
    const first = await store.findOrCreateRun(key, RunState.Received);
    expect(first.created).toBe(true);

    const second = await store.findOrCreateRun(key, RunState.Received);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);

    await store.updateRunState(first.run.id, RunState.Acknowledged);
    expect((await store.getRun(key))!.state).toBe(RunState.Acknowledged);
  });

  it('persists and reads back the run context blob', async () => {
    const { run } = await store.findOrCreateRun(key, RunState.Received);
    await store.updateRunContext(run.id, { clarification: { questions: ['Q1', 'Q2'] } });
    expect((await store.getRun(key))!.context).toEqual({
      clarification: { questions: ['Q1', 'Q2'] },
    });
  });

  it('dedupes processed events by delivery id', async () => {
    expect(await store.tryMarkEventProcessed('x-1')).toBe(true);
    expect(await store.tryMarkEventProcessed('x-1')).toBe(false);
  });

  it('records an llm call and atomically decrements the run budget', async () => {
    const { run } = await store.findOrCreateRun(key, RunState.Received);
    await store.setRunBudget(run.id, 2_000_000);

    const first = await store.recordLlmCall({
      runId: run.id,
      role: 'review',
      model: 'claude-opus-4-8',
      inputTokens: 100,
      outputTokens: 40,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costNanoUsd: 1_500_000,
    });
    expect(first.budgetRemainingNanoUsd).toBe(500_000);

    const second = await store.recordLlmCall({
      runId: run.id,
      role: 'review',
      model: 'claude-opus-4-8',
      inputTokens: 10,
      outputTokens: 10,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costNanoUsd: 800_000,
    });
    // Overspend goes negative — the gateway refuses the *next* call.
    expect(second.budgetRemainingNanoUsd).toBe(-300_000);
    expect((await store.getRunById(run.id))!.spentNanoUsd).toBe(2_300_000);
    expect(await store.getLlmCalls(run.id)).toHaveLength(2);
  });

  it('upserts an artifact on (run_id, kind)', async () => {
    const { run } = await store.findOrCreateRun(key, RunState.Received);
    await store.recordArtifact({
      runId: run.id,
      kind: 'spec',
      path: '.tsukinome/42/spec.md',
      content: '# v1',
      commitSha: 'aaa',
    });
    await store.recordArtifact({
      runId: run.id,
      kind: 'spec',
      path: '.tsukinome/42/spec.md',
      content: '# v2',
      commitSha: 'bbb',
    });
    const artifact = await store.getArtifact(run.id, 'spec');
    expect(artifact!.content).toBe('# v2');
    expect(artifact!.commitSha).toBe('bbb');
  });

  it('records and lists test runs against a run', async () => {
    const { run } = await store.findOrCreateRun(key, RunState.Received);
    const recorded = await store.recordTestRun({
      runId: run.id,
      status: 'passed',
      exitCode: 0,
      durationMs: 4200,
      command: 'npm test',
      outputTail: 'ok',
    });
    expect(recorded.id).toBeGreaterThan(0);

    const list = await store.getTestRuns(run.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      status: 'passed',
      exitCode: 0,
      durationMs: 4200,
      command: 'npm test',
    });
  });
});
