import 'dotenv/config';
import { createProbot, createNodeMiddleware } from 'probot';
import { createServer } from './server.js';
import { app } from './app.js';
import { loadConfig } from './config.js';

async function main() {
  const config = loadConfig();

  const probot = createProbot({
    overrides: {
      appId: config.appId,
      privateKey: config.privateKey,
      secret: config.webhookSecret,
      logLevel: 'info',
    },
  });

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
}

main().catch((err) => {
  console.error('Fatal error starting Tsukinome:', err);
  process.exit(1);
});
