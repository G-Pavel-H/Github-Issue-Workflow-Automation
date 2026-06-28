import 'dotenv/config';
import { createProbot, createNodeMiddleware } from 'probot';
import { createServer } from './server.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { PgStore } from './store/pg-store.js';
import { createProbotGitHubClient } from './github/client.js';
import { E2BSandboxProvider } from './sandbox/e2b-sandbox.js';
import { AnthropicProvider } from './llm/anthropic-provider.js';
import { LlmGateway } from './llm/gateway.js';
import { PgVectorCodeIndex } from './index/pgvector-code-index.js';
import { CocoIndexSidecarRunner, SidecarEmbeddingProvider } from './index/cocoindex-runner.js';
import { cloneToTempDir } from './index/checkout.js';
import { openCodeSandbox } from './sandbox/code-sandbox.js';
import { startWorker } from './worker/worker.js';

async function main() {
  const config = loadConfig();

  const pool = createPool(config.databaseUrl);
  const store = new PgStore(pool);

  const probot = createProbot({
    overrides: {
      appId: config.appId,
      privateKey: config.privateKey,
      secret: config.webhookSecret,
      logLevel: 'info',
    },
  });

  const github = createProbotGitHubClient(probot);
  const sandboxProvider = new E2BSandboxProvider(config.e2bApiKey);
  const gateway = new LlmGateway(new AnthropicProvider(config.anthropicApiKey), store, probot.log);
  const codeIndex = new PgVectorCodeIndex(
    pool,
    new SidecarEmbeddingProvider(),
    new CocoIndexSidecarRunner(config.databaseUrl),
  );
  const app = createApp({ store, log: probot.log });

  const webhookMiddleware = await createNodeMiddleware(app, {
    probot,
    webhooksPath: '/api/github/webhooks',
  });

  const server = createServer(webhookMiddleware);

  server.listen(config.port, () => {
    console.log(`Tsukinome listening on port ${config.port}`);
    console.log(`Health check: http://localhost:${config.port}/health`);
    console.log(`Webhooks:     http://localhost:${config.port}/api/github/webhooks`);
  });

  const worker = startWorker({
    store,
    github,
    sandboxProvider,
    gateway,
    codeIndex,
    cloneRepo: cloneToTempDir,
    openSandbox: openCodeSandbox,
    log: probot.log,
    runBudgetNanoUsd: config.runBudgetNanoUsd,
  });

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}, shutting down...`);
    worker.stop();
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error starting Tsukinome:', err);
  process.exit(1);
});
