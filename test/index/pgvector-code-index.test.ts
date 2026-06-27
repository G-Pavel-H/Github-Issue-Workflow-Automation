import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { PgVectorCodeIndex, toVectorLiteral } from '../../src/index/pgvector-code-index.js';
import type { CocoIndexRunner } from '../../src/index/cocoindex-runner.js';
import { FakeEmbeddingProvider } from './fake-embedding.js';

const DATABASE_URL = process.env.DATABASE_URL;

interface SeedChunk {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
}

// Ingestion (the CocoIndex sidecar) is gated separately; here we insert chunks directly
// with the fake embedder so the real pgvector retrieval/scoping/teardown is model-agnostic
// and runs in CI (pgvector image). Skipped locally without DATABASE_URL.
describe.skipIf(!DATABASE_URL)('PgVectorCodeIndex (integration, pgvector)', () => {
  let pool: Pool;
  let index: PgVectorCodeIndex;
  const embedder = new FakeEmbeddingProvider();
  // retrieve/drop don't touch the sidecar; fail loudly if they ever do.
  const runner: CocoIndexRunner = {
    index: () => Promise.reject(new Error('sidecar must not be called in this test')),
  };

  async function seed(namespace: string, chunks: SeedChunk[]): Promise<void> {
    const embeddings = await embedder.embed(chunks.map((c) => c.content));
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      await pool.query(
        `INSERT INTO code_chunks (namespace, path, start_line, end_line, content, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)`,
        [namespace, c.path, c.startLine, c.endLine, c.content, toVectorLiteral(embeddings[i]!)],
      );
    }
  }

  beforeAll(() => {
    pool = createPool(DATABASE_URL!);
    index = new PgVectorCodeIndex(pool, embedder, runner);
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE code_chunks RESTART IDENTITY');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('ranks chunks by cosine similarity to the query', async () => {
    await seed('ns-a', [
      { path: 'src/math.ts', startLine: 1, endLine: 3, content: 'add two numbers and return the sum' },
      { path: 'src/theme.ts', startLine: 1, endLine: 3, content: 'toggle dark mode on the document body' },
    ]);

    const results = await index.retrieve('ns-a', 'add two numbers', { topK: 2 });
    expect(results[0]!.path).toBe('src/math.ts');
    expect(results[0]!.score!).toBeGreaterThan(results[1]!.score!);
  });

  it('scopes retrieval to a namespace (no cross-repo leakage)', async () => {
    await seed('ns-a', [{ path: 'a.ts', startLine: 1, endLine: 1, content: 'add two numbers' }]);
    await seed('ns-b', [{ path: 'b.ts', startLine: 1, endLine: 1, content: 'add two numbers' }]);

    const results = await index.retrieve('ns-a', 'add two numbers');
    expect(results).toHaveLength(1);
    expect(results[0]!.path).toBe('a.ts');
  });

  it('supports path-prefix scoping', async () => {
    await seed('ns-a', [
      { path: 'src/keep.ts', startLine: 1, endLine: 1, content: 'add two numbers' },
      { path: 'test/skip.ts', startLine: 1, endLine: 1, content: 'add two numbers' },
    ]);

    const results = await index.retrieve('ns-a', 'add two numbers', { pathPrefix: 'src/' });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((c) => c.path.startsWith('src/'))).toBe(true);
  });

  it('dropNamespace tears down all vectors for the namespace', async () => {
    await seed('ns-a', [{ path: 'a.ts', startLine: 1, endLine: 1, content: 'add two numbers' }]);
    await index.dropNamespace('ns-a');
    expect(await index.retrieve('ns-a', 'add two numbers')).toEqual([]);
  });
});
