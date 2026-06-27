import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CloneInput {
  /** Least-privilege installation token (contents:read), used only as the clone credential. */
  token: string;
  owner: string;
  repo: string;
  ref: string;
}

export interface Checkout {
  /** Host temp dir containing the working tree. */
  dir: string;
  /** Remove the checkout. Safe to call once; always call after indexing. */
  cleanup(): void;
}

/** Replace the access token anywhere it appears, so it never reaches a log or error. */
export function redactToken(text: string, token: string): string {
  return token ? text.split(token).join('***') : text;
}

/**
 * Clone a repo into a fresh host temp dir for indexing. The working tree is only READ
 * (chunked + embedded) — repo code is never executed here (that stays in the E2B sandbox,
 * Phase 2). The clone credential is redacted from any error. Caller must `cleanup()`.
 */
export async function cloneToTempDir(input: CloneInput): Promise<Checkout> {
  const { token, owner, repo, ref } = input;
  const dir = mkdtempSync(join(tmpdir(), 'tsukinome-clone-'));
  const url = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });

  try {
    await git(['clone', url, dir], token);
    await git(['-C', dir, 'checkout', ref], token);
    return { dir, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

function git(args: string[], token: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args);
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`git ${args[0]} failed (${code}): ${redactToken(stderr.slice(-2000), token)}`));
    });
  });
}
