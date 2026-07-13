import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { PgVectorCodeIndex } from '../../src/index/pgvector-code-index.js';
import {
  CocoIndexSidecarRunner,
  SidecarEmbeddingProvider,
} from '../../src/index/cocoindex-runner.js';
import { namespaceFor } from '../../src/index/types.js';

const DATABASE_URL = process.env.DATABASE_URL;
// Real CocoIndex (Python + local model) — heavy and not in CI. Opt in with COCOINDEX_TEST=1
// on a machine where `sidecar/requirements.txt` is installed and DATABASE_URL has pgvector.
const ENABLED = !!DATABASE_URL && process.env.COCOINDEX_TEST === '1';

const sampleFile = `/** Compute the nth Fibonacci number iteratively. */
export function fibonacci(n: number): number {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) {
    [a, b] = [b, a + b];
  }
  return a;
}
`;

describe.skipIf(!ENABLED)('CocoIndex sidecar (integration)', () => {
  let pool: Pool;
  let dir: string;
  let index: PgVectorCodeIndex;
  const ns = namespaceFor({ owner: 'acme', repo: 'fixture', runId: 999 });

  // Point the sidecar at the venv interpreter that has the deps (matches the COCOINDEX_PYTHON
  // config knob used in production); falls back to bare python3 when unset.
  const python = process.env.COCOINDEX_PYTHON;

  beforeAll(() => {
    pool = createPool(DATABASE_URL!);
    index = new PgVectorCodeIndex(
      pool,
      new SidecarEmbeddingProvider({ python }),
      new CocoIndexSidecarRunner(DATABASE_URL!, { python }),
    );
    dir = mkdtempSync(join(tmpdir(), 'tsukinome-coco-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'fib.ts'), sampleFile);
  });

  afterAll(async () => {
    await index.dropNamespace(ns);
    rmSync(dir, { recursive: true, force: true });
    await pool.end();
  });

  it('indexes a repo and retrieves the relevant complete code unit', async () => {
    const result = await index.indexRepo({ namespace: ns, dir });
    expect(result.chunkCount).toBeGreaterThan(0);

    const [top] = await index.retrieve(ns, 'fibonacci sequence function', { topK: 3 });
    expect(top).toBeDefined();
    expect(top!.path).toContain('fib.ts');
    expect(top!.content).toContain('function fibonacci');

    await index.dropNamespace(ns);
    expect(await index.retrieve(ns, 'fibonacci')).toEqual([]);
  }, 120_000);
});
