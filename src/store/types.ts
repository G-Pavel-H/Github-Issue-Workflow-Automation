import type { TestFailureStage, TestRunStatus } from '../sandbox/types.js';
import type { EncryptedSecret } from '../secrets/crypto.js';

/**
 * Run state machine. The full pipeline is enumerated here so transitions are
 * named from the start; Phase 1 only exercises `received` -> `acknowledged`.
 * Later phases own the remaining states.
 */
export const RunState = {
  Received: 'received',
  Acknowledged: 'acknowledged',
  Triaging: 'triaging',
  Specifying: 'specifying',
  Specified: 'specified',
  Unsupported: 'unsupported',
  AwaitingClarification: 'awaiting_clarification',
  Planning: 'planning',
  AwaitingPlanApproval: 'awaiting_plan_approval',
  Implementing: 'implementing',
  AwaitingImplHelp: 'awaiting_impl_help',
  Reviewing: 'reviewing',
  Integrating: 'integrating',
  AwaitingPrReview: 'awaiting_pr_review',
  Done: 'done',
  Failed: 'failed',
  Aborted: 'aborted',
} as const;

// Value + type share a name (declaration merging) so callers use `RunState` for both.
// eslint-disable-next-line no-redeclare
export type RunState = (typeof RunState)[keyof typeof RunState];

export type JobStatus = 'queued' | 'in_progress' | 'done' | 'failed';

/** Job types grow with the pipeline. */
export type JobType =
  | 'issue_opened'
  | 'run_tests'
  | 'produce_spec'
  | 'clarify'
  | 'resume_clarification'
  | 'produce_plan'
  | 'resume_plan_decision'
  | 'implement'
  | 'resume_implementation'
  | 'review'
  | 'fix';

/** Payload for an `issue_opened` job — enough for the worker to act out-of-band. */
export interface IssueOpenedPayload {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
  deliveryId: string;
}

/** Payload for a `run_tests` job (Phase 2 debug-triggered sandbox test run). */
export interface RunTestsPayload {
  installationId: number;
  owner: string;
  repo: string;
  ref: string;
  issueNumber: number;
}

/** Payload for a `produce_spec` job (Phase 4 intake → spec pipeline). */
export interface ProduceSpecPayload {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
}

/** Payload for a `clarify` job (Phase 5 clarification gate). Same shape as produce_spec. */
export interface ClarifyPayload {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
}

/** Payload for a `resume_clarification` job (Phase 5 resume on a human reply). */
export interface ResumeClarificationPayload {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
  /** The human's reply comment body — untrusted DATA fed back to finalize the spec. */
  commentBody: string;
}

/** Payload for a `produce_plan` job (Phase 7 architect + plan gate). */
export interface ProducePlanPayload {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
}

/** Payload for a `resume_plan_decision` job (Phase 7 resume on a human gate reply). */
export interface ResumePlanDecisionPayload {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
  /** The maintainer's gate comment — parsed for /approve, /abort, or a change request. */
  commentBody: string;
}

/** Payload for an `implement` job (Phase 8 TDD execution loop). */
export interface ImplementPayload {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
}

/**
 * Payload for a `resume_implementation` job: a human replied at the "stuck" gate. The comment
 * is either `/abort` or free-text guidance threaded into the retried task's TDD loop.
 */
export interface ResumeImplementationPayload {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
  /** The human's guidance comment — untrusted DATA, used to steer the retry (or /abort). */
  commentBody: string;
}

/** Payload for a `review` job (Phase 9 reviewer + PR). */
export interface ReviewPayload {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
}

/** Payload for a `fix` job (Phase 10 PR review-comment fix loop). */
export interface FixPayload {
  installationId: number;
  owner: string;
  repo: string;
  /** The run's issue, derived from the PR head branch. */
  issueNumber: number;
  prNumber: number;
  /** The maintainer's comment — untrusted DATA, triaged then acted on. */
  commentBody: string;
  /** File the inline comment is attached to (scopes the fix). */
  filePath?: string;
  /** Set for inline comments → reply on that thread. */
  reviewCommentId?: number;
}

export type JobPayload =
  | IssueOpenedPayload
  | RunTestsPayload
  | ProduceSpecPayload
  | ClarifyPayload
  | ResumeClarificationPayload
  | ProducePlanPayload
  | ResumePlanDecisionPayload
  | ImplementPayload
  | ResumeImplementationPayload
  | ReviewPayload
  | FixPayload;

export interface Job {
  id: number;
  type: JobType;
  payload: JobPayload;
  status: JobStatus;
  attempts: number;
}

export interface Run {
  id: number;
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
  state: RunState;
  context: Record<string, unknown>;
  /** Per-run budget ceiling in nano-USD (1e-9 USD). */
  budgetNanoUsd: number;
  /** Cumulative model spend in nano-USD. */
  spentNanoUsd: number;
  /** Last state/context change (epoch ms). Drives stale-run detection. */
  updatedAt: number;
  /** When the run was last pinged about inactivity (epoch ms), or null. */
  stalePingedAt: number | null;
}

/** Default per-run budget: $1.00. Overridable via config / setRunBudget. */
export const DEFAULT_RUN_BUDGET_NANO_USD = 1_000_000_000;

/** Outcome of failing a job: either re-queued for a backoff retry, or dead-lettered. */
export interface FailOrRetryResult {
  status: 'queued' | 'failed';
  attempts: number;
}

/** Aggregate model spend across runs — the measured average cost/issue. */
export interface CostMetrics {
  runCount: number;
  totalNanoUsd: number;
  avgCostNanoUsd: number;
}

/** Identifies the one run that belongs to a given issue. */
export interface RunKey {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
}

export interface FindOrCreateRunResult {
  run: Run;
  /** True when this call inserted the run; false when it already existed. */
  created: boolean;
}

export interface RecordTestRunInput {
  runId: number;
  status: TestRunStatus;
  exitCode: number | null;
  durationMs: number;
  command: string;
  failureStage?: TestFailureStage;
  outputTail: string;
}

export interface TestRun extends RecordTestRunInput {
  id: number;
}

export interface RecordLlmCallInput {
  runId: number;
  role: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costNanoUsd: number;
}

export interface LlmCall extends RecordLlmCallInput {
  id: number;
}

export interface RecordLlmCallResult {
  call: LlmCall;
  /** Budget remaining after this call (may be negative on overspend). */
  budgetRemainingNanoUsd: number;
}

/** Phase 8 decomposed task lifecycle. */
export type TaskStatus = 'pending' | 'done' | 'escalated';

export interface RecordTaskInput {
  runId: number;
  /** Order within the run (0-based). */
  idx: number;
  title: string;
  description: string;
  acceptanceCriteria: string[];
}

export interface Task extends RecordTaskInput {
  id: number;
  status: TaskStatus;
  redObserved: boolean;
  greenObserved: boolean;
  commitSha: string | null;
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  redObserved?: boolean;
  greenObserved?: boolean;
  commitSha?: string | null;
}

/** Encrypted per-installation Anthropic key at rest (Phase 12), plus its installation key. */
export interface UpsertInstallationCredentialInput extends EncryptedSecret {
  installationId: number;
}

/** A committed artifact (e.g. the spec) — the source of truth, re-read by later phases. */
export type ArtifactKind = 'spec' | 'plan';

export interface RecordArtifactInput {
  runId: number;
  kind: ArtifactKind;
  path: string;
  content: string;
  commitSha?: string | null;
}

export interface Artifact extends RecordArtifactInput {
  id: number;
}

/**
 * Persistence boundary for the queue, runs, and webhook dedupe. Two
 * implementations: PgStore (production) and InMemoryStore (tests / no-DB dev).
 */
export interface Store {
  enqueueJob(input: { type: JobType; payload: JobPayload }): Promise<Job>;
  /**
   * Atomically claim the next runnable job: a queued job whose `available_at` is due, or an
   * `in_progress` job whose worker died (its lease `locked_at` is older than `leaseMs`). Marks
   * it in_progress and bumps `attempts`.
   */
  claimNextJob(leaseMs?: number): Promise<Job | null>;
  markJobDone(jobId: number): Promise<void>;
  markJobFailed(jobId: number, error: string): Promise<void>;
  /** Re-queue the job with a backoff delay if under the attempt cap, else dead-letter it. */
  failOrRetryJob(
    jobId: number,
    error: string,
    opts: { maxAttempts: number; backoffMs: number },
  ): Promise<FailOrRetryResult>;
  findOrCreateRun(key: RunKey, initialState: RunState): Promise<FindOrCreateRunResult>;
  updateRunState(runId: number, state: RunState): Promise<void>;
  /** Persist the run's context blob (suspend/resume state). */
  updateRunContext(runId: number, context: Record<string, unknown>): Promise<void>;
  getRun(key: RunKey): Promise<Run | null>;
  getRunById(runId: number): Promise<Run | null>;
  setRunBudget(runId: number, budgetNanoUsd: number): Promise<void>;
  /** Parked runs in `states` not touched since `updatedBefore` (epoch ms) — stale candidates. */
  getStaleRuns(states: RunState[], updatedBefore: number): Promise<Run[]>;
  /** Record an inactivity ping without bumping `updatedAt` (keeps the staleness clock running). */
  markRunPinged(runId: number, pingedAt: number): Promise<void>;
  /** Returns true if the delivery id was newly recorded, false if already seen. */
  tryMarkEventProcessed(deliveryId: string): Promise<boolean>;
  recordTestRun(input: RecordTestRunInput): Promise<TestRun>;
  getTestRuns(runId: number): Promise<TestRun[]>;
  /** Insert an llm_calls row and atomically add its cost to the run's spend. */
  recordLlmCall(input: RecordLlmCallInput): Promise<RecordLlmCallResult>;
  getLlmCalls(runId: number): Promise<LlmCall[]>;
  /** Aggregate spend across all runs (measured average cost/issue). */
  getCostMetrics(): Promise<CostMetrics>;
  /** Upsert an artifact keyed by (runId, kind). */
  recordArtifact(input: RecordArtifactInput): Promise<Artifact>;
  getArtifact(runId: number, kind: ArtifactKind): Promise<Artifact | null>;
  /** Insert a decomposed task. */
  recordTask(input: RecordTaskInput): Promise<Task>;
  /** All tasks for a run, ordered by idx. */
  getTasks(runId: number): Promise<Task[]>;
  /** Patch a task's status / TDD observations / commit. */
  updateTask(taskId: number, patch: UpdateTaskInput): Promise<void>;
  /** Insert-or-replace an installation's encrypted Anthropic key (rotation). */
  upsertInstallationCredential(input: UpsertInstallationCredentialInput): Promise<void>;
  /** Fetch an installation's encrypted key at rest, or null if none is on file. */
  getInstallationCredential(installationId: number): Promise<EncryptedSecret | null>;
  /** Purge an installation's stored key (on uninstall). No-op if absent. */
  deleteInstallationCredential(installationId: number): Promise<void>;
}
