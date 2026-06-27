import type { GitHubClient } from '../github/client.js';
import type { Logger } from '../log.js';
import type { Job, Store } from '../store/types.js';
import type { SandboxProvider } from '../sandbox/types.js';
import type { LlmGateway } from '../llm/gateway.js';
import { handleIssueOpened, handleProduceSpec, handleRunTests } from './handlers.js';

export interface WorkerDeps {
  store: Store;
  github: GitHubClient;
  sandboxProvider: SandboxProvider;
  gateway: LlmGateway;
  log: Logger;
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
    case 'run_tests':
      await handleRunTests(job, deps);
      return;
    default:
      throw new Error(`Unknown job type: ${String(job.type)}`);
  }
}

/**
 * Claim and process at most one job. Returns true if a job was handled (success
 * or failure), false if the queue was empty. A throwing handler marks the job
 * failed rather than crashing the loop. (Retries/backoff are Phase 11.)
 */
export async function processNextJob(deps: WorkerDeps): Promise<boolean> {
  const job = await deps.store.claimNextJob();
  if (!job) return false;

  try {
    await dispatch(job, deps);
    await deps.store.markJobDone(job.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.error({ jobId: job.id, type: job.type, err: message }, 'Job failed');
    await deps.store.markJobFailed(job.id, message);
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
export function startWorker(deps: WorkerDeps & { intervalMs?: number }): WorkerHandle {
  const intervalMs = deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
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

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
