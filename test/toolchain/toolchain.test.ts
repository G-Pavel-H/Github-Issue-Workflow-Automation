import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TOOLCHAIN,
  TOOLCHAINS,
  TYPESCRIPT_JAVASCRIPT,
  detectToolchain,
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
});

describe('toolchainForLanguage', () => {
  it('resolves supported GitHub languages case-insensitively', () => {
    expect(toolchainForLanguage('TypeScript')).toBe(TYPESCRIPT_JAVASCRIPT);
    expect(toolchainForLanguage('javascript')).toBe(TYPESCRIPT_JAVASCRIPT);
  });

  it('returns undefined for a language with no pack (so the gate refuses it)', () => {
    expect(toolchainForLanguage('Python')).toBeUndefined();
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
  });

  it('returns undefined when no pack matches', () => {
    expect(detectToolchain(['main.rs', 'Cargo.toml'])).toBeUndefined();
  });
});

describe('registry', () => {
  it('lists the TS/JS pack and uses it as the default', () => {
    expect(TOOLCHAINS).toContain(TYPESCRIPT_JAVASCRIPT);
    expect(DEFAULT_TOOLCHAIN).toBe(TYPESCRIPT_JAVASCRIPT);
  });
});
