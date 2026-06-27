import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { EMBEDDING_DIM, EMBEDDING_MODEL, type EmbeddingProvider } from './types.js';

/**
 * Ingestion engine behind {@link PgVectorCodeIndex}. The real impl shells out to the
 * CocoIndex Python sidecar, which AST-chunks (tree-sitter) the checkout and embeds with
 * the local model, writing rows into `code_chunks` tagged with `namespace`.
 *
 * Like the E2B and Anthropic real impls, this path runs only where Python + CocoIndex
 * are installed — it is exercised by the gated integration test / the demo, never in CI.
 */
export interface CocoIndexRunner {
  /** Chunk + embed every supported source file under `dir` into `code_chunks`. */
  index(input: { namespace: string; dir: string }): Promise<void>;
}

const SIDECAR_SCRIPT = resolve(import.meta.dirname, '..', '..', 'sidecar', 'cocoindex_flow.py');

export class CocoIndexSidecarRunner implements CocoIndexRunner {
  constructor(
    private readonly databaseUrl: string,
    private readonly opts: { python?: string; model?: string } = {},
  ) {}

  index({ namespace, dir }: { namespace: string; dir: string }): Promise<void> {
    const python = this.opts.python ?? 'python3';
    const model = this.opts.model ?? EMBEDDING_MODEL;
    return new Promise((resolvePromise, reject) => {
      const child = spawn(
        python,
        [SIDECAR_SCRIPT, 'index', '--namespace', namespace, '--dir', dir, '--model', model],
        { env: { ...process.env, DATABASE_URL: this.databaseUrl } },
      );
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolvePromise();
        else reject(new Error(`cocoindex sidecar exited with ${code}: ${stderr.slice(-2000)}`));
      });
    });
  }
}

/**
 * Real query {@link EmbeddingProvider}: embeds text with the same local model the sidecar
 * uses for documents (shared vector space), via the sidecar's `query-embed` mode. Gated
 * like {@link CocoIndexSidecarRunner} — runs only where Python + the model are available.
 */
export class SidecarEmbeddingProvider implements EmbeddingProvider {
  readonly dimension = EMBEDDING_DIM;

  constructor(private readonly opts: { python?: string; model?: string } = {}) {}

  async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const text of texts) out.push(await this.embedOne(text));
    return out;
  }

  private embedOne(text: string): Promise<number[]> {
    const python = this.opts.python ?? 'python3';
    const model = this.opts.model ?? EMBEDDING_MODEL;
    return new Promise((resolvePromise, reject) => {
      const child = spawn(python, [
        SIDECAR_SCRIPT,
        'query-embed',
        '--query',
        text,
        '--model',
        model,
      ]);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolvePromise(JSON.parse(stdout) as number[]);
        else reject(new Error(`query-embed exited with ${code}: ${stderr.slice(-2000)}`));
      });
    });
  }
}
