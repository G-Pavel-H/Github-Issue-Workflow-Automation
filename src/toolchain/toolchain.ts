/**
 * A `Toolchain` is a language "pack": everything that varies between a TypeScript repo and a Python
 * (or Go, Java, …) repo, gathered behind one interface so the sandbox runner, the test-conventions
 * probe, the repo map, the code index and the agent prompts read it instead of hardcoding `npm`.
 *
 * Phase 13a introduces the abstraction and moves the previously-hardcoded TS/JS behaviour behind the
 * single {@link TYPESCRIPT_JAVASCRIPT} pack — a behaviour-neutral refactor. Phase 13b adds the first
 * non-TS pack (Python) and wires per-run selection through the pipeline.
 */
export interface Toolchain {
  /** Stable identifier, e.g. `typescript-javascript`. */
  id: string;
  /** Human label for issue comments and logs. */
  displayName: string;
  /** GitHub linguist language names this pack handles, lowercased. */
  languages: string[];
  /** Command that installs dependencies in the checkout root. */
  installCmd: string;
  /** Command that runs the repo's test suite. */
  testCmd: string;
  /**
   * Candidate test-runner config files, in priority order, surfaced to the test-author so it places
   * new tests where the runner will actually collect them.
   */
  testConfigFiles: string[];
  /** The project manifest whose contents describe the project + test script (e.g. `package.json`). */
  projectManifest: string;
  /** Source-file extensions this pack indexes. Keep in sync with the CocoIndex sidecar's SOURCE_EXT. */
  sourceExts: string[];
  /** Optional sandbox template override; unset → the process-level `E2B_TEMPLATE` / base image. */
  sandboxTemplate?: string;
  /** True when a repo with these tracked files is this toolchain's project (manifest present). */
  detect(files: string[]): boolean;
}

/** Does `files` contain `manifest` at the repo root or in any subdirectory? */
function hasManifest(files: string[], manifest: string): boolean {
  return files.some((f) => f === manifest || f.endsWith(`/${manifest}`));
}

/**
 * The one and only pack for the MVP: TypeScript / JavaScript. Every field here is the exact value
 * that used to be hardcoded across `code-sandbox.ts`, `run-tests.ts`, the `readTestConventions`
 * probe and the sidecar, so routing through it changes nothing.
 */
export const TYPESCRIPT_JAVASCRIPT: Toolchain = {
  id: 'typescript-javascript',
  displayName: 'TypeScript / JavaScript',
  languages: ['typescript', 'javascript'],
  installCmd: 'npm ci',
  testCmd: 'npm test',
  testConfigFiles: [
    'vitest.config.ts',
    'vitest.config.js',
    'vitest.config.mts',
    'vitest.config.mjs',
    'vite.config.ts',
    'vite.config.js',
    'jest.config.ts',
    'jest.config.js',
    'jest.config.cjs',
    'jest.config.mjs',
    'jest.config.json',
  ],
  projectManifest: 'package.json',
  sourceExts: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'],
  detect(files) {
    return hasManifest(files, this.projectManifest);
  },
};

/** Every registered language pack. Add a pack here to make it selectable. */
export const TOOLCHAINS: readonly Toolchain[] = [TYPESCRIPT_JAVASCRIPT];

/** Used when a repo's language can't be determined — preserves the old "null language → proceed". */
export const DEFAULT_TOOLCHAIN: Toolchain = TYPESCRIPT_JAVASCRIPT;

/**
 * Resolve a pack from a GitHub-detected primary language. A blank/unknown language returns the
 * default (we can't tell → proceed, matching the pre-13a gate); a known-but-unsupported language
 * returns `undefined` so the caller refuses gracefully.
 */
export function toolchainForLanguage(language: string | null | undefined): Toolchain | undefined {
  if (language == null || language.trim() === '') return DEFAULT_TOOLCHAIN;
  const lc = language.toLowerCase();
  return TOOLCHAINS.find((t) => t.languages.includes(lc));
}

/**
 * Resolve a pack from the repo's actual tracked files (manifest presence). Content-based detection
 * is more reliable than GitHub's byte-count primary language for polyglot repos; returns `undefined`
 * when no pack's project files are present.
 */
export function detectToolchain(files: string[]): Toolchain | undefined {
  return TOOLCHAINS.find((t) => t.detect(files));
}
