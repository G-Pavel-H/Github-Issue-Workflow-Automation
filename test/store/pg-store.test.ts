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
      'TRUNCATE jobs, runs, processed_events, test_runs, llm_calls, artifacts, tasks, installation_credentials RESTART IDENTITY CASCADE',
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

  it('upserts, reads, and deletes an installation credential (bytea round-trip)', async () => {
    const ciphertext = Buffer.from([1, 2, 3, 4, 5]);
    const iv = Buffer.from([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    const authTag = Buffer.from([100, 101, 102, 103]);

    expect(await store.getInstallationCredential(7)).toBeNull();

    await store.upsertInstallationCredential({ installationId: 7, ciphertext, iv, authTag });
    const got = await store.getInstallationCredential(7);
    expect(got!.ciphertext.equals(ciphertext)).toBe(true);
    expect(got!.iv.equals(iv)).toBe(true);
    expect(got!.authTag.equals(authTag)).toBe(true);

    // Rotation: upsert replaces in place, keyed by installation_id.
    const newCipher = Buffer.from([9, 9, 9]);
    await store.upsertInstallationCredential({
      installationId: 7,
      ciphertext: newCipher,
      iv,
      authTag,
    });
    expect((await store.getInstallationCredential(7))!.ciphertext.equals(newCipher)).toBe(true);

    // Purge on uninstall.
    await store.deleteInstallationCredential(7);
    expect(await store.getInstallationCredential(7)).toBeNull();
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

  it('records, lists (ordered), and updates tasks', async () => {
    const { run } = await store.findOrCreateRun(key, RunState.Received);
    const t = await store.recordTask({
      runId: run.id,
      idx: 0,
      title: 'first',
      description: 'do the thing',
      acceptanceCriteria: ['AC1', 'AC2'],
    });
    expect(t.status).toBe('pending');
    expect(t.acceptanceCriteria).toEqual(['AC1', 'AC2']);

    await store.updateTask(t.id, { status: 'done', redObserved: true, greenObserved: true, commitSha: 'deadbeef' });
    const [reloaded] = await store.getTasks(run.id);
    expect(reloaded).toMatchObject({
      status: 'done',
      redObserved: true,
      greenObserved: true,
      commitSha: 'deadbeef',
    });
  });

  it('re-queues a failed job with a future backoff, then dead-letters at the cap', async () => {
    const job = await store.enqueueJob({ type: 'issue_opened', payload });
    await store.claimNextJob(); // attempts -> 1

    const retry = await store.failOrRetryJob(job.id, 'boom', { maxAttempts: 2, backoffMs: 60_000 });
    expect(retry).toEqual({ status: 'queued', attempts: 1 });
    // Backed off into the future — not claimable right now.
    expect(await store.claimNextJob()).toBeNull();

    // Force it due, claim again (attempts -> 2), then exceed the cap.
    await pool.query(`UPDATE jobs SET available_at = now() - interval '1 second' WHERE id = $1`, [job.id]);
    await store.claimNextJob();
    const dead = await store.failOrRetryJob(job.id, 'boom again', { maxAttempts: 2, backoffMs: 60_000 });
    expect(dead.status).toBe('failed');
  });

  it('reclaims an in_progress job whose lease has expired', async () => {
    const job = await store.enqueueJob({ type: 'issue_opened', payload });
    await store.claimNextJob(); // now in_progress, locked_at = now()

    // A live worker with a 0ms lease treats any locked job as abandoned.
    const reclaimed = await store.claimNextJob(0);
    expect(reclaimed!.id).toBe(job.id);
    expect(reclaimed!.attempts).toBe(2);
  });

  it('lists stale parked runs and records pings without resetting the clock', async () => {
    const { run } = await store.findOrCreateRun(key, RunState.AwaitingPlanApproval);
    const cutoff = Date.now() + 60_000; // everything created before now+1min

    const stale = await store.getStaleRuns([RunState.AwaitingPlanApproval], cutoff);
    expect(stale.map((r) => r.id)).toEqual([run.id]);
    expect(stale[0]!.stalePingedAt).toBeNull();

    const pingedAt = Date.now();
    await store.markRunPinged(run.id, pingedAt);
    const after = await store.getStaleRuns([RunState.AwaitingPlanApproval], cutoff);
    expect(after[0]!.stalePingedAt).not.toBeNull();
    // Different state is not returned.
    expect(await store.getStaleRuns([RunState.AwaitingPrReview], cutoff)).toHaveLength(0);
  });

  it('aggregates measured cost across runs', async () => {
    const a = await store.findOrCreateRun(key, RunState.Received);
    const b = await store.findOrCreateRun({ ...key, issueNumber: 43 }, RunState.Received);
    await store.recordLlmCall({
      runId: a.run.id, role: 'triage', model: 'm',
      inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costNanoUsd: 300,
    });
    await store.recordLlmCall({
      runId: b.run.id, role: 'triage', model: 'm',
      inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costNanoUsd: 100,
    });
    expect(await store.getCostMetrics()).toEqual({ runCount: 2, totalNanoUsd: 400, avgCostNanoUsd: 200 });
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
