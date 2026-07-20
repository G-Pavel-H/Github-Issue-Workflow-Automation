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
  /**
   * Language-specific guidance injected into the authoring agents' prompts (test-file naming, the
   * test framework, and how imports resolve). Keeps the role instruction files language-neutral so
   * the same agents work across packs — the concrete idioms live here, per language.
   */
  promptConventions: string;
  /** True when a repo with these tracked files is this toolchain's project (a project file present). */
  detect(files: string[]): boolean;
  /** True when `path` is one of this language's test files (so example tests are found correctly). */
  isTestFile(path: string): boolean;
}

/** Does `files` contain `name` at the repo root or in any subdirectory? */
function hasFile(files: string[], name: string): boolean {
  return files.some((f) => f === name || f.endsWith(`/${name}`));
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
  promptConventions:
    '- Test files: `*.test.ts` / `*.spec.ts` (or `.js`/`.tsx`), collected per the runner config — ' +
    'usually a top-level `test/` tree mirroring the source path, or co-located under `src/`.\n' +
    '- Framework: vitest or jest (see the runner config).\n' +
    '- Imports: relative ESM imports, computed from the test file\'s own location. A test at ' +
    '`test/foo.test.ts` imports `src/foo` as `../src/foo`; at `test/sub/foo.test.ts` as `../../src/foo`.',
  detect(files) {
    return hasFile(files, this.projectManifest);
  },
  isTestFile(path) {
    // A JS/TS file in a test dir, or any file with a .test/.spec suffix. The extension guard on the
    // dir branch keeps a shared `tests/` dir from claiming another language's files.
    const inTestDir = /(^|\/)(test|tests|__tests__)\//.test(path) && /\.[cm]?[jt]sx?$/.test(path);
    return inTestDir || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
  },
};

/**
 * Python pack: pytest over pip. The install command is best-effort across the common project shapes
 * (editable install if there's a build config, else `requirements.txt`) and always ensures pytest is
 * present, since `testCmd` is `pytest`. The sandbox image must carry a Python runtime (see docs/setup).
 */
export const PYTHON: Toolchain = {
  id: 'python',
  displayName: 'Python',
  languages: ['python'],
  installCmd:
    'python -m pip install --quiet --upgrade pip && ' +
    '(pip install --quiet -e . || pip install --quiet -r requirements.txt || true) && ' +
    'pip install --quiet pytest',
  testCmd: 'pytest',
  testConfigFiles: ['pyproject.toml', 'pytest.ini', 'tox.ini', 'setup.cfg', 'conftest.py'],
  projectManifest: 'pyproject.toml',
  sourceExts: ['.py'],
  promptConventions:
    '- Test files: `test_*.py` or `*_test.py`, collected by pytest — usually under a `tests/` ' +
    'directory or alongside the module under test.\n' +
    '- Framework: pytest with plain `assert` statements (no test classes required).\n' +
    '- Imports: import the module under test by its package/module path exactly as the repo\'s ' +
    'existing tests do (e.g. `from mypkg.foo import bar`, or `import foo` for a flat layout). Match ' +
    'the example test files\' import style — do not invent a package path that does not exist.',
  detect(files) {
    return (
      hasFile(files, 'pyproject.toml') ||
      hasFile(files, 'setup.py') ||
      hasFile(files, 'setup.cfg') ||
      hasFile(files, 'requirements.txt')
    );
  },
  isTestFile(path) {
    return (
      (/(^|\/)tests?\//.test(path) && path.endsWith('.py')) ||
      /(^|\/)test_[^/]*\.py$/.test(path) ||
      /_test\.py$/.test(path) ||
      /(^|\/)conftest\.py$/.test(path)
    );
  },
};

/** Every registered language pack. Add a pack here to make it selectable. */
export const TOOLCHAINS: readonly Toolchain[] = [TYPESCRIPT_JAVASCRIPT, PYTHON];

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

/** Resolve a pack from its stored `id` (persisted on the run so later phases reload the same pack). */
export function toolchainById(id: string | null | undefined): Toolchain | undefined {
  if (!id) return undefined;
  return TOOLCHAINS.find((t) => t.id === id);
}
