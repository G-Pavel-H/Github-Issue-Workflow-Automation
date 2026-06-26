export interface Config {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  anthropicApiKey: string;
  databaseUrl: string;
  port: number;
}

const REQUIRED_VARS = [
  'APP_ID',
  'PRIVATE_KEY',
  'WEBHOOK_SECRET',
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
] as const;

export function loadConfig(): Config {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    appId: process.env.APP_ID!,
    privateKey: process.env.PRIVATE_KEY!,
    webhookSecret: process.env.WEBHOOK_SECRET!,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY!,
    databaseUrl: process.env.DATABASE_URL!,
    port: parseInt(process.env.PORT ?? '3000', 10),
  };
}
