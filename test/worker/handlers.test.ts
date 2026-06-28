import { describe, it, expect, beforeEach } from 'vitest';
import { handleIssueOpened } from '../../src/worker/handlers.js';
import { InMemoryStore } from '../../src/store/memory-store.js';
import { RunState, type Job } from '../../src/store/types.js';
import { fakeGitHub, silentLog } from '../helpers.js';

const job: Job = {
  id: 1,
  type: 'issue_opened',
  status: 'in_progress',
  attempts: 1,
  payload: {
    installationId: 7,
    owner: 'acme',
    repo: 'widgets',
    issueNumber: 42,
    deliveryId: 'd-1',
  },
};

describe('handleIssueOpened', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('posts a single acknowledgement comment and advances the run to acknowledged', async () => {
    const github = fakeGitHub();
    await handleIssueOpened(job, { store, github, log: silentLog });

    expect(github.postIssueComment).toHaveBeenCalledTimes(1);
    expect(github.calls[0]).toMatchObject({
      installationId: 7,
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 42,
    });
    expect(github.calls[0]!.body.length).toBeGreaterThan(0);

    const run = await store.getRun(job.payload);
    expect(run!.state).toBe(RunState.Acknowledged);
  });

  it('applies the configured per-run budget when the run is created', async () => {
    const github = fakeGitHub();
    await handleIssueOpened(job, { store, github, log: silentLog, runBudgetNanoUsd: 2_500_000_000 });

    const run = await store.getRun(job.payload);
    expect(run!.budgetNanoUsd).toBe(2_500_000_000);
  });

  it('leaves the default budget when no override is configured', async () => {
    const github = fakeGitHub();
    await handleIssueOpened(job, { store, github, log: silentLog });

    const run = await store.getRun(job.payload);
    expect(run!.budgetNanoUsd).toBe(1_000_000_000); // DEFAULT_RUN_BUDGET_NANO_USD
  });

  it('enqueues a produce_spec job after acknowledging', async () => {
    const github = fakeGitHub();
    await handleIssueOpened(job, { store, github, log: silentLog });

    const next = await store.claimNextJob();
    expect(next!.type).toBe('produce_spec');
    expect(next!.payload).toMatchObject({
      installationId: 7,
      owner: 'acme',
      repo: 'widgets',
      issueNumber: 42,
    });
  });

  it('does not post a second comment when the same job is reprocessed (idempotency)', async () => {
    const github = fakeGitHub();
    await handleIssueOpened(job, { store, github, log: silentLog });
    await handleIssueOpened(job, { store, github, log: silentLog });

    expect(github.postIssueComment).toHaveBeenCalledTimes(1);
    const run = await store.getRun(job.payload);
    expect(run!.state).toBe(RunState.Acknowledged);
  });
});
