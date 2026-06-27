import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  DEFAULT_TOP_K,
  type CodeChunk,
  type CodeIndex,
  type EmbeddingProvider,
  type IndexRepoInput,
  type IndexRepoResult,
  type RetrieveOptions,
} from '../../src/index/types.js';

interface StoredChunk extends CodeChunk {
  embedding: number[];
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mts|cts)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage']);

/**
 * In-memory `CodeIndex` for unit tests (no DB, no Python). Walks the checkout, splits
 * each file into top-level brace blocks (keeping whole functions/classes intact — i.e.
 * complete units), embeds via the injected provider, and serves cosine-ranked retrieval
 * scoped by namespace. Mirrors the real impl's contract so worker tests can use it.
 */
export class FakeCodeIndex implements CodeIndex {
  private byNamespace = new Map<string, StoredChunk[]>();

  constructor(private readonly embedder: EmbeddingProvider) {}

  async indexRepo({ namespace, dir }: IndexRepoInput): Promise<IndexRepoResult> {
    const files = listSourceFiles(dir);
    const pending: Omit<StoredChunk, 'embedding'>[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const path = relative(dir, file);
      for (const unit of chunkSource(content)) pending.push({ path, ...unit });
    }
    const embeddings = await this.embedder.embed(pending.map((c) => c.content));
    this.byNamespace.set(
      namespace,
      pending.map((c, i) => ({ ...c, embedding: embeddings[i]! })),
    );
    return { fileCount: files.length, chunkCount: pending.length };
  }

  async retrieve(namespace: string, query: string, opts?: RetrieveOptions): Promise<CodeChunk[]> {
    const stored = this.byNamespace.get(namespace) ?? [];
    const [q] = await this.embedder.embed([query]);
    const topK = opts?.topK ?? DEFAULT_TOP_K;
    return stored
      .filter((c) => !opts?.pathPrefix || c.path.startsWith(opts.pathPrefix))
      .map((c) => ({
        path: c.path,
        startLine: c.startLine,
        endLine: c.endLine,
        content: c.content,
        score: cosine(q!, c.embedding),
      }))
      .sort((a, b) => b.score! - a.score!)
      .slice(0, topK);
  }

  async dropNamespace(namespace: string): Promise<void> {
    this.byNamespace.delete(namespace);
  }
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...listSourceFiles(join(dir, entry.name)));
    } else if (SOURCE_EXT.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out.sort();
}

function countChar(line: string, ch: string): number {
  let n = 0;
  for (const c of line) if (c === ch) n++;
  return n;
}

/**
 * Split source into top-level units by brace depth. A unit closes only when depth is
 * back to 0 AND the line actually completes something (a closing `}` or a trailing `;`),
 * so leading doc-comments and an opening `function(){` accumulate into the same unit —
 * functions/classes stay whole (complete, non-fragmented). Deterministic and
 * dependency-free; the real AST-aware chunking is CocoIndex's job.
 */
function chunkSource(content: string): { startLine: number; endLine: number; content: string }[] {
  const lines = content.split('\n');
  const chunks: { startLine: number; endLine: number; content: string }[] = [];
  let depth = 0;
  let buf: string[] = [];
  let startLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (buf.length === 0) {
      if (line.trim() === '') continue; // skip blank separators between units
      startLine = i + 1; // 1-based
    }
    buf.push(line);
    depth += countChar(line, '{') - countChar(line, '}');
    const completesUnit = depth <= 0 && (line.includes('}') || line.trimEnd().endsWith(';'));
    if (completesUnit) {
      chunks.push({ startLine, endLine: i + 1, content: buf.join('\n') });
      buf = [];
      depth = 0;
    }
  }
  if (buf.length > 0) {
    chunks.push({ startLine, endLine: lines.length, content: buf.join('\n') });
  }
  return chunks;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
