import { runAgent } from '../agents/runner.js';
import { BudgetExhaustedError, type LlmGateway } from '../llm/gateway.js';
import type { ModelTier } from '../llm/models.js';
import type { Logger } from '../log.js';
import type { CodeSandbox } from '../sandbox/code-sandbox.js';
import { DEFAULT_TOOLCHAIN, type Toolchain } from '../toolchain/toolchain.js';
import { renderRepoMap } from './repo-map.js';
import type { FileEdit, FileSet, TaskList } from './schemas.js';

/** A file looks like a test if it lives in a test dir or carries a .test/.spec suffix. */
function isTestFile(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

/**
 * Gather cheap repo context for the authoring agents from the (already-cloned) sandbox: a structural
 * file map + a couple of real example test files. The examples are the load-bearing fix for wrong
 * import paths — the author copies the exact import style/depth from a real test instead of guessing.
 */
async function gatherRepoContext(
  sandbox: CodeSandbox,
  maxExamples = 2,
): Promise<{ repoMap: string; exampleTests: { path: string; content: string }[] }> {
  const files = await sandbox.listFiles().catch(() => [] as string[]);
  const [pkg] = await sandbox.readFiles(['package.json']).catch(() => []);
  const repoMap = files.length ? renderRepoMap(files, pkg?.content) : '';
  const exampleTests = files.length
    ? await sandbox.readFiles(files.filter(isTestFile).slice(0, maxExamples))
    : [];
  return { repoMap, exampleTests };
}

export type TaskSpec = TaskList['tasks'][number];

/**
 * Escalation ladder: try the cheap model (Sonnet) a couple of times, then escalate to a human.
 * Opus is intentionally NOT in the ladder — it's too expensive for the current stage, and a task
 * Sonnet can't land twice (with the failure output fed back on the retry) is usually a context or
 * spec problem a human should look at, not something a pricier model will brute-force. Extra
 * attempts only fire on failure, so a task that greens on the first try costs the same.
 */
export const SONNET_ATTEMPTS = 2;
export const OPUS_ATTEMPTS = 0;
const LADDER: (ModelTier | undefined)[] = [
  ...Array<undefined>(SONNET_ATTEMPTS).fill(undefined), // role default tier (implementation/Sonnet)
  ...Array<ModelTier>(OPUS_ATTEMPTS).fill('review'), // (disabled) promote to Opus
];

export interface TddContext {
  sandbox: CodeSandbox;
  gateway: LlmGateway;
  runId: number;
  log: Logger;
  specMarkdown: string;
  planMarkdown: string;
  /** Paths the plan touches — read from the sandbox to give agents real file context. */
  affectedPaths: string[];
  /**
   * The target repo's test-runner configuration (e.g. `vitest.config.ts` contents), so the
   * test-author places new test files where the runner will actually collect them. A test the
   * runner never picks up passes vacuously and can never go red — the #1 cause of test-stage stalls.
   */
  testConventions?: string;
  /**
   * Optional maintainer guidance from the "stuck" gate (e.g. "that acceptance criterion is wrong,
   * drop its test"). Authoritative for this task — but the red→green gate still holds, so the
   * (possibly reduced) suite must pass; guidance can never force a non-green commit.
   */
  humanGuidance?: string;
}

export interface TaskOutcome {
  /**
   * `done` — implemented red→green. `already-satisfied` — the task's tests passed before any
   * implementation with the suite green, i.e. the behavior already exists (a redundant task or one
   * an earlier task delivered); nothing to commit, not a failure. `escalated` — stalled, needs a human.
   */
  status: 'done' | 'escalated' | 'already-satisfied';
  /** Which stage failed, when escalated. */
  stage?: 'test' | 'impl';
  redObserved: boolean;
  greenObserved: boolean;
  /** Paths touched across the task (re-read + committed by the caller). */
  changedPaths: string[];
  /** On escalation: the tail of the last test run, so a human sees *why* it stalled. */
  lastFailureOutput?: string;
}

/** Break the approved plan into small, independently testable tasks. */
export async function decompose(
  specMarkdown: string,
  planMarkdown: string,
  ctx: { runId: number; gateway: LlmGateway; log: Logger },
): Promise<TaskSpec[]> {
  const result = await runAgent<TaskList>(
    'decomposer',
    { messages: [{ role: 'user', content: `Spec:\n${specMarkdown}\n\nPlan:\n${planMarkdown}` }] },
    ctx,
  );
  return result.output!.tasks;
}

/**
 * Read the target repo's test-runner configuration from the sandbox so the test-author places new
 * test files where the runner will actually collect them. Prefers a dedicated config file; falls
 * back to package.json (which may carry a `jest` key + the test script). Returns undefined if none.
 */
export async function readTestConventions(
  sandbox: CodeSandbox,
  toolchain: Toolchain = DEFAULT_TOOLCHAIN,
): Promise<string | undefined> {
  const found = await sandbox.readFiles(toolchain.testConfigFiles);
  if (found.length > 0) {
    return found.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n');
  }
  const [manifest] = await sandbox.readFiles([toolchain.projectManifest]);
  return manifest ? `--- ${manifest.path} ---\n${manifest.content}` : undefined;
}

function renderFiles(files: { path: string; content: string }[]): string {
  if (files.length === 0) return '(none yet)';
  return files.map((f) => `--- ${f.path} ---\n${f.content}`).join('\n\n');
}

/**
 * Render example tests as just their file path + import lines, not the whole file body. The author
 * only needs the repo's exact import style and relative-path depth; the bodies were dead weight that
 * got re-billed (uncached) on every ladder attempt of every task.
 */
function renderExampleImports(files: { path: string; content: string }[]): string {
  return files
    .map((f) => {
      const imports = f.content
        .split('\n')
        .filter((l) => /^\s*(import\b|export\b[^\n]*\bfrom\b|(?:const|let|var)\b[^\n]*\brequire\()/.test(l))
        .join('\n');
      return `--- ${f.path} ---\n${imports || '(no imports)'}`;
    })
    .join('\n\n');
}

function taskHeader(task: TaskSpec): string {
  return (
    `Task ${task.id}: ${task.title}\n${task.description}\n\n` +
    `Acceptance criteria:\n${task.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
  );
}

/**
 * Run the TDD trio for one task with a code-enforced ordering: tests must be observed
 * **red** before implementation, then the implementation must make the full suite **green**;
 * a best-effort refactor must keep it green or is reverted. Each stage retries on the cheap
 * model, then promotes to Opus, then **escalates** (no infinite loop). Budget errors
 * propagate to the caller for a graceful stop.
 */
export async function runTaskTdd(task: TaskSpec, ctx: TddContext): Promise<TaskOutcome> {
  const { sandbox, gateway, runId, log } = ctx;
  const agentCtx = { runId, gateway, log };
  const touched = new Set<string>();
  const guidanceBlock = ctx.humanGuidance
    ? `\n\n## Maintainer guidance (authoritative — a human reviewed a stalled attempt)\n` +
      `${ctx.humanGuidance}\n\n` +
      `Follow this guidance. If it says an acceptance criterion or a specific test is wrong, drop or ` +
      `adjust exactly that test — but every remaining test must still pass. Do NOT weaken or delete ` +
      `tests merely to make the suite go green.`
    : '';
  const specPlan = `Spec:\n${ctx.specMarkdown}\n\nPlan:\n${ctx.planMarkdown}`;
  // The per-task tail appended to the cached prefix on the author/implementer/refactor calls: the task header
  // + maintainer guidance are task-specific, so they live in the uncached tail, after the run-stable
  // prefix, so the prefix caches across every task rather than being invalidated by each task header.
  const taskTail = `\n\n${taskHeader(task)}${guidanceBlock}`;

  // Repo structure + real example tests, so the authoring agents see what exists and copy the
  // repo's exact import style/depth instead of guessing (the #1 cause of unresolvable-import stalls).
  const { repoMap, exampleTests } = await gatherRepoContext(sandbox);
  const repoMapBlock = repoMap ? `\n\n${repoMap}` : '';

  // --- Test Author: write tests that FAIL now (red). A test that passes pre-impl is rejected. ---
  const conventionsBlock = ctx.testConventions
    ? `\n\n## Repo test-runner config (place new test files where this will collect them):\n` +
      `${ctx.testConventions}\n` +
      `If it only collects a top-level test/ tree, put your file there (mirroring the source path), ` +
      `NOT co-located under src/ — a test the runner never collects can never go red.`
    : '';
  const exampleTestsBlock = exampleTests.length
    ? `\n\n## Example test imports from this repo (copy their import style + relative-path depth exactly):\n` +
      `${renderExampleImports(exampleTests)}`
    : '';
  // The load-bearing rule: an unresolvable import is a FALSE red the implementer can never fix.
  const importRule =
    `\n\n## Imports MUST resolve\n` +
    `Compute each relative import from YOUR test file's own location to the target module. E.g. a ` +
    `test at \`test/foo.test.ts\` imports \`src/foo\` as \`../src/foo\`; a test at ` +
    `\`test/sub/foo.test.ts\` imports it as \`../../src/foo\`. Match the example files above. A test ` +
    `that fails only because an import can't be resolved is a FALSE red: it looks like TDD red, but ` +
    `the implementer cannot fix it (it may not edit tests). Import the not-yet-existing module at the ` +
    `path the plan specifies, resolved correctly from where you place the test.`
  // Run-stable prefix — identical across every task and every ladder attempt, so mark it for prompt
  // caching (a cache breakpoint after the system prefix). Only the variable tail below is re-billed.
  const authorStablePrefix = `${specPlan}${repoMapBlock}${conventionsBlock}${exampleTestsBlock}${importRule}`;
  let testFiles: FileEdit[] = [];
  let redObserved = false;
  let suitePassedPreImpl = false; // saw the suite green WITH the author's tests present
  let lastNotRedOutput = '';
  for (const tier of LADDER) {
    const current = await sandbox.readFiles(ctx.affectedPaths);
    const feedback = lastNotRedOutput
      ? `\n\nYour previous tests PASSED with no implementation, so they must fail first (TDD). ` +
        `Test runner output (tail):\n${lastNotRedOutput}\n` +
        `If the task's behavior does NOT yet exist, write tests that assert it so they fail now (also ` +
        `check the test file's location/naming against the repo config so the runner collects it). ` +
        `If the behavior genuinely ALREADY exists (an earlier task delivered it), the task is redundant.`
      : '';
    const out = await runAgent<FileSet>(
      'test-author',
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: authorStablePrefix, cacheControl: 'ephemeral' },
              { type: 'text', text: `${taskTail}\n\nCurrent files:\n${renderFiles(current)}${feedback}` },
            ],
          },
        ],
        tierOverride: tier,
      },
      agentCtx,
    );
    testFiles = out.output!.files;
    if (testFiles.length === 0) continue; // produced no tests — retry
    await sandbox.writeFiles(testFiles);
    const result = await sandbox.runTests();
    if (result.status === 'failed') {
      redObserved = true; // good: the new tests fail before any implementation
      break;
    }
    suitePassedPreImpl = true; // suite is green with these tests present → behavior already exists
    lastNotRedOutput = result.outputTail;
    log.info({ runId, task: task.id, status: result.status }, 'Test-author tests did not go red; retrying');
  }
  if (!redObserved) {
    // The tests never went red. If the suite is green with the author's tests present, the behavior
    // already exists (a redundant task / one an earlier task delivered): mark it done and skip —
    // nothing to implement or commit — rather than dead-ending the run. Otherwise (no tests were
    // ever produced) we can't confirm anything: escalate.
    if (suitePassedPreImpl) {
      log.info({ runId, task: task.id }, 'Task already satisfied (tests green pre-impl); skipping');
      return { status: 'already-satisfied', redObserved: false, greenObserved: true, changedPaths: [] };
    }
    testFiles.forEach((f) => touched.add(f.path));
    return { status: 'escalated', stage: 'test', redObserved: false, greenObserved: false, changedPaths: [...touched], lastFailureOutput: lastNotRedOutput };
  }
  testFiles.forEach((f) => touched.add(f.path));

  // --- Implementer: minimum code so the new tests pass AND the full suite stays green. ---
  // Same caching split: spec + plan + repo map are run-stable (cached); the task header, the failing
  // tests, the current files and the retry feedback are the variable tail.
  const implStablePrefix = `${specPlan}${repoMapBlock}`;
  let greenObserved = false;
  let lastFailureOutput = '';
  for (const tier of LADDER) {
    const current = await sandbox.readFiles(ctx.affectedPaths);
    const feedback = lastFailureOutput
      ? `\n\nYour previous implementation attempt did NOT make the suite green. ` +
        `Test runner output (tail):\n${lastFailureOutput}\n` +
        `Study the failure above and fix the implementation so every test passes. Do not modify the tests.`
      : '';
    const out = await runAgent<FileSet>(
      'implementer',
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: implStablePrefix, cacheControl: 'ephemeral' },
              {
                type: 'text',
                text:
                  `${taskTail}\n\nFailing tests:\n${renderFiles(testFiles)}\n\n` +
                  `Current files:\n${renderFiles(current)}${feedback}`,
              },
            ],
          },
        ],
        tierOverride: tier,
      },
      agentCtx,
    );
    const implFiles = out.output!.files;
    await sandbox.writeFiles(implFiles);
    implFiles.forEach((f) => touched.add(f.path));
    const result = await sandbox.runTests();
    if (result.status === 'passed') {
      greenObserved = true;
      break;
    }
    lastFailureOutput = result.outputTail;
    log.info({ runId, task: task.id, status: result.status }, 'Implementation not green; retrying');
  }
  if (!greenObserved) {
    return { status: 'escalated', stage: 'impl', redObserved: true, greenObserved: false, changedPaths: [...touched], lastFailureOutput };
  }

  // --- Refactor (best-effort): clean up while keeping green; revert if it breaks. ---
  try {
    const greenSnapshot = await sandbox.readFiles([...touched]);
    const out = await runAgent<FileSet>(
      'refactor',
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `${specPlan}${repoMapBlock}`, cacheControl: 'ephemeral' },
              { type: 'text', text: `${taskTail}\n\nCurrent files:\n${renderFiles(greenSnapshot)}` },
            ],
          },
        ],
      },
      agentCtx,
    );
    const refFiles = out.output!.files;
    if (refFiles.length > 0) {
      await sandbox.writeFiles(refFiles);
      const result = await sandbox.runTests();
      if (result.status === 'passed') {
        refFiles.forEach((f) => touched.add(f.path));
      } else {
        await sandbox.writeFiles(greenSnapshot); // revert — keep the green state
        log.info({ runId, task: task.id }, 'Refactor broke tests; reverted');
      }
    }
  } catch (err) {
    if (err instanceof BudgetExhaustedError) throw err; // budget is not best-effort
    log.info({ runId, task: task.id }, 'Refactor step failed; keeping green implementation');
  }

  return { status: 'done', redObserved: true, greenObserved: true, changedPaths: [...touched] };
}
