import type { Pool } from 'pg';
import {
  DEFAULT_TOP_K,
  type CodeChunk,
  type CodeIndex,
  type EmbeddingProvider,
  type IndexRepoInput,
  type IndexRepoResult,
  type RetrieveOptions,
} from './types.js';
import type { CocoIndexRunner } from './cocoindex-runner.js';

/** Serialize a number[] into pgvector's text literal form, e.g. `[0.1,0.2,...]`. */
export function toVectorLiteral(values: number[]): string {
  return `[${values.join(',')}]`;
}

/**
 * The real {@link CodeIndex}: ingestion via the CocoIndex sidecar (writes namespaced
 * rows into `code_chunks`), retrieval as a pgvector cosine-ANN query owned in TS. One
 * namespace per run keeps retrieval scoped; `dropNamespace` is the per-run teardown.
 *
 * The query is embedded by the injected `EmbeddingProvider`, which MUST be the same
 * model the sidecar used to embed documents (shared vector space) — see EMBEDDING_MODEL.
 */
export class PgVectorCodeIndex implements CodeIndex {
  constructor(
    private readonly pool: Pool,
    private readonly embedder: EmbeddingProvider,
    private readonly runner: CocoIndexRunner,
  ) {}

  async indexRepo({ namespace, dir }: IndexRepoInput): Promise<IndexRepoResult> {
    await this.runner.index({ namespace, dir });
    const { rows } = await this.pool.query(
      `SELECT count(*)::int AS chunks, count(DISTINCT path)::int AS files
         FROM code_chunks WHERE namespace = $1`,
      [namespace],
    );
    return { chunkCount: rows[0].chunks, fileCount: rows[0].files };
  }

  async retrieve(namespace: string, query: string, opts?: RetrieveOptions): Promise<CodeChunk[]> {
    const [queryVec] = await this.embedder.embed([query]);
    const topK = opts?.topK ?? DEFAULT_TOP_K;

    const params: unknown[] = [namespace, toVectorLiteral(queryVec!), topK];
    let filter = 'namespace = $1';
    if (opts?.pathPrefix) {
      params.push(`${opts.pathPrefix}%`);
      filter += ` AND path LIKE $${params.length}`;
    }

    // `<=>` is cosine distance; similarity = 1 - distance. Lower distance ranks first.
    const { rows } = await this.pool.query(
      `SELECT path, start_line, end_line, content, 1 - (embedding <=> $2::vector) AS score
         FROM code_chunks
        WHERE ${filter}
        ORDER BY embedding <=> $2::vector
        LIMIT $3`,
      params,
    );

    return rows.map((r) => ({
      path: r.path,
      startLine: r.start_line,
      endLine: r.end_line,
      content: r.content,
      score: Number(r.score),
    }));
  }

  async dropNamespace(namespace: string): Promise<void> {
    await this.pool.query(`DELETE FROM code_chunks WHERE namespace = $1`, [namespace]);
  }
}
