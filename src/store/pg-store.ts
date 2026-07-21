import type { Pool, QueryResultRow } from 'pg';
import type {
  Artifact,
  ArtifactKind,
  CostMetrics,
  FailOrRetryResult,
  FindOrCreateRunResult,
  Job,
  JobPayload,
  JobType,
  LlmCall,
  RecordArtifactInput,
  RecordLlmCallInput,
  RecordLlmCallResult,
  RecordTaskInput,
  RecordTestRunInput,
  Run,
  RunKey,
  RunState,
  Store,
  Task,
  TestRun,
  UpdateTaskInput,
  UpsertInstallationCredentialInput,
} from './types.js';
import type { EncryptedSecret } from '../secrets/crypto.js';
import { DEFAULT_JOB_LEASE_MS, computeBackoffMs } from '../worker/retry.js';
import type { TestFailureStage, TestRunStatus } from '../sandbox/types.js';

function mapJob(row: QueryResultRow): Job {
  return {
    id: Number(row.id),
    type: row.type as JobType,
    payload: row.payload as JobPayload,
    status: row.status,
    attempts: Number(row.attempts),
  };
}

function mapTestRun(row: QueryResultRow): TestRun {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    status: row.status as TestRunStatus,
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    durationMs: Number(row.duration_ms),
    command: row.command,
    failureStage: (row.failure_stage as TestFailureStage | null) ?? undefined,
    outputTail: row.output_tail ?? '',
  };
}

function mapTask(row: QueryResultRow): Task {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    idx: Number(row.idx),
    title: row.title,
    description: row.description,
    acceptanceCriteria: (row.acceptance_criteria as string[]) ?? [],
    status: row.status,
    redObserved: row.red_observed === true,
    greenObserved: row.green_observed === true,
    commitSha: row.commit_sha ?? null,
  };
}

function mapArtifact(row: QueryResultRow): Artifact {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    kind: row.kind as ArtifactKind,
    path: row.path,
    content: row.content,
    commitSha: row.commit_sha ?? null,
  };
}

function mapRun(row: QueryResultRow): Run {
  return {
    id: Number(row.id),
    installationId: Number(row.installation_id),
    owner: row.owner,
    repo: row.repo,
    issueNumber: Number(row.issue_number),
    state: row.state as RunState,
    context: (row.context as Record<string, unknown>) ?? {},
    budgetNanoUsd: Number(row.budget_nano_usd),
    spentNanoUsd: Number(row.spent_nano_usd),
    updatedAt: new Date(row.updated_at as string).getTime(),
    stalePingedAt: row.stale_pinged_at === null ? null : new Date(row.stale_pinged_at as string).getTime(),
  };
}

/** Columns selected for every Run read — keep in sync with mapRun. */
const RUN_COLUMNS = `id, installation_id, owner, repo, issue_number, state, context,
              budget_nano_usd, spent_nano_usd, updated_at, stale_pinged_at`;

function mapLlmCall(row: QueryResultRow): LlmCall {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    role: row.role,
    model: row.model,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheCreationTokens: Number(row.cache_creation_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    costNanoUsd: Number(row.cost_nano_usd),
  };
}

/** Postgres-backed Store. Schema lives in migrations/002_phase1_core.sql. */
export class PgStore implements Store {
  constructor(private readonly pool: Pool) {}

  async enqueueJob(input: { type: JobType; payload: JobPayload }): Promise<Job> {
    const { rows } = await this.pool.query(
      `INSERT INTO jobs (type, payload) VALUES ($1, $2)
       RETURNING id, type, payload, status, attempts`,
      [input.type, JSON.stringify(input.payload)],
    );
    return mapJob(rows[0]!);
  }

  async claimNextJob(leaseMs: number = DEFAULT_JOB_LEASE_MS): Promise<Job | null> {
    // Claim a due `queued` job, OR reclaim an `in_progress` job whose worker died
    // (its lease — `locked_at` — is older than leaseMs). One round trip, race-safe.
    const { rows } = await this.pool.query(
      `UPDATE jobs
         SET status = 'in_progress', locked_at = now(), attempts = attempts + 1, updated_at = now()
       WHERE id = (
         SELECT id FROM jobs
          WHERE (status = 'queued' AND available_at <= now())
             OR (status = 'in_progress' AND locked_at < now() - make_interval(secs => $1::double precision / 1000))
          ORDER BY available_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       RETURNING id, type, payload, status, attempts`,
      [leaseMs],
    );
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async markJobDone(jobId: number): Promise<void> {
    await this.pool.query(
      `UPDATE jobs SET status = 'done', updated_at = now() WHERE id = $1`,
      [jobId],
    );
  }

  async markJobFailed(jobId: number, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE jobs SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
      [jobId, error],
    );
  }

  async failOrRetryJob(
    jobId: number,
    error: string,
    opts: { maxAttempts: number; backoffMs: number },
  ): Promise<FailOrRetryResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT attempts FROM jobs WHERE id = $1 FOR UPDATE`, [
        jobId,
      ]);
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return { status: 'failed', attempts: 0 };
      }
      const attempts = Number(rows[0].attempts);
      if (attempts >= opts.maxAttempts) {
        await client.query(
          `UPDATE jobs SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1`,
          [jobId, error],
        );
        await client.query('COMMIT');
        return { status: 'failed', attempts };
      }
      const backoffMs = computeBackoffMs(attempts, opts.backoffMs);
      await client.query(
        `UPDATE jobs
            SET status = 'queued', locked_at = NULL, last_error = $2, updated_at = now(),
                available_at = now() + make_interval(secs => $3::double precision / 1000)
          WHERE id = $1`,
        [jobId, error, backoffMs],
      );
      await client.query('COMMIT');
      return { status: 'queued', attempts };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async findOrCreateRun(key: RunKey, initialState: RunState): Promise<FindOrCreateRunResult> {
    const { rows } = await this.pool.query(
      `INSERT INTO runs (installation_id, owner, repo, issue_number, state)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (installation_id, owner, repo, issue_number)
       DO UPDATE SET updated_at = now()
       RETURNING ${RUN_COLUMNS}, (xmax = 0) AS created`,
      [key.installationId, key.owner, key.repo, key.issueNumber, initialState],
    );
    const row = rows[0]!;
    return { run: mapRun(row), created: row.created === true };
  }

  async updateRunState(runId: number, state: RunState): Promise<void> {
    await this.pool.query(`UPDATE runs SET state = $2, updated_at = now() WHERE id = $1`, [
      runId,
      state,
    ]);
  }

  async updateRunContext(runId: number, context: Record<string, unknown>): Promise<void> {
    await this.pool.query(`UPDATE runs SET context = $2, updated_at = now() WHERE id = $1`, [
      runId,
      JSON.stringify(context),
    ]);
  }

  async getRun(key: RunKey): Promise<Run | null> {
    const { rows } = await this.pool.query(
      `SELECT ${RUN_COLUMNS}
         FROM runs
        WHERE installation_id = $1 AND owner = $2 AND repo = $3 AND issue_number = $4`,
      [key.installationId, key.owner, key.repo, key.issueNumber],
    );
    return rows[0] ? mapRun(rows[0]) : null;
  }

  async getRunById(runId: number): Promise<Run | null> {
    const { rows } = await this.pool.query(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE id = $1`,
      [runId],
    );
    return rows[0] ? mapRun(rows[0]) : null;
  }

  async setRunBudget(runId: number, budgetNanoUsd: number): Promise<void> {
    await this.pool.query(`UPDATE runs SET budget_nano_usd = $2, updated_at = now() WHERE id = $1`, [
      runId,
      budgetNanoUsd,
    ]);
  }

  async getStaleRuns(states: RunState[], updatedBefore: number): Promise<Run[]> {
    const { rows } = await this.pool.query(
      `SELECT ${RUN_COLUMNS}
         FROM runs
        WHERE state = ANY($1) AND updated_at < $2
        ORDER BY id`,
      [states, new Date(updatedBefore)],
    );
    return rows.map(mapRun);
  }

  async markRunPinged(runId: number, pingedAt: number): Promise<void> {
    // Deliberately does NOT touch updated_at — the staleness clock keeps running.
    await this.pool.query(`UPDATE runs SET stale_pinged_at = $2 WHERE id = $1`, [
      runId,
      new Date(pingedAt),
    ]);
  }

  async tryMarkEventProcessed(deliveryId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO processed_events (delivery_id) VALUES ($1)
       ON CONFLICT (delivery_id) DO NOTHING
       RETURNING delivery_id`,
      [deliveryId],
    );
    return rowCount === 1;
  }

  async recordTestRun(input: RecordTestRunInput): Promise<TestRun> {
    const { rows } = await this.pool.query(
      `INSERT INTO test_runs (run_id, status, exit_code, duration_ms, command, failure_stage, output_tail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, run_id, status, exit_code, duration_ms, command, failure_stage, output_tail`,
      [
        input.runId,
        input.status,
        input.exitCode,
        input.durationMs,
        input.command,
        input.failureStage ?? null,
        input.outputTail,
      ],
    );
    return mapTestRun(rows[0]!);
  }

  async getTestRuns(runId: number): Promise<TestRun[]> {
    const { rows } = await this.pool.query(
      `SELECT id, run_id, status, exit_code, duration_ms, command, failure_stage, output_tail
         FROM test_runs WHERE run_id = $1 ORDER BY id`,
      [runId],
    );
    return rows.map(mapTestRun);
  }

  async recordLlmCall(input: RecordLlmCallInput): Promise<RecordLlmCallResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO llm_calls
           (run_id, role, model, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_nano_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, run_id, role, model, input_tokens, output_tokens,
                   cache_creation_tokens, cache_read_tokens, cost_nano_usd`,
        [
          input.runId,
          input.role,
          input.model,
          input.inputTokens,
          input.outputTokens,
          input.cacheCreationTokens,
          input.cacheReadTokens,
          input.costNanoUsd,
        ],
      );
      const { rows: runRows } = await client.query(
        `UPDATE runs SET spent_nano_usd = spent_nano_usd + $2, updated_at = now()
          WHERE id = $1
        RETURNING (budget_nano_usd - spent_nano_usd) AS remaining`,
        [input.runId, input.costNanoUsd],
      );
      await client.query('COMMIT');
      return {
        call: mapLlmCall(rows[0]!),
        budgetRemainingNanoUsd: Number(runRows[0]!.remaining),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getLlmCalls(runId: number): Promise<LlmCall[]> {
    const { rows } = await this.pool.query(
      `SELECT id, run_id, role, model, input_tokens, output_tokens,
              cache_creation_tokens, cache_read_tokens, cost_nano_usd
         FROM llm_calls WHERE run_id = $1 ORDER BY id`,
      [runId],
    );
    return rows.map(mapLlmCall);
  }

  async getCostMetrics(): Promise<CostMetrics> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::bigint AS run_count, COALESCE(SUM(spent_nano_usd), 0)::bigint AS total
         FROM runs`,
    );
    const runCount = Number(rows[0]!.run_count);
    const totalNanoUsd = Number(rows[0]!.total);
    return {
      runCount,
      totalNanoUsd,
      avgCostNanoUsd: runCount === 0 ? 0 : Math.round(totalNanoUsd / runCount),
    };
  }

  async recordArtifact(input: RecordArtifactInput): Promise<Artifact> {
    const { rows } = await this.pool.query(
      `INSERT INTO artifacts (run_id, kind, path, content, commit_sha)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (run_id, kind)
       DO UPDATE SET path = EXCLUDED.path, content = EXCLUDED.content,
                     commit_sha = EXCLUDED.commit_sha, created_at = now()
       RETURNING id, run_id, kind, path, content, commit_sha`,
      [input.runId, input.kind, input.path, input.content, input.commitSha ?? null],
    );
    return mapArtifact(rows[0]!);
  }

  async getArtifact(runId: number, kind: ArtifactKind): Promise<Artifact | null> {
    const { rows } = await this.pool.query(
      `SELECT id, run_id, kind, path, content, commit_sha
         FROM artifacts WHERE run_id = $1 AND kind = $2`,
      [runId, kind],
    );
    return rows[0] ? mapArtifact(rows[0]) : null;
  }

  async recordTask(input: RecordTaskInput): Promise<Task> {
    const { rows } = await this.pool.query(
      `INSERT INTO tasks (run_id, idx, title, description, acceptance_criteria)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, run_id, idx, title, description, acceptance_criteria,
                 status, red_observed, green_observed, commit_sha`,
      [input.runId, input.idx, input.title, input.description, JSON.stringify(input.acceptanceCriteria)],
    );
    return mapTask(rows[0]!);
  }

  async getTasks(runId: number): Promise<Task[]> {
    const { rows } = await this.pool.query(
      `SELECT id, run_id, idx, title, description, acceptance_criteria,
              status, red_observed, green_observed, commit_sha
         FROM tasks WHERE run_id = $1 ORDER BY idx`,
      [runId],
    );
    return rows.map(mapTask);
  }

  async updateTask(taskId: number, patch: UpdateTaskInput): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [];
    const add = (col: string, val: unknown): void => {
      values.push(val);
      sets.push(`${col} = $${values.length + 1}`);
    };
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.redObserved !== undefined) add('red_observed', patch.redObserved);
    if (patch.greenObserved !== undefined) add('green_observed', patch.greenObserved);
    if (patch.commitSha !== undefined) add('commit_sha', patch.commitSha);
    if (sets.length === 0) return;
    await this.pool.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = $1`, [taskId, ...values]);
  }

  async upsertInstallationCredential(input: UpsertInstallationCredentialInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO installation_credentials
         (installation_id, anthropic_key_ciphertext, anthropic_key_iv, anthropic_key_auth_tag)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (installation_id)
       DO UPDATE SET anthropic_key_ciphertext = EXCLUDED.anthropic_key_ciphertext,
                     anthropic_key_iv = EXCLUDED.anthropic_key_iv,
                     anthropic_key_auth_tag = EXCLUDED.anthropic_key_auth_tag,
                     updated_at = now()`,
      [input.installationId, input.ciphertext, input.iv, input.authTag],
    );
  }

  async getInstallationCredential(installationId: number): Promise<EncryptedSecret | null> {
    const { rows } = await this.pool.query(
      `SELECT anthropic_key_ciphertext, anthropic_key_iv, anthropic_key_auth_tag
         FROM installation_credentials WHERE installation_id = $1`,
      [installationId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ciphertext: row.anthropic_key_ciphertext as Buffer,
      iv: row.anthropic_key_iv as Buffer,
      authTag: row.anthropic_key_auth_tag as Buffer,
    };
  }

  async deleteInstallationCredential(installationId: number): Promise<void> {
    await this.pool.query('DELETE FROM installation_credentials WHERE installation_id = $1', [
      installationId,
    ]);
  }
}
