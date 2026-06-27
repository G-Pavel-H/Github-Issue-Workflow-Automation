/**
 * Phase 6 code index. Gives downstream agents scoped, ranked code context instead of
 * whole files. Real engine is CocoIndex (behind this interface); tests use a fake.
 *
 * MVP scope is per-run: a repo is cloned, indexed under a per-run `namespace`, queried
 * during the run, then its vectors are dropped. No incrementality / persistent state.
 */

/** The local embedding model. Document and query embeddings MUST share it (same space). */
export const EMBEDDING_MODEL = 'sentence-transformers/all-MiniLM-L6-v2';

/** Dimension of `EMBEDDING_MODEL`'s vectors; matches the `vector(384)` column. */
export const EMBEDDING_DIM = 384;

/** A complete, retrievable code unit (a function/class/etc., not a fragment). */
export interface CodeChunk {
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  /** Cosine similarity to the query (0..1), present on retrieval results. */
  score?: number;
}

/**
 * Turns text into embedding vectors. Real impl uses the local model (shared with the
 * CocoIndex sidecar); tests use a deterministic fake. Always returns `dimension`-length
 * vectors, one per input string, in order.
 */
export interface EmbeddingProvider {
  readonly dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface IndexRepoInput {
  /** Per-run scope key; all chunks are tagged with it and retrieval filters on it. */
  namespace: string;
  /** Local checkout directory to index (host-side temp dir; never executed). */
  dir: string;
}

export interface IndexRepoResult {
  fileCount: number;
  chunkCount: number;
}

export interface RetrieveOptions {
  /** Max chunks to return (default a small per-agent budget). */
  topK?: number;
  /** Restrict to chunks whose path starts with this prefix (scope control). */
  pathPrefix?: string;
}

/**
 * The retrieval capability the agents call. One namespace per run keeps retrieval
 * scoped and prevents cross-repo leakage; `dropNamespace` is the per-run teardown.
 */
export interface CodeIndex {
  /** Chunk + embed every supported source file under `dir` into `namespace`. */
  indexRepo(input: IndexRepoInput): Promise<IndexRepoResult>;
  /** Ranked code chunks for a natural-language query, scoped to `namespace`. */
  retrieve(namespace: string, query: string, opts?: RetrieveOptions): Promise<CodeChunk[]>;
  /** Drop all vectors for a namespace (call at the end of a run). */
  dropNamespace(namespace: string): Promise<void>;
}

/** Default per-query result budget — retrieval is a cost control, not only a quality one. */
export const DEFAULT_TOP_K = 8;

/** The per-run namespace key for a repo. Run-scoped, so it can never span repos. */
export function namespaceFor(input: { owner: string; repo: string; runId: number }): string {
  return `${input.owner}/${input.repo}/run-${input.runId}`;
}
