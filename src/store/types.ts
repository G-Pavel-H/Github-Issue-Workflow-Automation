import type { TestFailureStage, TestRunStatus } from '../sandbox/types.js';

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
export type JobType = 'issue_opened' | 'run_tests' | 'produce_spec';

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

export type JobPayload = IssueOpenedPayload | RunTestsPayload | ProduceSpecPayload;

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
}

/** Default per-run budget: $1.00. Overridable via config / setRunBudget. */
export const DEFAULT_RUN_BUDGET_NANO_USD = 1_000_000_000;

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
  /** Atomically claim the next queued job, marking it in_progress. */
  claimNextJob(): Promise<Job | null>;
  markJobDone(jobId: number): Promise<void>;
  markJobFailed(jobId: number, error: string): Promise<void>;
  findOrCreateRun(key: RunKey, initialState: RunState): Promise<FindOrCreateRunResult>;
  updateRunState(runId: number, state: RunState): Promise<void>;
  getRun(key: RunKey): Promise<Run | null>;
  getRunById(runId: number): Promise<Run | null>;
  setRunBudget(runId: number, budgetNanoUsd: number): Promise<void>;
  /** Returns true if the delivery id was newly recorded, false if already seen. */
  tryMarkEventProcessed(deliveryId: string): Promise<boolean>;
  recordTestRun(input: RecordTestRunInput): Promise<TestRun>;
  getTestRuns(runId: number): Promise<TestRun[]>;
  /** Insert an llm_calls row and atomically add its cost to the run's spend. */
  recordLlmCall(input: RecordLlmCallInput): Promise<RecordLlmCallResult>;
  getLlmCalls(runId: number): Promise<LlmCall[]>;
  /** Upsert an artifact keyed by (runId, kind). */
  recordArtifact(input: RecordArtifactInput): Promise<Artifact>;
  getArtifact(runId: number, kind: ArtifactKind): Promise<Artifact | null>;
}
