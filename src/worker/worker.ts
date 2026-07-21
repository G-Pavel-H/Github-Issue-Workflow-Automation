import type { GitHubClient } from '../github/client.js';
import type { Logger } from '../log.js';
import { RunState, type Job, type JobPayload, type Store } from '../store/types.js';
import type { SandboxProvider } from '../sandbox/types.js';
import type { LlmGateway } from '../llm/gateway.js';
import { MissingInstallationKeyError } from '../llm/provider-resolver.js';
import type { CodeIndex } from '../index/types.js';
import type { OpenCodeSandboxFn } from '../sandbox/code-sandbox.js';
import { MAX_JOB_ATTEMPTS, JOB_BACKOFF_BASE_MS, DEFAULT_JOB_LEASE_MS } from './retry.js';
import { sweepStaleRuns, STALE_SWEEP_INTERVAL_MS } from './stale.js';
import {
  handleClarify,
  handleFix,
  handleImplement,
  handleIssueOpened,
  handleProducePlan,
  handleProduceSpec,
  handleResumeClarification,
  handleResumeImplementation,
  handleResumePlanDecision,
  handleReview,
  handleRunTests,
  type CloneFn,
} from './handlers.js';

export interface WorkerDeps {
  store: Store;
  github: GitHubClient;
  sandboxProvider: SandboxProvider;
  gateway: LlmGateway;
  codeIndex: CodeIndex;
  cloneRepo: CloneFn;
  openSandbox: OpenCodeSandboxFn;
  log: Logger;
  /** Optional per-run budget ceiling (nano-USD); defaults to the DB column default if unset. */
  runBudgetNanoUsd?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;

async function dispatch(job: Job, deps: WorkerDeps): Promise<void> {
  switch (job.type) {
    case 'issue_opened':
      await handleIssueOpened(job, deps);
      return;
    case 'produce_spec':
      await handleProduceSpec(job, deps);
      return;
    case 'clarify':
      await handleClarify(job, deps);
      return;
    case 'resume_clarification':
      await handleResumeClarification(job, deps);
      return;
    case 'produce_plan':
      await handleProducePlan(job, deps);
      return;
    case 'resume_plan_decision':
      await handleResumePlanDecision(job, deps);
      return;
    case 'implement':
      await handleImplement(job, deps);
      return;
    case 'resume_implementation':
      await handleResumeImplementation(job, deps);
      return;
    case 'review':
      await handleReview(job, deps);
      return;
    case 'fix':
      await handleFix(job, deps);
      return;
    case 'run_tests':
      await handleRunTests(job, deps);
      return;
    default:
      throw new Error(`Unknown job type: ${String(job.type)}`);
  }
}

/** Every job payload carries the issue coordinates — enough to leave a failure comment. */
function issueCoordsFromPayload(payload: JobPayload): {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
} {
  const { installationId, owner, repo, issueNumber } = payload;
  return { installationId, owner, repo, issueNumber };
}

const DEAD_LETTER_COMMENT =
  '⚠️ **Tsukinome hit an unexpected error and stopped.** I retried automatically but ' +
  "couldn't recover, so I've halted this run to avoid looping. Re-open or re-trigger the " +
  'issue to try again — no partial changes were merged.';

const MISSING_KEY_COMMENT =
  "🔑 **Tsukinome needs this installation's own Anthropic API key.** I stopped before making " +
  'any model calls because no key is on file for this installation. Add your Anthropic API key ' +
  'in the Tsukinome setup page, then re-open or re-trigger this issue to run — no charges were ' +
  'incurred and no changes were made.';

/**
 * A missing per-installation key (Phase 12) is not a transient error — retrying won't
 * conjure a key, so we refuse *terminally*: post clear guidance, fail the run, and mark the
 * job done (no backoff loop). The gateway guarantees this fires before any model spend.
 */
async function refuseForMissingKey(
  job: Job,
  err: MissingInstallationKeyError,
  deps: WorkerDeps,
): Promise<void> {
  const coords = issueCoordsFromPayload(job.payload);
  const run = await deps.store.getRun(coords);
  if (run) await deps.store.updateRunState(run.id, RunState.Failed);
  deps.log.warn(
    { jobId: job.id, type: job.type, installationId: err.installationId },
    'Refused: no Anthropic key on file for installation',
  );
  // Best-effort: a failure to comment must not crash the worker loop.
  try {
    await deps.github.postIssueComment({ ...coords, body: MISSING_KEY_COMMENT });
  } catch (commentErr) {
    const m = commentErr instanceof Error ? commentErr.message : String(commentErr);
    deps.log.error({ jobId: job.id, err: m }, 'Failed to post missing-key comment');
  }
}

/**
 * Claim and process at most one job. Returns true if a job was handled, false if
 * the queue was empty. A throwing handler is retried with backoff (Phase 11); once
 * the attempt cap is reached the job is dead-lettered and a graceful failure comment
 * is posted so a crash never leaves the issue hanging silently.
 */
export async function processNextJob(deps: WorkerDeps): Promise<boolean> {
  const job = await deps.store.claimNextJob(DEFAULT_JOB_LEASE_MS);
  if (!job) return false;

  try {
    await dispatch(job, deps);
    await deps.store.markJobDone(job.id);
  } catch (err) {
    // A missing per-installation key is terminal, not retryable — refuse gracefully once.
    if (err instanceof MissingInstallationKeyError) {
      await refuseForMissingKey(job, err, deps);
      await deps.store.markJobDone(job.id);
      return true;
    }
    const message = err instanceof Error ? err.message : String(err);
    const result = await deps.store.failOrRetryJob(job.id, message, {
      maxAttempts: MAX_JOB_ATTEMPTS,
      backoffMs: JOB_BACKOFF_BASE_MS,
    });
    if (result.status === 'failed') {
      deps.log.error(
        { jobId: job.id, type: job.type, attempts: result.attempts, err: message },
        'Job dead-lettered after exhausting retries',
      );
      // Best-effort: a failure to comment must not crash the worker loop.
      try {
        await deps.github.postIssueComment({
          ...issueCoordsFromPayload(job.payload),
          body: DEAD_LETTER_COMMENT,
        });
      } catch (commentErr) {
        const m = commentErr instanceof Error ? commentErr.message : String(commentErr);
        deps.log.error({ jobId: job.id, err: m }, 'Failed to post dead-letter comment');
      }
    } else {
      deps.log.warn(
        { jobId: job.id, type: job.type, attempts: result.attempts, err: message },
        'Job failed; scheduled for retry',
      );
    }
  }
  return true;
}

export interface WorkerHandle {
  stop(): void;
}

/**
 * Start a polling worker loop. Drains the queue, then waits `intervalMs` before
 * polling again. Returns a handle to stop it. One worker per process for the MVP.
 */
export function startWorker(
  deps: WorkerDeps & { intervalMs?: number; staleSweepIntervalMs?: number },
): WorkerHandle {
  const intervalMs = deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleSweepIntervalMs = deps.staleSweepIntervalMs ?? STALE_SWEEP_INTERVAL_MS;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      // Drain everything currently queued before sleeping.
      while (!stopped && (await processNextJob(deps))) {
        /* keep draining */
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log.error({ err: message }, 'Worker poll iteration errored');
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };

  void tick();

  // Low-frequency sweep of long-parked runs (ping → close). Independent of the poll loop.
  const sweep = (): void => {
    if (stopped) return;
    void sweepStaleRuns(deps).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      deps.log.error({ err: message }, 'Stale-run sweep iteration errored');
    });
  };
  const sweepTimer: NodeJS.Timeout = setInterval(sweep, staleSweepIntervalMs);

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      clearInterval(sweepTimer);
    },
  };
}
