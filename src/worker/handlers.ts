import type { GitHubClient } from '../github/client.js';
import type { Logger } from '../log.js';
import {
  RunState,
  type ClarifyPayload,
  type FixPayload,
  type ImplementPayload,
  type Job,
  type ProducePlanPayload,
  type ProduceSpecPayload,
  type ResumeClarificationPayload,
  type ResumeImplementationPayload,
  type ResumePlanDecisionPayload,
  type ReviewPayload,
  type RunTestsPayload,
  type Store,
} from '../store/types.js';
import type { SandboxProvider } from '../sandbox/types.js';
import { runTests } from '../sandbox/run-tests.js';
import type { OpenCodeSandboxFn } from '../sandbox/code-sandbox.js';
import { BudgetExhaustedError, type LlmGateway } from '../llm/gateway.js';
import { runAgent } from '../agents/runner.js';
import { decompose, readTestConventions, runTaskTdd, type TaskSpec } from '../pipeline/tdd.js';
import {
  IMPL_HELP_CAP,
  renderEscalationComment,
  renderImplAbortComment,
  renderImplementationDoneComment,
  renderImplHelpAckComment,
  renderImplHelpExhaustedComment,
} from '../pipeline/implement.js';
import { renderPrBody, renderPrTitle, renderReviewedComment } from '../pipeline/review.js';
import { renderCostSummary } from '../pipeline/cost.js';
import { buildRepoMap } from '../pipeline/repo-map.js';
import {
  FIX_ROUND_CAP,
  renderFixCapComment,
  renderFixClarifyComment,
  renderFixDoneComment,
  renderFixEscalationComment,
  renderFixReworkComment,
} from '../pipeline/fix.js';
import type {
  Clarification,
  FixTriage,
  IntakeResult,
  Plan,
  Review,
  Spec,
} from '../pipeline/schemas.js';
import { renderSpecComment, renderSpecMarkdown } from '../pipeline/spec.js';
import {
  CLARIFY_QUESTION_CAP,
  renderClarificationComment,
  renderSpecUpdatedComment,
  renderTooUnderspecifiedComment,
} from '../pipeline/clarify.js';
import {
  PLAN_REVISION_CAP,
  definitionOfReady,
  parsePlanDecision,
  renderDorNotReadyComment,
  renderPlanAbortedComment,
  renderPlanApprovedComment,
  renderPlanGateComment,
  renderPlanMarkdown,
  renderPlanRevisionCapComment,
} from '../pipeline/plan.js';
import {
  commitPlan,
  commitSpec,
  commitTaskFiles,
  openPullRequestForIssue,
  specBranch,
} from '../github/integrator.js';
import {
  DEFAULT_TOP_K,
  namespaceFor,
  type CodeChunk,
  type CodeIndex,
} from '../index/types.js';
import type { Checkout, CloneInput } from '../index/checkout.js';

export interface HandlerDeps {
  store: Store;
  github: GitHubClient;
  log: Logger;
  /** Optional per-run budget ceiling (nano-USD) applied when a run is first created. */
  runBudgetNanoUsd?: number;
}

export interface RunTestsHandlerDeps extends HandlerDeps {
  sandboxProvider: SandboxProvider;
}

export interface SpecHandlerDeps extends HandlerDeps {
  gateway: LlmGateway;
}

/** Clone a repo to a host temp dir (injected so handler tests don't touch git). */
export type CloneFn = (input: CloneInput) => Promise<Checkout>;

export interface PlanHandlerDeps extends SpecHandlerDeps {
  codeIndex: CodeIndex;
  cloneRepo: CloneFn;
}

export interface ImplementHandlerDeps extends SpecHandlerDeps {
  sandboxProvider: SandboxProvider;
  /** Injectable so tests drive a fake code session; defaults to the real E2B opener. */
  openSandbox: OpenCodeSandboxFn;
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

  const { run, created } = await store.findOrCreateRun(
    { installationId, owner, repo, issueNumber },
    RunState.Received,
  );

  // Apply the configured per-run budget ceiling at the one place a run is born.
  if (created && deps.runBudgetNanoUsd !== undefined) {
    await store.setRunBudget(run.id, deps.runBudgetNanoUsd);
  }

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

    // Persist spec meta + the structured spec (for the resume path, which doesn't re-run
    // Intake, and for the Phase-7 DoR gate), then move into the clarification gate.
    // `Specifying` here means "drafted, awaiting the gate".
    await store.updateRunContext(run.id, {
      ...run.context,
      spec: { title: intake.output!.title, classification: intake.output!.classification },
      specData: spec.output!,
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

/** Read the persisted spec meta, structured spec/plan, and clarification questions off the context. */
function readRunContext(context: Record<string, unknown>): {
  spec: SpecMeta;
  specData?: Spec;
  planData?: Plan;
  questions: string[];
} {
  const spec = (context.spec as SpecMeta | undefined) ?? {};
  const specData = context.specData as Spec | undefined;
  const planData = context.planData as Plan | undefined;
  const clarification = context.clarification as ClarificationContext | undefined;
  return { spec, specData, planData, questions: clarification?.questions ?? [] };
}

/** Persisted state of the implementation "stuck" gate (survives the suspend across a human reply). */
interface ImplHelp {
  /** DB id of the task that stalled. */
  taskId: number;
  stage?: 'test' | 'impl';
  lastFailureOutput?: string;
  /** How many human-guided retries have been consumed. */
  rounds: number;
  /** The maintainer's latest guidance, threaded into the retried task (cleared once applied). */
  guidance?: string;
}

function readImplHelp(context: Record<string, unknown>): ImplHelp | undefined {
  return context.implHelp as ImplHelp | undefined;
}

/**
 * Handle a `clarify` job (Phase 5 clarification gate): run the Clarifier (Haiku) over the
 * draft spec and decide the run's fate deterministically by how many genuine questions it
 * returns — pass silently (0), park with one batched question comment (≤ cap), or bounce
 * the issue as too underspecified (> cap).
 *
 * Idempotent: only acts when the run is in `Specifying`; a retry after the gate has decided
 * is a no-op. A budget exhaustion stops gracefully.
 *
 * The Clarifier is grounded in the repo's code (same code context the Architect uses — a repo map
 * + retrieved chunks keyed on the draft spec) so it asks questions the codebase can't already
 * answer. Code grounding is best-effort: any failure degrades to text-only and the gate runs
 * exactly as before. This is not cached (the Clarifier is one-shot and human-gated).
 */
export async function handleClarify(job: Job, deps: PlanHandlerDeps): Promise<void> {
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

  // Ground the Clarifier in code (best-effort). Any failure — clone error or missing CocoIndex
  // sidecar — degrades to text-only so the gate still runs exactly as before.
  let codeContext = '';
  try {
    const { repoMap, chunks } = await retrieveCodeContext(deps, {
      installationId,
      owner,
      repo,
      issueNumber,
      runId: run.id,
      query: specArtifact.content,
    });
    codeContext =
      `\n\n${repoMap ?? '## Repository file map\n(unavailable)'}` +
      `\n\nRetrieved code context from the repo:\n${
        chunks.length ? renderChunks(chunks) : '(code index unavailable)'
      }`;
  } catch (err) {
    log.warn(
      { runId: run.id, repo: repoLabel, err: err instanceof Error ? err.message : String(err) },
      'Code grounding unavailable; clarifying from the spec text only',
    );
  }

  try {
    const result = await runAgent<Clarification>(
      'clarifier',
      {
        messages: [
          { role: 'user', content: `Draft spec:\n\n${specArtifact.content}${codeContext}` },
        ],
      },
      ctx,
    );
    const questions = result.output!.questions;

    if (questions.length === 0) {
      await store.updateRunState(run.id, RunState.Specified);
      await store.enqueueJob({
        type: 'produce_plan',
        payload: { installationId, owner, repo, issueNumber },
      });
      log.info({ runId: run.id, repo: repoLabel }, 'Clarification gate passed — enqueued planning');
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

    // Refresh the structured spec for the DoR gate, finalize, and chain into planning.
    await store.updateRunContext(run.id, { ...run.context, specData: spec.output! });
    await store.updateRunState(run.id, RunState.Specified);
    await store.enqueueJob({
      type: 'produce_plan',
      payload: { installationId, owner, repo, issueNumber },
    });
    log.info(
      { runId: run.id, repo: repoLabel, branch: committed.branch },
      'Resumed: finalized spec from clarification reply; enqueued planning',
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

/** Render retrieved code chunks as labelled context for a code-aware agent prompt. */
function renderChunks(chunks: CodeChunk[]): string {
  if (chunks.length === 0) return '(no relevant code found in the repo index)';
  return chunks
    .map((c) => `// ${c.path}:${c.startLine}-${c.endLine}\n${c.content}`)
    .join('\n\n');
}

/** The subset of deps needed to gather code context (clone + index + repo map). */
type CodeContextDeps = Pick<PlanHandlerDeps, 'github' | 'codeIndex' | 'cloneRepo' | 'log'>;

/**
 * Clone the working branch and gather best-effort code context for a code-aware agent: a
 * structural repo map (always attempted) + the top-`DEFAULT_TOP_K` semantically-retrieved chunks
 * for `query`. Retrieval degrades to an empty chunk list when the CocoIndex sidecar is unavailable
 * (it's optional; see docs/setup.md), and the repo map degrades to `undefined` on any failure. The
 * index namespace and the checkout are **always** torn down (`finally`) so vectors never linger and
 * no checkout leaks. A clone failure propagates — callers that must never fail on it (e.g. the
 * Clarifier gate) wrap the call and degrade to text-only. Shared by the Architect (plan step) and
 * the Clarifier (clarification gate).
 */
async function retrieveCodeContext(
  deps: CodeContextDeps,
  args: {
    installationId: number;
    owner: string;
    repo: string;
    issueNumber: number;
    runId: number;
    query: string;
  },
): Promise<{ repoMap?: string; chunks: CodeChunk[] }> {
  const { github, codeIndex, cloneRepo, log } = deps;
  const { installationId, owner, repo, issueNumber, runId, query } = args;

  const token = await github.getInstallationToken({ installationId, owner, repo });
  const checkout = await cloneRepo({ token, owner, repo, ref: specBranch(issueNumber) });
  const namespace = namespaceFor({ owner, repo, runId });

  try {
    // Code retrieval is a best-effort enrichment: the CocoIndex sidecar is optional
    // (see docs/setup.md), so if indexing/retrieval is unavailable we return no chunks
    // rather than failing.
    let chunks: CodeChunk[] = [];
    try {
      const indexed = await codeIndex.indexRepo({ namespace, dir: checkout.dir });
      chunks = await codeIndex.retrieve(namespace, query, { topK: DEFAULT_TOP_K });
      log.info(
        {
          runId,
          repo: `${owner}/${repo}`,
          indexedFiles: indexed.fileCount,
          indexedChunks: indexed.chunkCount,
          retrievedChunks: chunks.length,
        },
        'Code index ready; retrieved repo context',
      );
    } catch (err) {
      log.warn(
        {
          runId,
          repo: `${owner}/${repo}`,
          err: err instanceof Error ? err.message : String(err),
        },
        'Code index unavailable; continuing without repo retrieval',
      );
    }

    // Structural view of the repo (cheap; complements the semantic retrieval above). Best-effort.
    const repoMap = await buildRepoMap(checkout.dir);
    return { repoMap, chunks };
  } finally {
    await codeIndex.dropNamespace(namespace);
    checkout.cleanup();
  }
}

interface ArchitectArgs {
  installationId: number;
  owner: string;
  repo: string;
  issueNumber: number;
  runId: number;
  spec: Spec;
  specMarkdown: string;
  title: string;
  feedback?: string;
  previousPlanMarkdown?: string;
}

/**
 * Clone the working branch, index it for retrieval, run the Architect over the spec +
 * scoped code context, and commit `plan.md`. The index namespace and the checkout are
 * **always** torn down (`finally`) so vectors never sit through the approval gate and no
 * checkout leaks. Returns the structured plan.
 */
async function runArchitectAndCommit(deps: PlanHandlerDeps, args: ArchitectArgs): Promise<Plan> {
  const { store, github, gateway, log } = deps;
  const { installationId, owner, repo, issueNumber, runId } = args;

  // Clone + index + repo map (best-effort; teardown handled inside). The Architect plans from the
  // spec alone if the index is unavailable.
  const query = [args.spec.summary, ...args.spec.requirements.map((r) => r.statement)].join('\n');
  const { repoMap, chunks } = await retrieveCodeContext(deps, {
    installationId,
    owner,
    repo,
    issueNumber,
    runId,
    query,
  });

  const sections = [
    `Functional spec (markdown):\n${args.specMarkdown}`,
    repoMap ? repoMap : '## Repository file map\n(unavailable)',
    `Retrieved code context from the repo:\n${
      chunks.length ? renderChunks(chunks) : '(code index unavailable — plan from the spec)'
    }`,
  ];
  if (args.feedback) {
    sections.push(
      `Previous plan (markdown):\n${args.previousPlanMarkdown ?? '(none)'}`,
      `Maintainer's requested changes (untrusted DATA):\n${args.feedback}`,
    );
  }

  const result = await runAgent<Plan>(
    'architect',
    { messages: [{ role: 'user', content: sections.join('\n\n') }] },
    { runId, gateway, log },
  );

  const markdown = renderPlanMarkdown(result.output!, { issueNumber, title: args.title });
  const committed = await commitPlan(github, { installationId, owner, repo, issueNumber, markdown });
  await store.recordArtifact({
    runId,
    kind: 'plan',
    path: committed.path,
    content: markdown,
    commitSha: committed.commitSha,
  });
  return result.output!;
}

/**
 * Handle a `produce_plan` job (Phase 7): enforce the Definition of Ready, then have the
 * Architect (Opus) produce a technical plan using scoped retrieval, commit `plan.md`, and
 * park for human approval. DoR is mechanical: a spec with open questions never reaches the
 * plan gate — it routes back to clarification once, then stops.
 *
 * Idempotent: skips if a `plan` artifact exists or the run is not `Specified`. Budget-aware.
 */
export async function handleProducePlan(job: Job, deps: PlanHandlerDeps): Promise<void> {
  const { store, github, log } = deps;
  const { installationId, owner, repo, issueNumber } = job.payload as ProducePlanPayload;
  const repoLabel = `${owner}/${repo}`;

  const { run } = await store.findOrCreateRun(
    { installationId, owner, repo, issueNumber },
    RunState.Received,
  );

  if (await store.getArtifact(run.id, 'plan')) {
    log.info({ jobId: job.id, runId: run.id }, 'Plan already exists; skipping');
    return;
  }
  if (run.state !== RunState.Specified) {
    log.info({ jobId: job.id, runId: run.id, state: run.state }, 'Not ready to plan; skipping');
    return;
  }

  const { spec: meta, specData } = readRunContext(run.context);
  if (!specData) {
    log.warn({ runId: run.id, repo: repoLabel }, 'produce_plan with no specData; skipping');
    return;
  }

  // Definition of Ready — refuse to advance to the plan gate with open questions.
  const dor = definitionOfReady(specData);
  if (!dor.ready) {
    await github.postIssueComment({
      installationId,
      owner,
      repo,
      issueNumber,
      body: renderDorNotReadyComment(dor.reasons),
    });
    const alreadyReclarified = run.context.dorReclarified === true;
    if (!alreadyReclarified && specData.openQuestions.length > 0) {
      await store.updateRunContext(run.id, { ...run.context, dorReclarified: true });
      await store.updateRunState(run.id, RunState.Specifying);
      await store.enqueueJob({ type: 'clarify', payload: { installationId, owner, repo, issueNumber } });
      log.info({ runId: run.id, repo: repoLabel }, 'DoR not met; routed back to clarification');
    } else {
      await store.updateRunState(run.id, RunState.Failed);
      log.warn({ runId: run.id, repo: repoLabel, reasons: dor.reasons }, 'DoR not met; stopping');
    }
    return;
  }

  const specArtifact = await store.getArtifact(run.id, 'spec');
  await store.updateRunState(run.id, RunState.Planning);

  try {
    const plan = await runArchitectAndCommit(deps, {
      installationId,
      owner,
      repo,
      issueNumber,
      runId: run.id,
      spec: specData,
      specMarkdown: specArtifact?.content ?? '',
      title: meta.title ?? `Issue #${issueNumber}`,
    });

    await store.updateRunContext(run.id, { ...run.context, planData: plan });
    await github.postIssueComment({
      installationId,
      owner,
      repo,
      issueNumber,
      body: renderPlanGateComment(specData, plan),
    });
    await store.updateRunState(run.id, RunState.AwaitingPlanApproval);
    log.info({ runId: run.id, repo: repoLabel }, 'Plan produced; parked awaiting approval');
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      await github.postIssueComment({ installationId, owner, repo, issueNumber, body: BUDGET_COMMENT });
      await store.updateRunState(run.id, RunState.Failed);
      log.warn({ runId: run.id, repo: repoLabel }, 'Stopped: run budget exhausted during plan');
      return;
    }
    throw err;
  }
}

/**
 * Handle a `resume_plan_decision` job (Phase 7): a human replied at the plan gate. `/approve`
 * advances to implementation, `/abort` closes the run, anything else is a change request that
 * regenerates the plan with the feedback (bounded by PLAN_REVISION_CAP) and re-presents it.
 *
 * Idempotent: only acts when the run is `AwaitingPlanApproval`. Budget-aware.
 */
export async function handleResumePlanDecision(job: Job, deps: PlanHandlerDeps): Promise<void> {
  const { store, github, log } = deps;
  const { installationId, owner, repo, issueNumber, commentBody } =
    job.payload as ResumePlanDecisionPayload;
  const repoLabel = `${owner}/${repo}`;

  const { run } = await store.findOrCreateRun(
    { installationId, owner, repo, issueNumber },
    RunState.Received,
  );

  if (run.state !== RunState.AwaitingPlanApproval) {
    log.info({ jobId: job.id, runId: run.id, state: run.state }, 'Not at plan gate; skipping');
    return;
  }

  const decision = parsePlanDecision(commentBody);

  if (decision === 'approve') {
    await github.postIssueComment({ installationId, owner, repo, issueNumber, body: renderPlanApprovedComment() });
    await store.updateRunState(run.id, RunState.Implementing);
    await store.enqueueJob({ type: 'implement', payload: { installationId, owner, repo, issueNumber } });
    log.info({ runId: run.id, repo: repoLabel }, 'Plan approved; enqueued implementation');
    return;
  }

  if (decision === 'abort') {
    await github.postIssueComment({ installationId, owner, repo, issueNumber, body: renderPlanAbortedComment() });
    await store.updateRunState(run.id, RunState.Aborted);
    log.info({ runId: run.id, repo: repoLabel }, 'Run aborted at plan gate');
    return;
  }

  // Change request — regenerate the plan, bounded by the revision cap.
  const { spec: meta, specData } = readRunContext(run.context);
  if (!specData) {
    log.warn({ runId: run.id, repo: repoLabel }, 'plan revision with no specData; skipping');
    return;
  }
  const revisions = (run.context.plan as { revisions?: number } | undefined)?.revisions ?? 0;
  if (revisions >= PLAN_REVISION_CAP) {
    await github.postIssueComment({ installationId, owner, repo, issueNumber, body: renderPlanRevisionCapComment() });
    log.info({ runId: run.id, repo: repoLabel, revisions }, 'Plan revision cap reached; awaiting decision');
    return; // stay parked at the gate
  }

  const [specArtifact, planArtifact] = [
    await store.getArtifact(run.id, 'spec'),
    await store.getArtifact(run.id, 'plan'),
  ];
  await store.updateRunState(run.id, RunState.Planning);

  try {
    const plan = await runArchitectAndCommit(deps, {
      installationId,
      owner,
      repo,
      issueNumber,
      runId: run.id,
      spec: specData,
      specMarkdown: specArtifact?.content ?? '',
      title: meta.title ?? `Issue #${issueNumber}`,
      feedback: commentBody,
      previousPlanMarkdown: planArtifact?.content,
    });

    await store.updateRunContext(run.id, {
      ...run.context,
      planData: plan,
      plan: { revisions: revisions + 1 },
    });
    await github.postIssueComment({
      installationId,
      owner,
      repo,
      issueNumber,
      body: renderPlanGateComment(specData, plan),
    });
    await store.updateRunState(run.id, RunState.AwaitingPlanApproval);
    log.info({ runId: run.id, repo: repoLabel, revision: revisions + 1 }, 'Plan revised; re-parked');
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      await github.postIssueComment({ installationId, owner, repo, issueNumber, body: BUDGET_COMMENT });
      await store.updateRunState(run.id, RunState.Failed);
      log.warn({ runId: run.id, repo: repoLabel }, 'Stopped: run budget exhausted during plan revision');
      return;
    }
    throw err;
  }
}

/**
 * Handle an `implement` job (Phase 8): decompose the approved plan into tasks and implement
 * each one test-first in a sandbox — observe red, make it green with the suite staying green,
 * refactor, then commit per task. A task that can't be completed within the retry/budget caps
 * escalates to a human (graceful `Failed`) instead of looping.
 *
 * Idempotent/restartable: only runs from `Implementing`; tasks already `done` are skipped (the
 * fresh clone of the working branch already contains their commits). Budget exhaustion stops at
 * a task boundary. The sandbox is always torn down.
 */
export async function handleImplement(job: Job, deps: ImplementHandlerDeps): Promise<void> {
  const { store, github, gateway, sandboxProvider, openSandbox, log } = deps;
  const { installationId, owner, repo, issueNumber } = job.payload as ImplementPayload;
  const repoLabel = `${owner}/${repo}`;

  const { run } = await store.findOrCreateRun(
    { installationId, owner, repo, issueNumber },
    RunState.Received,
  );

  if (run.state !== RunState.Implementing) {
    log.info({ jobId: job.id, runId: run.id, state: run.state }, 'Not implementing; skipping');
    return;
  }

  const [specArtifact, planArtifact] = [
    await store.getArtifact(run.id, 'spec'),
    await store.getArtifact(run.id, 'plan'),
  ];
  if (!specArtifact || !planArtifact) {
    log.warn({ runId: run.id, repo: repoLabel }, 'implement without spec/plan artifact; skipping');
    return;
  }

  const { planData } = readRunContext(run.context);
  const affectedPaths = planData?.affectedFiles.map((f) => f.path) ?? [];

  const token = await github.getInstallationToken({ installationId, owner, repo });
  const sandbox = await openSandbox(
    { token, owner, repo, ref: specBranch(issueNumber) },
    { sandboxProvider, log },
  );

  try {
    // Decompose once; on a restart the tasks already exist and we resume.
    let tasks = await store.getTasks(run.id);
    if (tasks.length === 0) {
      const specs = await decompose(specArtifact.content, planArtifact.content, {
        runId: run.id,
        gateway,
        log,
      });
      for (let i = 0; i < specs.length; i++) {
        await store.recordTask({
          runId: run.id,
          idx: i,
          title: specs[i]!.title,
          description: specs[i]!.description,
          acceptanceCriteria: specs[i]!.acceptanceCriteria,
        });
      }
      tasks = await store.getTasks(run.id);
    }

    const tddCtx = {
      sandbox,
      gateway,
      runId: run.id,
      log,
      specMarkdown: specArtifact.content,
      planMarkdown: planArtifact.content,
      affectedPaths,
      testConventions: await readTestConventions(sandbox),
    };

    for (const task of tasks) {
      if (task.status === 'done') continue;

      // Stop at a safe boundary if the budget is spent — don't start a task we can't finish.
      const fresh = await store.getRunById(run.id);
      if (fresh && fresh.budgetNanoUsd - fresh.spentNanoUsd <= 0) {
        await github.postIssueComment({ installationId, owner, repo, issueNumber, body: BUDGET_COMMENT });
        await store.updateRunState(run.id, RunState.Failed);
        log.warn({ runId: run.id, repo: repoLabel }, 'Stopped: budget exhausted at task boundary');
        return;
      }

      const taskSpec: TaskSpec = {
        id: `T${task.idx + 1}`,
        title: task.title,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
      };
      // Apply maintainer guidance from the "stuck" gate only to the task it was given for.
      const implHelp = readImplHelp(run.context);
      const guidance = implHelp && implHelp.taskId === task.id ? implHelp.guidance : undefined;
      const outcome = await runTaskTdd(taskSpec, { ...tddCtx, humanGuidance: guidance });

      if (outcome.status === 'escalated') {
        await store.updateTask(task.id, {
          status: 'escalated',
          redObserved: outcome.redObserved,
          greenObserved: outcome.greenObserved,
        });
        // Park at the human-help gate instead of dead-ending: persist where we stalled (and the
        // rounds consumed so far) so a maintainer reply can resume with guidance. Clear any spent
        // guidance — this attempt used it and still failed.
        await store.updateRunContext(run.id, {
          ...run.context,
          implHelp: {
            taskId: task.id,
            stage: outcome.stage,
            lastFailureOutput: outcome.lastFailureOutput,
            rounds: implHelp?.rounds ?? 0,
            guidance: undefined,
          } satisfies ImplHelp,
        });
        await github.postIssueComment({
          installationId,
          owner,
          repo,
          issueNumber,
          body: renderEscalationComment(task.title, outcome.stage, outcome.lastFailureOutput),
        });
        await store.updateRunState(run.id, RunState.AwaitingImplHelp);
        log.warn({ runId: run.id, repo: repoLabel, task: task.id, stage: outcome.stage }, 'Task stalled; parked at human-help gate');
        return;
      }

      // Already satisfied — the task's behavior already exists (redundant / delivered by an earlier
      // task). Nothing to implement or commit; mark it done and move on rather than dead-ending.
      if (outcome.status === 'already-satisfied') {
        await store.updateTask(task.id, { status: 'done', redObserved: false, greenObserved: true });
        if (implHelp && implHelp.taskId === task.id) {
          run.context.implHelp = undefined;
          await store.updateRunContext(run.id, { ...run.context });
        }
        log.info(
          { runId: run.id, repo: repoLabel, task: task.id },
          'Task already satisfied; skipped (behavior already present)',
        );
        continue;
      }

      // Done — commit the task's files as one commit on the working branch.
      const changed = await sandbox.readFiles(outcome.changedPaths);
      const commit = await commitTaskFiles(github, {
        installationId,
        owner,
        repo,
        issueNumber,
        files: changed,
        message: `Tsukinome: ${task.title} (#${issueNumber})`,
      });
      await store.updateTask(task.id, {
        status: 'done',
        redObserved: true,
        greenObserved: true,
        commitSha: commit.commitSha,
      });
      // A previously-stalled task landed — clear the gate state so it doesn't linger.
      if (implHelp && implHelp.taskId === task.id) {
        run.context.implHelp = undefined;
        await store.updateRunContext(run.id, { ...run.context });
      }
      log.info({ runId: run.id, repo: repoLabel, task: task.id }, 'Task done; committed');
    }

    await github.postIssueComment({
      installationId,
      owner,
      repo,
      issueNumber,
      body: renderImplementationDoneComment(tasks.length),
    });
    await store.updateRunState(run.id, RunState.Reviewing);
    await store.enqueueJob({ type: 'review', payload: { installationId, owner, repo, issueNumber } });
    log.info({ runId: run.id, repo: repoLabel, tasks: tasks.length }, 'Implementation complete; enqueued review');
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      await github.postIssueComment({ installationId, owner, repo, issueNumber, body: BUDGET_COMMENT });
      await store.updateRunState(run.id, RunState.Failed);
      log.warn({ runId: run.id, repo: repoLabel }, 'Stopped: run budget exhausted during implementation');
      return;
    }
    throw err;
  } finally {
    await sandbox.close();
  }
}

/**
 * Handle a `resume_implementation` job: a maintainer replied at the "stuck" gate. `/abort` closes
 * the run; any other reply is guidance — persisted in context and threaded into the retried task,
 * then the run re-enters the (restartable) implementation loop. Bounded by `IMPL_HELP_CAP` guided
 * rounds, after which it stops for real. The red→green gate still holds on every retry, so guidance
 * can steer *which* tests exist but never force a non-green commit.
 */
export async function handleResumeImplementation(
  job: Job,
  deps: ImplementHandlerDeps,
): Promise<void> {
  const { store, github, log } = deps;
  const { installationId, owner, repo, issueNumber, commentBody } =
    job.payload as ResumeImplementationPayload;
  const repoLabel = `${owner}/${repo}`;

  const run = await store.getRun({ installationId, owner, repo, issueNumber });
  if (!run || run.state !== RunState.AwaitingImplHelp) {
    log.info({ jobId: job.id, runId: run?.id, state: run?.state }, 'Not awaiting impl help; skipping');
    return;
  }

  const post = (body: string) =>
    github.postIssueComment({ installationId, owner, repo, issueNumber, body });

  // `/abort` at the gate closes the run.
  if (commentBody.trim().toLowerCase().startsWith('/abort')) {
    await post(renderImplAbortComment());
    await store.updateRunState(run.id, RunState.Aborted);
    log.info({ runId: run.id, repo: repoLabel }, 'Human aborted at the impl-help gate');
    return;
  }

  const implHelp = readImplHelp(run.context);
  const nextRound = (implHelp?.rounds ?? 0) + 1;
  if (nextRound > IMPL_HELP_CAP) {
    await post(renderImplHelpExhaustedComment());
    await store.updateRunState(run.id, RunState.Failed);
    log.warn({ runId: run.id, repo: repoLabel, rounds: nextRound }, 'Impl-help retries exhausted; failing');
    return;
  }

  // Persist the guidance + bumped round, then re-enter the restartable implementation loop.
  await store.updateRunContext(run.id, {
    ...run.context,
    implHelp: {
      ...(implHelp ?? { taskId: -1, rounds: 0 }),
      rounds: nextRound,
      guidance: commentBody,
    } satisfies ImplHelp,
  });
  await store.updateRunState(run.id, RunState.Implementing);
  await store.enqueueJob({ type: 'implement', payload: { installationId, owner, repo, issueNumber } });
  await post(renderImplHelpAckComment());
  log.info({ runId: run.id, repo: repoLabel, round: nextRound }, 'Resuming implementation with human guidance');
}

/**
 * Handle a `review` job (Phase 9): the Reviewer (Opus) self-reviews the change (spec + plan +
 * diff), then the deterministic Integrator opens the PR — summarizing spec/plan/assumptions and
 * the review, linking the issue. The review is advisory (recorded for the audit trail); opening
 * the PR is the MVP heartbeat. No agent performs git/PR writes.
 *
 * Idempotent: only runs from `Reviewing`; the PR open itself is idempotent on the head branch.
 * Budget-aware.
 */
export async function handleReview(job: Job, deps: SpecHandlerDeps): Promise<void> {
  const { store, github, gateway, log } = deps;
  const { installationId, owner, repo, issueNumber } = job.payload as ReviewPayload;
  const repoLabel = `${owner}/${repo}`;

  const { run } = await store.findOrCreateRun(
    { installationId, owner, repo, issueNumber },
    RunState.Received,
  );

  if (run.state !== RunState.Reviewing) {
    log.info({ jobId: job.id, runId: run.id, state: run.state }, 'Not reviewing; skipping');
    return;
  }

  const [specArtifact, planArtifact] = [
    await store.getArtifact(run.id, 'spec'),
    await store.getArtifact(run.id, 'plan'),
  ];
  const { spec: meta, specData, planData } = readRunContext(run.context);
  if (!specArtifact || !planArtifact || !specData || !planData) {
    log.warn({ runId: run.id, repo: repoLabel }, 'review without spec/plan; skipping');
    return;
  }

  const ctx = { runId: run.id, gateway, log };

  try {
    const diff = await github.compareDiff({ installationId, owner, repo, head: specBranch(issueNumber) });

    const review = await runAgent<Review>(
      'reviewer',
      {
        messages: [
          {
            role: 'user',
            content: `Spec:\n${specArtifact.content}\n\nPlan:\n${planArtifact.content}\n\nDiff:\n${diff}`,
          },
        ],
      },
      ctx,
    );

    // The review is the run's last model call, so the cost summary is now complete.
    const costSummary = renderCostSummary(await store.getLlmCalls(run.id));

    const pr = await openPullRequestForIssue(github, {
      installationId,
      owner,
      repo,
      issueNumber,
      title: renderPrTitle({ title: meta.title ?? `Issue #${issueNumber}` }, issueNumber),
      body: renderPrBody({ spec: specData, plan: planData, review: review.output!, issueNumber, costSummary }),
    });

    await github.postIssueComment({
      installationId,
      owner,
      repo,
      issueNumber,
      body: renderReviewedComment(pr.url, review.output!, costSummary),
    });

    await store.updateRunState(run.id, RunState.AwaitingPrReview);
    const spent = (await store.getRunById(run.id))?.spentNanoUsd ?? 0;
    log.info(
      { runId: run.id, repo: repoLabel, pr: pr.number, spentNanoUsd: spent },
      'Opened PR; awaiting human review',
    );
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      await github.postIssueComment({ installationId, owner, repo, issueNumber, body: BUDGET_COMMENT });
      await store.updateRunState(run.id, RunState.Failed);
      log.warn({ runId: run.id, repo: repoLabel }, 'Stopped: run budget exhausted during review');
      return;
    }
    throw err;
  }
}

const FIX_BUDGET_COMMENT =
  '⏸️ **Stopped — budget reached.** This run hit its per-run cost ceiling. Handing back to a human.';

/**
 * Handle a `fix` job (Phase 10): a maintainer left a PR review comment while parked at
 * `AwaitingPrReview`. Triage it — a vague comment gets one clarifying question, a rework-sized
 * request routes back to the plan gate, and an actionable one is fixed **test-first** (reusing the
 * Phase-8 TDD loop) and pushed as a new commit with a thread reply. Bounded by FIX_ROUND_CAP and
 * the per-run budget; exceeding either escalates to a human. The sandbox is always closed.
 */
export async function handleFix(job: Job, deps: ImplementHandlerDeps): Promise<void> {
  const { store, github, gateway, sandboxProvider, openSandbox, log } = deps;
  const { installationId, owner, repo, issueNumber, prNumber, commentBody, filePath, reviewCommentId } =
    job.payload as FixPayload;
  const repoLabel = `${owner}/${repo}`;

  const { run } = await store.findOrCreateRun(
    { installationId, owner, repo, issueNumber },
    RunState.Received,
  );

  if (run.state !== RunState.AwaitingPrReview) {
    log.info({ jobId: job.id, runId: run.id, state: run.state }, 'Not awaiting PR review; skipping fix');
    return;
  }

  // Reply on the inline thread when we have one, else on the PR conversation.
  const reply = async (body: string): Promise<void> => {
    if (reviewCommentId !== undefined) {
      await github.replyToReviewComment({ installationId, owner, repo, pullNumber: prNumber, commentId: reviewCommentId, body });
    } else {
      await github.postIssueComment({ installationId, owner, repo, issueNumber: prNumber, body });
    }
  };

  const ctx = { runId: run.id, gateway, log };

  try {
    const [specArtifact, planArtifact] = [
      await store.getArtifact(run.id, 'spec'),
      await store.getArtifact(run.id, 'plan'),
    ];

    const triage = await runAgent<FixTriage>(
      'fix-triage',
      {
        messages: [
          {
            role: 'user',
            content:
              `Review comment:\n${commentBody}\n\n${filePath ? `File: ${filePath}\n\n` : ''}` +
              `Spec:\n${specArtifact?.content ?? '(unavailable)'}`,
          },
        ],
      },
      ctx,
    );
    const kind = triage.output!.kind;

    if (kind === 'vague') {
      await reply(renderFixClarifyComment(triage.output!.reason));
      log.info({ runId: run.id, repo: repoLabel }, 'Vague review comment; asked for clarification');
      return; // stay parked; no round consumed
    }

    if (kind === 'rework') {
      await reply(renderFixReworkComment());
      await store.updateRunState(run.id, RunState.AwaitingPlanApproval);
      await store.enqueueJob({
        type: 'resume_plan_decision',
        payload: { installationId, owner, repo, issueNumber, commentBody },
      });
      log.info({ runId: run.id, repo: repoLabel }, 'Rework request; routed back to the plan gate');
      return;
    }

    // actionable — bounded by the per-PR fix-round cap.
    const rounds = (run.context.fix as { rounds?: number } | undefined)?.rounds ?? 0;
    if (rounds >= FIX_ROUND_CAP) {
      await reply(renderFixCapComment());
      await store.updateRunState(run.id, RunState.Failed);
      log.warn({ runId: run.id, repo: repoLabel, rounds }, 'Fix-round cap reached; escalating');
      return;
    }

    const token = await github.getInstallationToken({ installationId, owner, repo });
    const sandbox = await openSandbox(
      { token, owner, repo, ref: specBranch(issueNumber) },
      { sandboxProvider, log },
    );
    try {
      const task: TaskSpec = {
        id: 'FIX',
        title: 'Address review feedback',
        description: `A maintainer left this review comment${filePath ? ` on ${filePath}` : ''}:\n${commentBody}`,
        acceptanceCriteria: [`The concern in the review comment is resolved: ${commentBody}`],
      };
      const outcome = await runTaskTdd(task, {
        sandbox,
        gateway,
        runId: run.id,
        log,
        specMarkdown: specArtifact?.content ?? '',
        planMarkdown: planArtifact?.content ?? '',
        affectedPaths: filePath ? [filePath] : [],
        testConventions: await readTestConventions(sandbox),
      });

      if (outcome.status === 'escalated') {
        await reply(renderFixEscalationComment(outcome.lastFailureOutput));
        await store.updateRunState(run.id, RunState.Failed);
        log.warn({ runId: run.id, repo: repoLabel, stage: outcome.stage }, 'Fix could not land; escalating');
        return;
      }

      // Already satisfied — a test for the concern passes without any change, so the behavior is
      // already in place. Reply, don't commit, don't consume a round; stay open for another look.
      if (outcome.status === 'already-satisfied') {
        await reply(
          'This looks like it is already handled — a test for the concern passes without any code ' +
            'change, so no commit was made. Let me know if I misread the request.',
        );
        log.info({ runId: run.id, repo: repoLabel }, 'Fix concern already satisfied; no change');
        return;
      }

      const changed = await sandbox.readFiles(outcome.changedPaths);
      const commit = await commitTaskFiles(github, {
        installationId,
        owner,
        repo,
        issueNumber,
        files: changed,
        message: `Tsukinome: address review feedback (#${issueNumber})`,
      });
      await store.updateRunContext(run.id, { ...run.context, fix: { rounds: rounds + 1 } });
      await reply(renderFixDoneComment(commit.commitSha));
      // Stay AwaitingPrReview — the pushed commit re-runs CI and invites another look.
      log.info({ runId: run.id, repo: repoLabel, round: rounds + 1 }, 'Pushed a test-first fix');
    } finally {
      await sandbox.close();
    }
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      await reply(FIX_BUDGET_COMMENT);
      await store.updateRunState(run.id, RunState.Failed);
      log.warn({ runId: run.id, repo: repoLabel }, 'Stopped: run budget exhausted during fix');
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
