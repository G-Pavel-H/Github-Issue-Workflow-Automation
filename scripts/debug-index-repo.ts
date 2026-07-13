import 'dotenv/config';
import { createProbot } from 'probot';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { createProbotGitHubClient } from '../src/github/client.js';
import { cloneToTempDir } from '../src/index/checkout.js';
import { PgVectorCodeIndex } from '../src/index/pgvector-code-index.js';
import { CocoIndexSidecarRunner, SidecarEmbeddingProvider } from '../src/index/cocoindex-runner.js';
import { namespaceFor } from '../src/index/types.js';

/**
 * Phase 6 demo (needs Python + CocoIndex installed and a pgvector DATABASE_URL): clone a
 * repo to a temp dir, index it via the CocoIndex sidecar, run a natural-language query,
 * print the ranked complete code units, then tear down the vectors + checkout.
 *
 * Usage:
 *   npm run debug:index-repo -- <installationId> <owner> <repo> [ref] [query words...]
 */
async function main(): Promise<void> {
  const [installationId, owner, repo, ref = 'main', ...queryParts] = process.argv.slice(2);
  if (!installationId || !owner || !repo) {
    console.error('Usage: npm run debug:index-repo -- <installationId> <owner> <repo> [ref] [query...]');
    process.exit(1);
  }
  const query = queryParts.join(' ') || 'where is the main entry point';

  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const probot = createProbot({
    overrides: {
      appId: config.appId,
      privateKey: config.privateKey,
      secret: config.webhookSecret,
      logLevel: 'warn',
    },
  });
  const github = createProbotGitHubClient(probot);

  const token = await github.getInstallationToken({ installationId: Number(installationId), owner, repo });
  const checkout = await cloneToTempDir({ token, owner, repo, ref });
  const ns = namespaceFor({ owner, repo, runId: 0 });
  const index = new PgVectorCodeIndex(
    pool,
    new SidecarEmbeddingProvider({ python: config.cocoindexPython }),
    new CocoIndexSidecarRunner(config.databaseUrl, { python: config.cocoindexPython }),
  );

  try {
    const res = await index.indexRepo({ namespace: ns, dir: checkout.dir });
    console.log(`Indexed ${res.chunkCount} chunks from ${res.fileCount} files into "${ns}".`);
    console.log(`\nQuery: ${query}\n`);
    const hits = await index.retrieve(ns, query, { topK: 5 });
    for (const h of hits) {
      console.log(`# ${h.path}:${h.startLine}-${h.endLine}  (score ${h.score?.toFixed(3)})`);
      console.log(`${h.content.slice(0, 400)}\n`);
    }
  } finally {
    await index.dropNamespace(ns);
    checkout.cleanup();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('debug:index-repo failed:', err);
  process.exit(1);
});
