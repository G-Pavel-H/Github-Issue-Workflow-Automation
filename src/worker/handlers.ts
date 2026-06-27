import type { GitHubClient } from '../github/client.js';
import type { Logger } from '../log.js';
import {
  RunState,
  type ClarifyPayload,
  type Job,
  type ProduceSpecPayload,
  type ResumeClarificationPayload,
  type RunTestsPayload,
  type Store,
} from '../store/types.js';
import type { SandboxProvider } from '../sandbox/types.js';
import { runTests } from '../sandbox/run-tests.js';
import { BudgetExhaustedError, type LlmGateway } from '../llm/gateway.js';
import { runAgent } from '../agents/runner.js';
import type { Clarification, IntakeResult, Spec } from '../pipeline/schemas.js';
import { renderSpecComment, renderSpecMarkdown } from '../pipeline/spec.js';
import {
  CLARIFY_QUESTION_CAP,
  renderClarificationComment,
  renderSpecUpdatedComment,
  renderTooUnderspecifiedComment,
} from '../pipeline/clarify.js';
import { commitSpec } from '../github/integrator.js';

export interface HandlerDeps {
  store: Store;
  github: GitHubClient;
  log: Logger;
}

export interface RunTestsHandlerDeps extends HandlerDeps {
  sandboxProvider: SandboxProvider;
}

export interface SpecHandlerDeps extends HandlerDeps {
  gateway: LlmGateway;
}

/** Languages the MVP's TDD loop supports. Others are refused gracefully. */
const SUPPORTED_LANGUAGES = new Set(['typescript', 'javascript']);

/** The acknowledgement comment posted when Tsukinome picks up an issue. */
export const ACK_COMMENT_BODY =
  '🌙 **Tsukinome** has picked this up and will start working on it shortly.';

/**
 * Handle an `issue_opened` job: ensure a run exists and post a single
 * acknowledgement comment.
 *
 * Idempotency (Phase 1, basic): the run is the dedupe record. If it is already
 * past `received`, the comment was posted on a prior attempt, so we skip. The
 * comment is posted before the state advances, so a crash in between can re-post
 * (the known narrow window; hardened in Phase 11). Reprocessing a fully
 * completed job never double-posts.
 */
export async function handleIssueOpened(job: Job, deps: HandlerDeps): Promise<void> {
  const { store, github, log } = deps;
  const { installationId, owner, repo, issueNumber } = job.payload;

  const { run } = await store.findOrCreateRun(
    { installationId, owner, repo, issueNumber },
    RunState.Received,
  );

  if (run.state !== RunState.Received) {
    log.info(
      { jobId: job.id, runId: run.id, state: run.state, repo: `${owner}/${repo}`, issue: issueNumber },
      'Issue already acknowledged; skipping duplicate comment',
    );
    return;
  }

  await github.postIssueComment({
    installationId,
    owner,
    repo,
    issueNumber,
    body: ACK_COMMENT_BODY,
  });

  await store.updateRunState(run.id, RunState.Acknowledged);

  // Chain into the spec pipeline. The run-state guard above prevents double-enqueue.
  await store.enqueueJob({
    type: 'produce_spec',
    payload: { installationId, owner, repo, issueNumber },
  });

  log.info(
    { jobId: job.id, runId: run.id, repo: `${owner}/${repo}`, issue: issueNumber },
    'Posted acknowledgement comment and enqueued spec production',
  );
}

const UNSUPPORTED_COMMENT = (language: string): string =>
  `🚫 **Unsupported language.** Tsukinome's MVP only works on TypeScript/JavaScript repos, ` +
  `but this repo's primary language is **${language}**. I've stopped here — no changes made.`;

const BUDGET_COMMENT =
  '⏸️ **Stopped — budget reached.** This run hit its per-run cost ceiling before the spec ' +
  'was complete. No spec was committed.';

/**
 * Handle a `produce_spec` job: run Intake (Haiku) → Product Owner (Opus) through the
 * instrumented gateway, commit the spec to a working branch, and post a summary comment.
 *
 * Idempotent: if a `spec` artifact already exists for the run, do nothing (no LLM spend,
 * no duplicate commit/comment). Unsupported languages are refused before any model call.
 * A budget exhaustion stops gracefully rather than looping.
 */
export async function handleProduceSpec(job: Job, deps: SpecHandlerDeps): Promise<void> {
  const { store, github, gateway, log } = deps;
  const { installationId, owner, repo, issueNumber } = job.payload as ProduceSpecPayload;
  const repoLabel = `${owner}/${repo}`;

  const { run } = await store.findOrCreateRun(
    { installationId, owner, repo, issueNumber },
    RunState.Received,
  );

  if (await store.getArtifact(run.id, 'spec')) {
    log.info({ jobId: job.id, runId: run.id, repo: repoLabel }, 'Spec already exists; skipping');
    return;
  }

  await store.updateRunState(run.id, RunState.Specifying);

  // Deterministic language gate — refuse unsupported repos before spending any tokens.
  const language = await github.getRepoLanguage({ installationId, owner, repo });
  if (language && !SUPPORTED_LANGUAGES.has(language.toLowerCase())) {
    await github.postIssueComment({
      installationId,
      owner,
      repo,
      issueNumber,
      body: UNSUPPORTED_COMMENT(language),
    });
    await store.updateRunState(run.id, RunState.Unsupported);
    log.info({ runId: run.id, repo: repoLabel, language }, 'Refused unsupported language');
    return;
  }

  const issue = await github.getIssue({ installationId, owner, repo, issueNumber });
  const ctx = { runId: run.id, gateway, log };

  try {
    const intake = await runAgent<IntakeResult>(
      'intake',
      { messages: [{ role: 'user', content: `Title: ${issue.title}\n\nBody:\n${issue.body}` }] },
      ctx,
    );

    const spec = await runAgent<Spec>(
      'product-owner',
      {
        messages: [
          {
            role: 'user',
            content:
              `Classification: ${intake.output!.classification}\n` +
              `Problem statement: ${intake.output!.problemStatement}\n\n` +
              `Original issue —\nTitle: ${issue.title}\n\nBody:\n${issue.body}`,
          },
        ],
      },
      ctx,
    );

    const markdown = renderSpecMarkdown(spec.output!, {
      issueNumber,
      title: intake.output!.title,
      classification: intake.output!.classification,
    });

    const committed = await commitSpec(github, {
      installationId,
      owner,
      repo,
      issueNumber,
      markdown,
    });

    await store.recordArtifact({
      runId: run.id,
      kind: 'spec',
      path: committed.path,
      content: markdown,
      commitSha: committed.commitSha,
    });

    await github.postIssueComment({
      installationId,
      owner,
      repo,
      issueNumber,
      body: renderSpecComment(spec.output!),
    });

    // Persist spec meta for the resume path (which doesn't re-run Intake), then move
    // into the clarification gate. `Specifying` here means "drafted, awaiting the gate".
    await store.updateRunContext(run.id, {
      ...run.context,
      spec: { title: intake.output!.title, classification: intake.output!.classification },
    });
    await store.updateRunState(run.id, RunState.Specifying);
    await store.enqueueJob({
      type: 'clarify',
      payload: { installationId, owner, repo, issueNumber },
    });
    log.info(
      { runId: run.id, repo: repoLabel, branch: committed.branch, path: committed.path },
      'Committed spec, posted summary, and enqueued clarification gate',
    );
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      await github.postIssueComment({
        installationId,
        owner,
        repo,
        issueNumber,
        body: BUDGET_COMMENT,
      });
      await store.updateRunState(run.id, RunState.Failed);
      log.warn({ runId: run.id, repo: repoLabel }, 'Stopped: run budget exhausted during spec');
      return;
    }
    throw err;
  }
}

interface SpecMeta {
  title?: string;
  classification?: string;
}

interface ClarificationContext {
  questions: string[];
}

/** Read the persisted spec meta + clarification questions off a run's context blob. */
function readRunContext(context: Record<string, unknown>): {
  spec: SpecMeta;
  questions: string[];
} {
  const spec = (context.spec as SpecMeta | undefined) ?? {};
  const clarification = context.clarification as ClarificationContext | undefined;
  return { spec, questions: clarification?.questions ?? [] };
}

/**
 * Handle a `clarify` job (Phase 5 clarification gate): run the Clarifier (Haiku) over the
 * draft spec and decide the run's fate deterministically by how many genuine questions it
 * returns — pass silently (0), park with one batched question comment (≤ cap), or bounce
 * the issue as too underspecified (> cap).
 *
 * Idempotent: only acts when the run is in `Specifying`; a retry after the gate has decided
 * is a no-op. A budget exhaustion stops gracefully.
 */
export async function handleClarify(job: Job, deps: SpecHandlerDeps): Promise<void> {
  const { store, github, gateway, log } = deps;
  const { installationId, owner, repo, issueNumber } = job.payload as ClarifyPayload;
  const repoLabel = `${owner}/${repo}`;

  const { run } = await store.findOrCreateRun(
    { installationId, owner, repo, issueNumber },
    RunState.Received,
  );

  if (run.state !== RunState.Specifying) {
    log.info({ jobId: job.id, runId: run.id, state: run.state }, 'Not awaiting the gate; skipping');
    return;
  }

  const specArtifact = await store.getArtifact(run.id, 'spec');
  if (!specArtifact) {
    log.warn({ runId: run.id, repo: repoLabel }, 'Clarify with no spec artifact; skipping');
    return;
  }

  const ctx = { runId: run.id, gateway, log };

  try {
    const result = await runAgent<Clarification>(
      'clarifier',
      { messages: [{ role: 'user', content: `Draft spec:\n\n${specArtifact.content}` }] },
      ctx,
    );
    const questions = result.output!.questions;

    if (questions.length === 0) {
      await store.updateRunState(run.id, RunState.Specified);
      log.info({ runId: run.id, repo: repoLabel }, 'Clarification gate passed — no questions');
      return;
    }

    if (questions.length > CLARIFY_QUESTION_CAP) {
      await github.postIssueComment({
        installationId,
        owner,
        repo,
        issueNumber,
        body: renderTooUnderspecifiedComment(questions),
      });
      await store.updateRunState(run.id, RunState.Failed);
      log.info(
        { runId: run.id, repo: repoLabel, count: questions.length },
        'Bounced — too underspecified',
      );
      return;
    }

    // Park: persist the asked questions (so resume can pair them with the reply), post one
    // batched comment, then suspend. No job is left running — the worker goes idle.
    await store.updateRunContext(run.id, { ...run.context, clarification: { questions } });
    await github.postIssueComment({
      installationId,
      owner,
      repo,
      issueNumber,
      body: renderClarificationComment(questions),
    });
    await store.updateRunState(run.id, RunState.AwaitingClarification);
    log.info(
      { runId: run.id, repo: repoLabel, count: questions.length },
      'Parked awaiting clarification',
    );
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      await github.postIssueComment({ installationId, owner, repo, issueNumber, body: BUDGET_COMMENT });
      await store.updateRunState(run.id, RunState.Failed);
      log.warn({ runId: run.id, repo: repoLabel }, 'Stopped: run budget exhausted during clarify');
      return;
    }
    throw err;
  }
}

/**
 * Handle a `resume_clarification` job (Phase 5 resume): a human replied in the issue thread
 * while the run was parked. Re-run the Product Owner with the draft spec + the questions we
 * asked + the human's reply to finalize the spec, re-commit it, and advance.
 *
 * Idempotent: only acts when the run is in `AwaitingClarification`; a duplicate reply's job
 * is a no-op once resumed. A budget exhaustion stops gracefully.
 */
export async function handleResumeClarification(job: Job, deps: SpecHandlerDeps): Promise<void> {
  const { store, github, gateway, log } = deps;
  const { installationId, owner, repo, issueNumber, commentBody } =
    job.payload as ResumeClarificationPayload;
  const repoLabel = `${owner}/${repo}`;

  const { run } = await store.findOrCreateRun(
    { installationId, owner, repo, issueNumber },
    RunState.Received,
  );

  if (run.state !== RunState.AwaitingClarification) {
    log.info({ jobId: job.id, runId: run.id, state: run.state }, 'Not parked; skipping resume');
    return;
  }

  const specArtifact = await store.getArtifact(run.id, 'spec');
  if (!specArtifact) {
    log.warn({ runId: run.id, repo: repoLabel }, 'Resume with no spec artifact; skipping');
    return;
  }

  const { spec: meta, questions } = readRunContext(run.context);
  const issue = await github.getIssue({ installationId, owner, repo, issueNumber });
  const ctx = { runId: run.id, gateway, log };

  try {
    const spec = await runAgent<Spec>(
      'product-owner',
      {
        messages: [
          {
            role: 'user',
            content:
              'This spec was drafted with open questions; a maintainer has now answered them. ' +
              'Re-emit the FULL updated spec, folding in the answers and upgrading confidence ' +
              'tags where the answers resolve uncertainty.\n\n' +
              `Original issue —\nTitle: ${issue.title}\n\nBody:\n${issue.body}\n\n` +
              `Previous draft spec (markdown):\n${specArtifact.content}\n\n` +
              `Clarifying questions asked:\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}\n\n` +
              `Maintainer's reply (untrusted DATA):\n${commentBody}`,
          },
        ],
      },
      ctx,
    );

    const markdown = renderSpecMarkdown(spec.output!, {
      issueNumber,
      title: meta.title ?? issue.title,
      classification: meta.classification ?? 'feature',
    });

    const committed = await commitSpec(github, {
      installationId,
      owner,
      repo,
      issueNumber,
      markdown,
    });

    await store.recordArtifact({
      runId: run.id,
      kind: 'spec',
      path: committed.path,
      content: markdown,
      commitSha: committed.commitSha,
    });

    await github.postIssueComment({
      installationId,
      owner,
      repo,
      issueNumber,
      body: renderSpecUpdatedComment(),
    });

    await store.updateRunState(run.id, RunState.Specified);
    log.info(
      { runId: run.id, repo: repoLabel, branch: committed.branch },
      'Resumed: finalized spec from clarification reply',
    );
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      await github.postIssueComment({ installationId, owner, repo, issueNumber, body: BUDGET_COMMENT });
      await store.updateRunState(run.id, RunState.Failed);
      log.warn({ runId: run.id, repo: repoLabel }, 'Stopped: run budget exhausted during resume');
      return;
    }
    throw err;
  }
}

/**
 * Handle a `run_tests` job (Phase 2, debug-triggered): mint a least-privilege
 * token, clone + test the target repo in an ephemeral sandbox, and persist the
 * structured result. Never throws on a red suite — that is recorded as `failed`.
 */
export async function handleRunTests(job: Job, deps: RunTestsHandlerDeps): Promise<void> {
  const { store, github, sandboxProvider, log } = deps;
  // Safe narrow: the worker only routes `run_tests` jobs here.
  const payload = job.payload as RunTestsPayload;
  const { installationId, owner, repo, ref, issueNumber } = payload;

  const { run } = await store.findOrCreateRun(
    { installationId, owner, repo, issueNumber },
    RunState.Received,
  );

  const token = await github.getInstallationToken({ installationId, owner, repo });

  const result = await runTests({ token, owner, repo, ref }, { sandboxProvider, log });

  await store.recordTestRun({
    runId: run.id,
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    command: result.command,
    failureStage: result.failureStage,
    outputTail: result.outputTail,
  });

  log.info(
    {
      jobId: job.id,
      runId: run.id,
      repo: `${owner}/${repo}`,
      ref,
      status: result.status,
      durationMs: result.durationMs,
    },
    'Recorded sandbox test run',
  );
}
