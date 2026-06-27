import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeCodeIndex } from './fake-code-index.js';
import { FakeEmbeddingProvider } from './fake-embedding.js';
import { namespaceFor } from '../../src/index/types.js';

const mathFile = `/** Add two numbers and return the sum. */
export function add(a: number, b: number): number {
  return a + b;
}

/** Multiply two numbers and return the product. */
export function multiply(a: number, b: number): number {
  return a * b;
}
`;

const themeFile = `/** Toggle dark mode on the document body. */
export function toggleDarkMode(enabled: boolean): void {
  document.body.classList.toggle('dark', enabled);
}
`;

describe('FakeCodeIndex (contract for the real CodeIndex)', () => {
  let dir: string;
  const index = new FakeCodeIndex(new FakeEmbeddingProvider());
  const ns = namespaceFor({ owner: 'acme', repo: 'widgets', runId: 1 });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tsukinome-idx-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'math.ts'), mathFile);
    writeFileSync(join(dir, 'src', 'theme.ts'), themeFile);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('indexes the source files into queryable chunks', async () => {
    const result = await index.indexRepo({ namespace: ns, dir });
    expect(result.fileCount).toBe(2);
    // add, multiply, toggleDarkMode — three complete units.
    expect(result.chunkCount).toBe(3);
  });

  it('a natural-language query returns the relevant, complete code unit first', async () => {
    const [top] = await index.retrieve(ns, 'add two numbers', { topK: 1 });
    expect(top).toBeDefined();
    expect(top!.path).toBe(join('src', 'math.ts'));
    // Complete, non-fragmented: the whole function (signature + body) is present.
    expect(top!.content).toContain('export function add');
    expect(top!.content).toContain('return a + b');
    // It out-ranks the unrelated theme code.
    expect(top!.content).not.toContain('toggleDarkMode');
  });

  it('supports path-prefix scoping', async () => {
    const results = await index.retrieve(ns, 'dark mode', { pathPrefix: join('src', 'theme') });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((c) => c.path.startsWith(join('src', 'theme')))).toBe(true);
  });

  it('isolates namespaces and tears them down', async () => {
    const otherNs = namespaceFor({ owner: 'acme', repo: 'widgets', runId: 2 });
    // Nothing indexed under the other namespace.
    expect(await index.retrieve(otherNs, 'add numbers')).toEqual([]);

    // Drop the populated namespace → retrieval returns nothing.
    await index.dropNamespace(ns);
    expect(await index.retrieve(ns, 'add numbers')).toEqual([]);
  });
});
