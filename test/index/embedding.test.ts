import { describe, it, expect } from 'vitest';
import { FakeEmbeddingProvider } from './fake-embedding.js';
import { EMBEDDING_DIM } from '../../src/index/types.js';

describe('FakeEmbeddingProvider', () => {
  const embedder = new FakeEmbeddingProvider();

  it('reports the model dimension and returns vectors of that length', async () => {
    expect(embedder.dimension).toBe(EMBEDDING_DIM);
    const [v] = await embedder.embed(['hello world']);
    expect(v).toHaveLength(EMBEDDING_DIM);
  });

  it('is deterministic — the same text always embeds identically', async () => {
    const [a] = await embedder.embed(['add two numbers together']);
    const [b] = await embedder.embed(['add two numbers together']);
    expect(a).toEqual(b);
  });

  it('returns one vector per input, in order', async () => {
    const vecs = await embedder.embed(['one', 'two', 'three']);
    expect(vecs).toHaveLength(3);
  });

  it('places texts that share words closer than unrelated ones', async () => {
    const [q, near, far] = await embedder.embed([
      'function to add two numbers',
      'add two numbers and return the sum',
      'render a dark mode toggle button',
    ]);
    expect(cosine(q!, near!)).toBeGreaterThan(cosine(q!, far!));
  });
});

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}
