import type { Logger } from '../log.js';
import { DEFAULT_TOOLCHAIN, type Toolchain } from '../toolchain/toolchain.js';
import type {
  CommandResult,
  SandboxProvider,
  TestFailureStage,
  TestRunResult,
} from './types.js';

export interface RunTestsInput {
  /** Least-privilege installation token, used only as the git clone credential. */
  token: string;
  owner: string;
  repo: string;
  ref: string;
}

export interface RunTestsDeps {
  sandboxProvider: SandboxProvider;
  log: Logger;
  /** Hard timeout for the sandbox and the install/test commands. */
  timeoutMs?: number;
  /** Language pack driving the install/test commands. Defaults to TypeScript/JavaScript. */
  toolchain?: Toolchain;
}

export const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL_CAP = 4000;
const CLONE_DIR = 'repo';

function tail(...parts: string[]): string {
  const combined = parts.filter(Boolean).join('\n');
  return combined.length > OUTPUT_TAIL_CAP ? combined.slice(-OUTPUT_TAIL_CAP) : combined;
}

function errorResult(
  stage: TestFailureStage,
  command: string,
  result: CommandResult | null,
  durationMs: number,
  output: string,
): TestRunResult {
  return {
    status: 'error',
    passed: false,
    exitCode: result ? result.exitCode : null,
    durationMs,
    command,
    failureStage: stage,
    outputTail: tail(output),
  };
}

/**
 * Clone the target repo into an ephemeral sandbox, install deps, run its test
 * suite, and return a structured result. The sandbox is **always** torn down via
 * `finally`, and the clone credential never appears in the returned `command`.
 * Non-zero test exits return `failed` (not a throw); infra failures return `error`.
 */
export async function runTests(input: RunTestsInput, deps: RunTestsDeps): Promise<TestRunResult> {
  const { sandboxProvider, log } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const toolchain = deps.toolchain ?? DEFAULT_TOOLCHAIN;
  const { token, owner, repo, ref } = input;

  const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  // Redacted label for logs/persistence — the real command embeds the token.
  const cloneLabel = `git clone github.com/${owner}/${repo} (ref ${ref})`;

  const start = Date.now();
  const handle = await sandboxProvider.create({ timeoutMs });

  try {
    const clone = await handle.runCommand(
      `git clone ${cloneUrl} ${CLONE_DIR} && cd ${CLONE_DIR} && git checkout ${ref}`,
      { timeoutMs },
    );
    if (clone.exitCode !== 0) {
      return errorResult('clone', cloneLabel, clone, Date.now() - start, clone.stderr || clone.stdout);
    }

    const install = await handle.runCommand(toolchain.installCmd, { cwd: CLONE_DIR, timeoutMs });
    if (install.exitCode !== 0) {
      return errorResult('install', toolchain.installCmd, install, Date.now() - start, tail(install.stdout, install.stderr));
    }

    const testStart = Date.now();
    const test = await handle.runCommand(toolchain.testCmd, { cwd: CLONE_DIR, timeoutMs });
    const durationMs = Date.now() - testStart;
    const passed = test.exitCode === 0;

    return {
      status: passed ? 'passed' : 'failed',
      passed,
      exitCode: test.exitCode,
      durationMs,
      command: toolchain.testCmd,
      failureStage: passed ? undefined : 'test',
      outputTail: tail(test.stdout, test.stderr),
    };
  } catch (err) {
    // Unexpected sandbox/infra error mid-run — surface cleanly, never crash the worker.
    const message = err instanceof Error ? err.message : String(err);
    log.error({ owner, repo, ref, err: message }, 'Sandbox error during runTests');
    return errorResult('test', toolchain.testCmd, null, Date.now() - start, message);
  } finally {
    try {
      await handle.kill();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ sandboxId: handle.id, err: message }, 'Failed to tear down sandbox');
    }
  }
}
