import {
  DEFAULT_RUN_BUDGET_NANO_USD,
  type Artifact,
  type ArtifactKind,
  type FindOrCreateRunResult,
  type Job,
  type JobPayload,
  type JobType,
  type LlmCall,
  type RecordArtifactInput,
  type RecordLlmCallInput,
  type RecordLlmCallResult,
  type RecordTestRunInput,
  type Run,
  type RunKey,
  type RunState,
  type Store,
  type TestRun,
} from './types.js';

function runKeyOf(key: RunKey): string {
  return `${key.installationId}/${key.owner}/${key.repo}/${key.issueNumber}`;
}

/**
 * In-memory Store for unit tests and local dev without a database. Mirrors the
 * semantics of PgStore: FIFO claim, one run per issue, delivery-id dedupe.
 */
export class InMemoryStore implements Store {
  private jobs = new Map<number, Job>();
  private runs = new Map<string, Run>();
  private processedEvents = new Set<string>();
  private testRuns: TestRun[] = [];
  private llmCalls: LlmCall[] = [];
  private artifacts: Artifact[] = [];
  private nextJobId = 1;
  private nextRunId = 1;
  private nextTestRunId = 1;
  private nextLlmCallId = 1;
  private nextArtifactId = 1;

  async enqueueJob(input: { type: JobType; payload: JobPayload }): Promise<Job> {
    const job: Job = {
      id: this.nextJobId++,
      type: input.type,
      payload: input.payload,
      status: 'queued',
      attempts: 0,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  async claimNextJob(): Promise<Job | null> {
    const next = [...this.jobs.values()]
      .filter((j) => j.status === 'queued')
      .sort((a, b) => a.id - b.id)[0];
    if (!next) return null;
    next.status = 'in_progress';
    next.attempts += 1;
    return { ...next };
  }

  async markJobDone(jobId: number): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job) job.status = 'done';
  }

  async markJobFailed(jobId: number, _error: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job) job.status = 'failed';
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
    };
    this.runs.set(k, run);
    return { run: { ...run }, created: true };
  }

  async updateRunState(runId: number, state: RunState): Promise<void> {
    for (const run of this.runs.values()) {
      if (run.id === runId) {
        run.state = state;
        return;
      }
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
    if (run) run.budgetNanoUsd = budgetNanoUsd;
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
    return { call: { ...call }, budgetRemainingNanoUsd: run.budgetNanoUsd - run.spentNanoUsd };
  }

  async getLlmCalls(runId: number): Promise<LlmCall[]> {
    return this.llmCalls.filter((c) => c.runId === runId).map((c) => ({ ...c }));
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

  /** Test-only inspection helper (not part of the Store contract). */
  getJob(jobId: number): Job | undefined {
    const job = this.jobs.get(jobId);
    return job ? { ...job } : undefined;
  }
}
