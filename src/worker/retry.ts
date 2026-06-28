/**
 * Job retry policy (Phase 11). A handler that throws is retried with exponential
 * backoff up to a cap, after which the job is dead-lettered. These constants are
 * the worker's defaults; `failOrRetryJob` takes them as parameters so they're
 * easy to override in tests.
 */

/** Max attempts (claims) before a job is dead-lettered. */
export const MAX_JOB_ATTEMPTS = 3;

/** Base backoff between retries; doubles each attempt up to MAX_BACKOFF_MS. */
export const JOB_BACKOFF_BASE_MS = 30_000;

/** Backoff ceiling — no retry waits longer than this regardless of attempt count. */
export const MAX_BACKOFF_MS = 5 * 60_000;

/** How long a claimed (`in_progress`) job may hold its lease before a live worker may reclaim it. */
export const DEFAULT_JOB_LEASE_MS = 5 * 60_000;

/**
 * Exponential backoff for the Nth failed attempt: `base * 2^(attempts-1)`, capped
 * at MAX_BACKOFF_MS. Monotonic non-decreasing in `attempts`. `attempts` is the
 * post-claim count (≥1), so the first retry waits exactly `base`.
 */
export function computeBackoffMs(attempts: number, baseMs: number = JOB_BACKOFF_BASE_MS): number {
  const exp = Math.max(0, attempts - 1);
  const delay = baseMs * 2 ** exp;
  return Math.min(delay, MAX_BACKOFF_MS);
}
