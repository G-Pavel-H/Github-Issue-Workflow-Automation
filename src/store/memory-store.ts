import { DEFAULT_JOB_LEASE_MS, computeBackoffMs } from '../worker/retry.js';
import {
  DEFAULT_RUN_BUDGET_NANO_USD,
  type Artifact,
  type ArtifactKind,
  type CostMetrics,
  type FailOrRetryResult,
  type FindOrCreateRunResult,
  type Job,
  type JobPayload,
  type JobType,
  type LlmCall,
  type RecordArtifactInput,
  type RecordLlmCallInput,
  type RecordLlmCallResult,
  type RecordTaskInput,
  type RecordTestRunInput,
  type Run,
  type RunKey,
  type RunState,
  type Store,
  type Task,
  type TestRun,
  type UpdateTaskInput,
  type UpsertInstallationCredentialInput,
} from './types.js';
import type { EncryptedSecret } from '../secrets/crypto.js';

function runKeyOf(key: RunKey): string {
  return `${key.installationId}/${key.owner}/${key.repo}/${key.issueNumber}`;
}

/** Internal job record — carries the scheduling metadata not exposed on the public `Job`. */
interface StoredJob extends Job {
  availableAt: number;
  lockedAt: number | null;
}

function publicJob(job: StoredJob): Job {
  return { id: job.id, type: job.type, payload: job.payload, status: job.status, attempts: job.attempts };
}

/**
 * In-memory Store for unit tests and local dev without a database. Mirrors the
 * semantics of PgStore: due/lease-aware claim, one run per issue, delivery-id dedupe.
 * `now` is injectable so retry/backoff and stale-run timing are deterministic in tests.
 */
export class InMemoryStore implements Store {
  private jobs = new Map<number, StoredJob>();
  private runs = new Map<string, Run>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }
  private processedEvents = new Set<string>();
  private testRuns: TestRun[] = [];
  private llmCalls: LlmCall[] = [];
  private artifacts: Artifact[] = [];
  private tasks: Task[] = [];
  private credentials = new Map<number, EncryptedSecret>();
  private nextJobId = 1;
  private nextRunId = 1;
  private nextTestRunId = 1;
  private nextLlmCallId = 1;
  private nextArtifactId = 1;
  private nextTaskId = 1;

  async enqueueJob(input: { type: JobType; payload: JobPayload }): Promise<Job> {
    const job: StoredJob = {
      id: this.nextJobId++,
      type: input.type,
      payload: input.payload,
      status: 'queued',
      attempts: 0,
      availableAt: this.now(),
      lockedAt: null,
    };
    this.jobs.set(job.id, job);
    return publicJob(job);
  }

  async claimNextJob(leaseMs: number = DEFAULT_JOB_LEASE_MS): Promise<Job | null> {
    const now = this.now();
    const next = [...this.jobs.values()]
      .filter(
        (j) =>
          (j.status === 'queued' && j.availableAt <= now) ||
          (j.status === 'in_progress' && j.lockedAt !== null && j.lockedAt < now - leaseMs),
      )
      .sort((a, b) => a.id - b.id)[0];
    if (!next) return null;
    next.status = 'in_progress';
    next.attempts += 1;
    next.lockedAt = now;
    return publicJob(next);
  }

  async markJobDone(jobId: number): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job) job.status = 'done';
  }

  async markJobFailed(jobId: number, _error: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job) job.status = 'failed';
  }

  async failOrRetryJob(
    jobId: number,
    _error: string,
    opts: { maxAttempts: number; backoffMs: number },
  ): Promise<FailOrRetryResult> {
    const job = this.jobs.get(jobId);
    if (!job) return { status: 'failed', attempts: 0 };
    if (job.attempts >= opts.maxAttempts) {
      job.status = 'failed';
      return { status: 'failed', attempts: job.attempts };
    }
    job.status = 'queued';
    job.lockedAt = null;
    job.availableAt = this.now() + computeBackoffMs(job.attempts, opts.backoffMs);
    return { status: 'queued', attempts: job.attempts };
  }

  async findOrCreateRun(key: RunKey, initialState: RunState): Promise<FindOrCreateRunResult> {
    const k = runKeyOf(key);
    const existing = this.runs.get(k);
    if (existing) return { run: { ...existing }, created: false };

    const run: Run = {
      id: this.nextRunId++,
      installationId: key.installationId,
      owner: key.owner,
      repo: key.repo,
      issueNumber: key.issueNumber,
      state: initialState,
      context: {},
      budgetNanoUsd: DEFAULT_RUN_BUDGET_NANO_USD,
      spentNanoUsd: 0,
      updatedAt: this.now(),
      stalePingedAt: null,
    };
    this.runs.set(k, run);
    return { run: { ...run }, created: true };
  }

  async updateRunState(runId: number, state: RunState): Promise<void> {
    const run = this.findRunById(runId);
    if (run) {
      run.state = state;
      run.updatedAt = this.now();
    }
  }

  async updateRunContext(runId: number, context: Record<string, unknown>): Promise<void> {
    const run = this.findRunById(runId);
    if (run) {
      run.context = { ...context };
      run.updatedAt = this.now();
    }
  }

  async getRun(key: RunKey): Promise<Run | null> {
    const run = this.runs.get(runKeyOf(key));
    return run ? { ...run } : null;
  }

  private findRunById(runId: number): Run | undefined {
    for (const run of this.runs.values()) if (run.id === runId) return run;
    return undefined;
  }

  async getRunById(runId: number): Promise<Run | null> {
    const run = this.findRunById(runId);
    return run ? { ...run } : null;
  }

  async setRunBudget(runId: number, budgetNanoUsd: number): Promise<void> {
    const run = this.findRunById(runId);
    if (run) {
      run.budgetNanoUsd = budgetNanoUsd;
      run.updatedAt = this.now();
    }
  }

  async getStaleRuns(states: RunState[], updatedBefore: number): Promise<Run[]> {
    return [...this.runs.values()]
      .filter((r) => states.includes(r.state) && r.updatedAt < updatedBefore)
      .sort((a, b) => a.id - b.id)
      .map((r) => ({ ...r }));
  }

  async markRunPinged(runId: number, pingedAt: number): Promise<void> {
    // Deliberately does NOT touch updatedAt — the staleness clock keeps running.
    const run = this.findRunById(runId);
    if (run) run.stalePingedAt = pingedAt;
  }

  async tryMarkEventProcessed(deliveryId: string): Promise<boolean> {
    if (this.processedEvents.has(deliveryId)) return false;
    this.processedEvents.add(deliveryId);
    return true;
  }

  async recordTestRun(input: RecordTestRunInput): Promise<TestRun> {
    const testRun: TestRun = { id: this.nextTestRunId++, ...input };
    this.testRuns.push(testRun);
    return { ...testRun };
  }

  async getTestRuns(runId: number): Promise<TestRun[]> {
    return this.testRuns.filter((t) => t.runId === runId).map((t) => ({ ...t }));
  }

  async recordLlmCall(input: RecordLlmCallInput): Promise<RecordLlmCallResult> {
    const call: LlmCall = { id: this.nextLlmCallId++, ...input };
    this.llmCalls.push(call);
    const run = this.findRunById(input.runId);
    if (!run) throw new Error(`Run ${input.runId} not found`);
    run.spentNanoUsd += input.costNanoUsd;
    run.updatedAt = this.now();
    return { call: { ...call }, budgetRemainingNanoUsd: run.budgetNanoUsd - run.spentNanoUsd };
  }

  async getLlmCalls(runId: number): Promise<LlmCall[]> {
    return this.llmCalls.filter((c) => c.runId === runId).map((c) => ({ ...c }));
  }

  async getCostMetrics(): Promise<CostMetrics> {
    const runs = [...this.runs.values()];
    const runCount = runs.length;
    const totalNanoUsd = runs.reduce((sum, r) => sum + r.spentNanoUsd, 0);
    return {
      runCount,
      totalNanoUsd,
      avgCostNanoUsd: runCount === 0 ? 0 : Math.round(totalNanoUsd / runCount),
    };
  }

  async recordArtifact(input: RecordArtifactInput): Promise<Artifact> {
    const existing = this.artifacts.find((a) => a.runId === input.runId && a.kind === input.kind);
    if (existing) {
      Object.assign(existing, {
        path: input.path,
        content: input.content,
        commitSha: input.commitSha ?? null,
      });
      return { ...existing };
    }
    const artifact: Artifact = { id: this.nextArtifactId++, ...input, commitSha: input.commitSha ?? null };
    this.artifacts.push(artifact);
    return { ...artifact };
  }

  async getArtifact(runId: number, kind: ArtifactKind): Promise<Artifact | null> {
    const artifact = this.artifacts.find((a) => a.runId === runId && a.kind === kind);
    return artifact ? { ...artifact } : null;
  }

  async recordTask(input: RecordTaskInput): Promise<Task> {
    const task: Task = {
      id: this.nextTaskId++,
      ...input,
      acceptanceCriteria: [...input.acceptanceCriteria],
      status: 'pending',
      redObserved: false,
      greenObserved: false,
      commitSha: null,
    };
    this.tasks.push(task);
    return { ...task };
  }

  async getTasks(runId: number): Promise<Task[]> {
    return this.tasks
      .filter((t) => t.runId === runId)
      .sort((a, b) => a.idx - b.idx)
      .map((t) => ({ ...t }));
  }

  async updateTask(taskId: number, patch: UpdateTaskInput): Promise<void> {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (patch.status !== undefined) task.status = patch.status;
    if (patch.redObserved !== undefined) task.redObserved = patch.redObserved;
    if (patch.greenObserved !== undefined) task.greenObserved = patch.greenObserved;
    if (patch.commitSha !== undefined) task.commitSha = patch.commitSha;
  }

  async upsertInstallationCredential(input: UpsertInstallationCredentialInput): Promise<void> {
    // Copy the buffers so later mutations by the caller can't corrupt stored state.
    this.credentials.set(input.installationId, {
      ciphertext: Buffer.from(input.ciphertext),
      iv: Buffer.from(input.iv),
      authTag: Buffer.from(input.authTag),
    });
  }

  async getInstallationCredential(installationId: number): Promise<EncryptedSecret | null> {
    const secret = this.credentials.get(installationId);
    if (!secret) return null;
    return {
      ciphertext: Buffer.from(secret.ciphertext),
      iv: Buffer.from(secret.iv),
      authTag: Buffer.from(secret.authTag),
    };
  }

  async deleteInstallationCredential(installationId: number): Promise<void> {
    this.credentials.delete(installationId);
  }

  /** Test-only inspection helper (not part of the Store contract). */
  getJob(jobId: number): Job | undefined {
    const job = this.jobs.get(jobId);
    return job ? publicJob(job) : undefined;
  }
}
