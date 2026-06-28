export interface Config {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  anthropicApiKey: string;
  databaseUrl: string;
  e2bApiKey: string;
  port: number;
  /** Per-run budget ceiling in nano-USD. Default $1.00. Override via RUN_BUDGET_USD. */
  runBudgetNanoUsd: number;
}

const NANO_PER_USD = 1_000_000_000;
const DEFAULT_RUN_BUDGET_USD = 1.0;

/** Parse RUN_BUDGET_USD (a dollar amount) into integer nano-USD, falling back to the default. */
function parseRunBudgetNanoUsd(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RUN_BUDGET_USD * NANO_PER_USD;
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error(`RUN_BUDGET_USD must be a positive number, got "${raw}"`);
  }
  return Math.round(usd * NANO_PER_USD);
}

const REQUIRED_VARS = [
  'APP_ID',
  'PRIVATE_KEY',
  'WEBHOOK_SECRET',
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
  'E2B_API_KEY',
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
    e2bApiKey: process.env.E2B_API_KEY!,
    port: parseInt(process.env.PORT ?? '3000', 10),
    runBudgetNanoUsd: parseRunBudgetNanoUsd(process.env.RUN_BUDGET_USD),
  };
}
