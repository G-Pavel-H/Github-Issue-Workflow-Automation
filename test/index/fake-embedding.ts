import { EMBEDDING_DIM, type EmbeddingProvider } from '../../src/index/types.js';

/**
 * Deterministic, dependency-free embedding for tests. Hashes tokens into a fixed-dim
 * bag-of-words vector and L2-normalizes, so: the same text always embeds identically,
 * and cosine similarity reflects shared-token overlap (a query sharing words with a
 * chunk ranks higher). Good enough to exercise ranking + the pgvector ANN path without
 * the real local model. Same dimension as the real model, so the `vector(384)` column
 * is exercised faithfully.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly dimension = EMBEDDING_DIM;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => embedText(t, this.dimension));
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function hash(token: string): number {
  let h = 5381;
  for (let i = 0; i < token.length; i++) h = (h * 33 + token.charCodeAt(i)) >>> 0;
  return h;
}

function embedText(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const tok of tokenize(text)) v[hash(tok) % dim] += 1;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}
