import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TOOLCHAIN,
  PYTHON,
  TOOLCHAINS,
  TYPESCRIPT_JAVASCRIPT,
  detectToolchain,
  toolchainById,
  toolchainForLanguage,
} from '../../src/toolchain/toolchain.js';

describe('typescript-javascript pack', () => {
  it('encodes the current hardcoded TS/JS behaviour', () => {
    // These are the exact commands/extensions that were hardcoded before the Toolchain
    // abstraction. Pinning them here makes the 13a refactor provably behaviour-neutral.
    expect(TYPESCRIPT_JAVASCRIPT.installCmd).toBe('npm ci');
    expect(TYPESCRIPT_JAVASCRIPT.testCmd).toBe('npm test');
    expect(TYPESCRIPT_JAVASCRIPT.projectManifest).toBe('package.json');
    expect(TYPESCRIPT_JAVASCRIPT.sourceExts).toEqual(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts']);
    expect(TYPESCRIPT_JAVASCRIPT.languages).toEqual(['typescript', 'javascript']);
    // The vitest/jest config files the test-author probe used to hardcode.
    expect(TYPESCRIPT_JAVASCRIPT.testConfigFiles).toContain('vitest.config.ts');
    expect(TYPESCRIPT_JAVASCRIPT.testConfigFiles).toContain('jest.config.js');
  });

  it('detects a repo by the presence of its manifest', () => {
    expect(TYPESCRIPT_JAVASCRIPT.detect(['src/index.ts', 'package.json'])).toBe(true);
    expect(TYPESCRIPT_JAVASCRIPT.detect(['packages/web/package.json'])).toBe(true);
    expect(TYPESCRIPT_JAVASCRIPT.detect(['main.py', 'pyproject.toml'])).toBe(false);
  });

  it('recognises its own test files and carries prompt conventions', () => {
    expect(TYPESCRIPT_JAVASCRIPT.isTestFile('test/foo.test.ts')).toBe(true);
    expect(TYPESCRIPT_JAVASCRIPT.isTestFile('src/foo.spec.tsx')).toBe(true);
    expect(TYPESCRIPT_JAVASCRIPT.isTestFile('src/foo.ts')).toBe(false);
    expect(TYPESCRIPT_JAVASCRIPT.isTestFile('tests/test_foo.py')).toBe(false);
    expect(TYPESCRIPT_JAVASCRIPT.promptConventions).toBeTruthy();
  });
});

describe('python pack', () => {
  it('uses pytest and Python project conventions', () => {
    expect(PYTHON.id).toBe('python');
    expect(PYTHON.languages).toEqual(['python']);
    expect(PYTHON.testCmd).toBe('pytest');
    expect(PYTHON.installCmd).toContain('pip');
    expect(PYTHON.projectManifest).toBe('pyproject.toml');
    expect(PYTHON.sourceExts).toEqual(['.py']);
    expect(PYTHON.promptConventions).toBeTruthy();
  });

  it('detects a Python repo by any of its project files', () => {
    expect(PYTHON.detect(['main.py', 'pyproject.toml'])).toBe(true);
    expect(PYTHON.detect(['setup.py'])).toBe(true);
    expect(PYTHON.detect(['requirements.txt'])).toBe(true);
    expect(PYTHON.detect(['src/index.ts', 'package.json'])).toBe(false);
  });

  it('recognises pytest-style test files', () => {
    expect(PYTHON.isTestFile('tests/test_foo.py')).toBe(true);
    expect(PYTHON.isTestFile('foo_test.py')).toBe(true);
    expect(PYTHON.isTestFile('conftest.py')).toBe(true);
    expect(PYTHON.isTestFile('src/foo.py')).toBe(false);
    expect(PYTHON.isTestFile('test/foo.test.ts')).toBe(false);
  });
});

describe('toolchainForLanguage', () => {
  it('resolves supported GitHub languages case-insensitively', () => {
    expect(toolchainForLanguage('TypeScript')).toBe(TYPESCRIPT_JAVASCRIPT);
    expect(toolchainForLanguage('javascript')).toBe(TYPESCRIPT_JAVASCRIPT);
    expect(toolchainForLanguage('Python')).toBe(PYTHON);
  });

  it('returns undefined for a language with no pack (so the gate refuses it)', () => {
    expect(toolchainForLanguage('Ruby')).toBeUndefined();
    expect(toolchainForLanguage('Go')).toBeUndefined();
  });

  it('falls back to the default toolchain when the language is unknown (null → proceed)', () => {
    // Mirrors the old gate: a null/blank detected language means "can't tell", so proceed.
    expect(toolchainForLanguage(null)).toBe(DEFAULT_TOOLCHAIN);
    expect(toolchainForLanguage(undefined)).toBe(DEFAULT_TOOLCHAIN);
    expect(toolchainForLanguage('')).toBe(DEFAULT_TOOLCHAIN);
  });
});

describe('detectToolchain', () => {
  it('picks the pack whose project files are present', () => {
    expect(detectToolchain(['README.md', 'package.json'])).toBe(TYPESCRIPT_JAVASCRIPT);
    expect(detectToolchain(['README.md', 'pyproject.toml'])).toBe(PYTHON);
  });

  it('returns undefined when no pack matches', () => {
    expect(detectToolchain(['main.rs', 'Cargo.toml'])).toBeUndefined();
  });
});

describe('toolchainById', () => {
  it('round-trips a pack id (used to reload the run\'s pack from context)', () => {
    expect(toolchainById('typescript-javascript')).toBe(TYPESCRIPT_JAVASCRIPT);
    expect(toolchainById('python')).toBe(PYTHON);
  });

  it('returns undefined for an unknown or missing id', () => {
    expect(toolchainById('cobol')).toBeUndefined();
    expect(toolchainById(null)).toBeUndefined();
    expect(toolchainById(undefined)).toBeUndefined();
  });
});

describe('registry', () => {
  it('lists both packs and uses TS/JS as the default', () => {
    expect(TOOLCHAINS).toContain(TYPESCRIPT_JAVASCRIPT);
    expect(TOOLCHAINS).toContain(PYTHON);
    expect(DEFAULT_TOOLCHAIN).toBe(TYPESCRIPT_JAVASCRIPT);
  });
});
