import type { Logger } from '../log.js';
import { DEFAULT_TOOLCHAIN, type Toolchain } from '../toolchain/toolchain.js';
import type { SandboxHandle, SandboxProvider, TestRunResult } from './types.js';

/**
 * A persistent sandbox session for the TDD loop: clone + install once, then write
 * agent-produced files, run the suite, and read files back, iteratively. Built on the
 * Phase-2 `SandboxProvider`/`runCommand` (base64 file transfer — no new handle methods).
 * The real impl is E2B-backed and gated; the TDD engine consumes this interface and is
 * unit-tested with a fake.
 */
export interface CodeSandbox {
  /** Write whole files into the checkout (creating dirs as needed). */
  writeFiles(files: { path: string; content: string }[]): Promise<void>;
  /** Run the repo's test suite over the current working tree. */
  runTests(): Promise<TestRunResult>;
  /** Read files back from the checkout (missing files are omitted). */
  readFiles(paths: string[]): Promise<{ path: string; content: string }[]>;
  /** List the checkout's tracked files (repo-relative paths), for repo-map / example lookups. */
  listFiles(): Promise<string[]>;
  /** Tear the sandbox down. Safe to call once. */
  close(): Promise<void>;
}

export interface OpenCodeSandboxInput {
  /** Least-privilege installation token, used only as the clone credential. */
  token: string;
  owner: string;
  repo: string;
  ref: string;
}

export interface OpenCodeSandboxDeps {
  sandboxProvider: SandboxProvider;
  log: Logger;
  timeoutMs?: number;
  /** Language pack driving the install/test commands. Defaults to TypeScript/JavaScript. */
  toolchain?: Toolchain;
}

const CLONE_DIR = 'repo';
const OUTPUT_TAIL_CAP = 4000;
export const DEFAULT_SESSION_TIMEOUT_MS = 5 * 60_000;

function tail(...parts: string[]): string {
  const combined = parts.filter(Boolean).join('\n');
  return combined.length > OUTPUT_TAIL_CAP ? combined.slice(-OUTPUT_TAIL_CAP) : combined;
}

function redact(text: string, token: string): string {
  return token ? text.split(token).join('***') : text;
}

/** Classify a raw test-command result into our pass/fail vocabulary. */
export function classifyTestRun(
  exitCode: number,
  durationMs: number,
  stdout: string,
  stderr: string,
  command: string = DEFAULT_TOOLCHAIN.testCmd,
): TestRunResult {
  const passed = exitCode === 0;
  return {
    status: passed ? 'passed' : 'failed',
    passed,
    exitCode,
    durationMs,
    command,
    failureStage: passed ? undefined : 'test',
    outputTail: tail(stdout, stderr),
  };
}

/**
 * Open a code session: spin up a sandbox, clone the ref, and install deps. Throws on a
 * clone/install failure (the credential is redacted from the message) after tearing the
 * sandbox down, so the caller never holds a half-open session.
 */
export type OpenCodeSandboxFn = (
  input: OpenCodeSandboxInput,
  deps: OpenCodeSandboxDeps,
) => Promise<CodeSandbox>;

export async function openCodeSandbox(
  input: OpenCodeSandboxInput,
  deps: OpenCodeSandboxDeps,
): Promise<CodeSandbox> {
  const { sandboxProvider } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
  const toolchain = deps.toolchain ?? DEFAULT_TOOLCHAIN;
  const { token, owner, repo, ref } = input;

  const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  const handle: SandboxHandle = await sandboxProvider.create({ timeoutMs });

  try {
    const clone = await handle.runCommand(
      `git clone ${cloneUrl} ${CLONE_DIR} && cd ${CLONE_DIR} && git checkout ${ref}`,
      { timeoutMs },
    );
    if (clone.exitCode !== 0) {
      throw new Error(`clone failed: ${redact(clone.stderr || clone.stdout, token)}`);
    }
    const install = await handle.runCommand(toolchain.installCmd, { cwd: CLONE_DIR, timeoutMs });
    if (install.exitCode !== 0) {
      throw new Error(`${toolchain.installCmd} failed: ${tail(install.stdout, install.stderr)}`);
    }
  } catch (err) {
    await handle.kill().catch(() => {});
    throw err;
  }

  return {
    async writeFiles(files) {
      for (const f of files) {
        const b64 = Buffer.from(f.content, 'utf-8').toString('base64');
        const full = `${CLONE_DIR}/${f.path}`;
        const cmd = `mkdir -p "$(dirname '${full}')" && printf '%s' '${b64}' | base64 -d > '${full}'`;
        const res = await handle.runCommand(cmd, { timeoutMs });
        if (res.exitCode !== 0) throw new Error(`writeFile ${f.path} failed: ${res.stderr}`);
      }
    },

    async runTests() {
      const start = Date.now();
      const res = await handle.runCommand(toolchain.testCmd, { cwd: CLONE_DIR, timeoutMs });
      return classifyTestRun(res.exitCode, Date.now() - start, res.stdout, res.stderr, toolchain.testCmd);
    },

    async readFiles(paths) {
      const out: { path: string; content: string }[] = [];
      for (const p of paths) {
        const res = await handle.runCommand(`base64 '${CLONE_DIR}/${p}'`, { timeoutMs });
        if (res.exitCode !== 0) continue; // file does not exist yet — skip
        out.push({ path: p, content: Buffer.from(res.stdout.trim(), 'base64').toString('utf-8') });
      }
      return out;
    },

    async listFiles() {
      const res = await handle.runCommand('git ls-files', { cwd: CLONE_DIR, timeoutMs });
      if (res.exitCode !== 0) return [];
      return res.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    },

    async close() {
      await handle.kill();
    },
  };
}
