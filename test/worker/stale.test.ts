import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStore } from '../../src/store/memory-store.js';
import { RunState, type RunKey } from '../../src/store/types.js';
import { sweepStaleRuns, PING_AFTER_MS, CLOSE_AFTER_MS } from '../../src/worker/stale.js';
import { fakeGitHub, silentLog } from '../helpers.js';

const key: RunKey = { installationId: 1, owner: 'acme', repo: 'widgets', issueNumber: 42 };

describe('sweepStaleRuns', () => {
  let clock: number;
  let store: InMemoryStore;
  beforeEach(() => {
    clock = 1_000_000_000;
    store = new InMemoryStore({ now: () => clock });
  });

  it('pings a run idle past the ping threshold exactly once, without closing it', async () => {
    const github = fakeGitHub();
    const { run } = await store.findOrCreateRun(key, RunState.AwaitingPlanApproval);

    clock += PING_AFTER_MS + 1;
    await sweepStaleRuns({ store, github, log: silentLog }, clock);
    expect(github.postIssueComment).toHaveBeenCalledTimes(1);
    expect((await store.getRunById(run.id))!.state).toBe(RunState.AwaitingPlanApproval);

    // A second sweep before the close threshold does not re-ping (stalePingedAt set).
    clock += 1000;
    await sweepStaleRuns({ store, github, log: silentLog }, clock);
    expect(github.postIssueComment).toHaveBeenCalledTimes(1);
  });

  it('closes a run idle past the close threshold as Aborted', async () => {
    const github = fakeGitHub();
    const { run } = await store.findOrCreateRun(key, RunState.AwaitingClarification);

    clock += CLOSE_AFTER_MS + 1;
    await sweepStaleRuns({ store, github, log: silentLog }, clock);
    expect(github.postIssueComment).toHaveBeenCalledTimes(1);
    expect((await store.getRunById(run.id))!.state).toBe(RunState.Aborted);
  });

  it('pinging does not reset the staleness clock — a later sweep still closes it', async () => {
    const github = fakeGitHub();
    const { run } = await store.findOrCreateRun(key, RunState.AwaitingPrReview);

    clock += PING_AFTER_MS + 1;
    await sweepStaleRuns({ store, github, log: silentLog }, clock); // ping
    expect((await store.getRunById(run.id))!.state).toBe(RunState.AwaitingPrReview);

    clock += CLOSE_AFTER_MS; // now well past close threshold from original updatedAt
    await sweepStaleRuns({ store, github, log: silentLog }, clock); // close
    expect((await store.getRunById(run.id))!.state).toBe(RunState.Aborted);
    expect(github.postIssueComment).toHaveBeenCalledTimes(2);
  });

  it('leaves fresh runs and non-parked states untouched', async () => {
    const github = fakeGitHub();
    // An OLD run in a non-parked state — must be ignored despite its age.
    const { run: implementing } = await store.findOrCreateRun(key, RunState.Implementing);
    clock += CLOSE_AFTER_MS + 1;
    // A FRESH parked run created just now — under the ping threshold.
    const { run: fresh } = await store.findOrCreateRun(
      { ...key, issueNumber: 43 },
      RunState.AwaitingPlanApproval,
    );

    await sweepStaleRuns({ store, github, log: silentLog }, clock);
    expect(github.postIssueComment).not.toHaveBeenCalled();
    expect((await store.getRunById(implementing.id))!.state).toBe(RunState.Implementing);
    expect((await store.getRunById(fresh.id))!.state).toBe(RunState.AwaitingPlanApproval);
  });
});
