import type { GitHubClient } from '../github/client.js';
import type { Logger } from '../log.js';
import { RunState, type Run, type Store } from '../store/types.js';

/** How long a run may sit in a human gate before we post a reminder. */
export const PING_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

/** How long a run may sit in a human gate before we close it as abandoned. */
export const CLOSE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** How often the sweeper runs. Cheap query, so hourly is plenty. */
export const STALE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/** Only runs parked on a human are swept — never ones the worker is actively driving. */
export const STALE_STATES: RunState[] = [
  RunState.AwaitingClarification,
  RunState.AwaitingPlanApproval,
  RunState.AwaitingPrReview,
];

const REMINDER_COMMENT =
  "👋 **Still waiting on you.** This run has been parked here for a few days. Reply when you're " +
  "ready and I'll pick it straight back up — otherwise I'll close it out in a few more days to " +
  'avoid leaving it hanging.';

const CLOSING_COMMENT =
  "🗂️ **Closing this out for now.** I haven't heard back in a week, so I'm releasing this run to " +
  'keep things tidy. Nothing was merged. Re-trigger the issue whenever you want to resume — ' +
  'all the spec/plan artifacts are still on the branch.';

export interface StaleSweepDeps {
  store: Pick<Store, 'getStaleRuns' | 'markRunPinged' | 'updateRunState'>;
  github: Pick<GitHubClient, 'postIssueComment'>;
  log: Logger;
}

function issueCoords(run: Run): {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
} {
  return {
    installationId: run.installationId,
    owner: run.owner,
    repo: run.repo,
    issueNumber: run.issueNumber,
  };
}

/**
 * Ping → park → close for long-parked runs. A run idle past CLOSE_AFTER_MS is closed
 * (`Aborted`); one idle past PING_AFTER_MS but not yet pinged gets a single reminder.
 * `now` is injected so the timing is deterministic in tests. Each run's failure to
 * comment is isolated so one bad run can't abort the sweep.
 */
export async function sweepStaleRuns(deps: StaleSweepDeps, now: number = Date.now()): Promise<void> {
  const { store, github, log } = deps;
  const candidates = await store.getStaleRuns(STALE_STATES, now - PING_AFTER_MS);

  for (const run of candidates) {
    try {
      if (run.updatedAt < now - CLOSE_AFTER_MS) {
        await github.postIssueComment({ ...issueCoords(run), body: CLOSING_COMMENT });
        await store.updateRunState(run.id, RunState.Aborted);
        log.info({ runId: run.id, state: run.state }, 'Closed abandoned run');
      } else if (run.stalePingedAt === null) {
        await github.postIssueComment({ ...issueCoords(run), body: REMINDER_COMMENT });
        await store.markRunPinged(run.id, now);
        log.info({ runId: run.id, state: run.state }, 'Pinged stale run');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ runId: run.id, err: message }, 'Stale-run sweep failed for run');
    }
  }
}
