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
import { buildProviderResolver } from './llm/provider-resolver.js';
import { CredentialVault } from './secrets/credential-vault.js';
import { PgVectorCodeIndex } from './index/pgvector-code-index.js';
import { CocoIndexSidecarRunner, SidecarEmbeddingProvider } from './index/cocoindex-runner.js';
import { cloneToTempDir } from './index/checkout.js';
import { openCodeSandbox } from './sandbox/code-sandbox.js';
import { startWorker } from './worker/worker.js';
import { createConsoleLogger } from './log.js';

async function main() {
  const config = loadConfig();
  // Probot exposes `probot.log` as null under our version, so use our own logger for
  // Tsukinome's modules (gateway/app/worker). Probot still logs internally on its own.
  const log = createConsoleLogger();

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
  const sandboxProvider = new E2BSandboxProvider(config.e2bApiKey, config.e2bTemplate, log);
  // Phase 12: resolve each run's Anthropic provider from its installation's stored key.
  // E2B and the DB pool remain operator-owned singletons, unchanged.
  const vault = new CredentialVault(store, config.masterEncryptionKey);
  const resolveProvider = buildProviderResolver({
    vault,
    factory: (apiKey) => new AnthropicProvider(apiKey),
    allowPlatformFallback: config.allowPlatformKeyFallback,
    platformKey: config.platformAnthropicKey,
  });
  const gateway = new LlmGateway(resolveProvider, store, log);
  const codeIndex = new PgVectorCodeIndex(
    pool,
    new SidecarEmbeddingProvider({ python: config.cocoindexPython }),
    new CocoIndexSidecarRunner(config.databaseUrl, { python: config.cocoindexPython }),
  );
  const app = createApp({ store, log });

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
    log,
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
