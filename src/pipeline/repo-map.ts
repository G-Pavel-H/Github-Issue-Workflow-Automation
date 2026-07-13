import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A lightweight structural view of the target repo, given to the planning/authoring agents so they
 * reason against what actually exists — real file paths, where tests live, the package scripts —
 * instead of inventing modules or mis-guessing import depths. It is deliberately cheap (a file
 * listing + package.json), distinct from CocoIndex's semantic retrieval which supplies relevant
 * code *content*. The two are complementary: the map is structure, retrieval is depth.
 */

const DEFAULT_MAX_FILES = 400;

/** Directories whose contents are noise for planning; never listed in the map. */
const EXCLUDED_DIRS = ['node_modules/', 'dist/', 'build/', 'coverage/', '.git/', '.next/'];

/** Trim package.json to the fields an agent cares about (name, scripts, dependency names). */
function summarizePackageJson(raw: string): string {
  try {
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    for (const key of ['name', 'type', 'scripts']) {
      if (pkg[key] !== undefined) summary[key] = pkg[key];
    }
    for (const key of ['dependencies', 'devDependencies']) {
      const deps = pkg[key];
      if (deps && typeof deps === 'object') summary[key] = Object.keys(deps as object);
    }
    return JSON.stringify(summary, null, 2);
  } catch {
    return raw.slice(0, 2000); // not valid JSON — show a prefix rather than nothing
  }
}

/**
 * Render a repo map from a list of tracked file paths (+ optional package.json contents). Pure and
 * side-effect free so it is unit-testable; acquisition (git vs sandbox) is the caller's job.
 */
export function renderRepoMap(
  files: string[],
  packageJson?: string,
  opts: { maxFiles?: number } = {},
): string {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const filtered = files
    .filter((f) => f && !EXCLUDED_DIRS.some((d) => f.startsWith(d) || f.includes(`/${d}`)))
    .sort();
  const shown = filtered.slice(0, maxFiles);
  const omitted = filtered.length - shown.length;

  const sections = [`## Repository file map (${filtered.length} files)`];
  if (packageJson) {
    sections.push(`### package.json (summary)\n${summarizePackageJson(packageJson)}`);
  }
  const fileList = shown.join('\n') + (omitted > 0 ? `\n… (${omitted} more files omitted)` : '');
  sections.push(`### Files\n${fileList}`);
  return sections.join('\n\n');
}

/** List tracked files in a local checkout via `git ls-files` (fast, respects .gitignore). */
export function listTrackedFiles(dir: string): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn('git', ['ls-files'], { cwd: dir });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      resolve(stdout.split('\n').map((l) => l.trim()).filter(Boolean));
    });
  });
}

/**
 * Build the repo map for a local checkout directory. Best-effort: on any failure returns undefined
 * so the caller degrades gracefully (plans without the map) rather than failing the run.
 */
export async function buildRepoMap(dir: string, opts?: { maxFiles?: number }): Promise<string | undefined> {
  const files = await listTrackedFiles(dir);
  if (files.length === 0) return undefined;
  let packageJson: string | undefined;
  try {
    packageJson = await readFile(join(dir, 'package.json'), 'utf-8');
  } catch {
    packageJson = undefined;
  }
  return renderRepoMap(files, packageJson, opts);
}
