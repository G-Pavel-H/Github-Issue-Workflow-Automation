import { parseMasterKey } from './secrets/crypto.js';

export interface Config {
  appId: string;
  privateKey: string;
  webhookSecret: string;
  /**
   * The operator's platform Anthropic key. Optional under BYO (Phase 12): pure-BYO deploys
   * need none. Used *only* when `allowPlatformKeyFallback` is true (self-host / dogfooding).
   */
  platformAnthropicKey?: string;
  /**
   * 32-byte AES-256 key (base64-decoded) used to encrypt per-installation Anthropic keys at
   * rest. Required — a misconfigured length throws at startup (see `parseMasterKey`).
   */
  masterEncryptionKey: Buffer;
  /**
   * When true, an installation with no key on file falls back to the operator's platform key
   * (requires `platformAnthropicKey`). Off by default — missing keys are refused, never
   * silently billed to the operator.
   */
  allowPlatformKeyFallback: boolean;
  databaseUrl: string;
  e2bApiKey: string;
  /**
   * Optional E2B template id/name for the code sandbox. The default E2B base image ships an old
   * Node (< 20.12), which breaks `npm test` at import time for repos needing modern Node — set this
   * to a custom template pinned to Node ≥ 22 (see e2b.Dockerfile / docs/setup.md). Unset → base image.
   */
  e2bTemplate?: string;
  /**
   * Optional path to the Python interpreter that has the CocoIndex sidecar deps installed
   * (`sidecar/requirements.txt`). The sidecar runs host-side, not in E2B — set this to a venv's
   * interpreter (e.g. `.venv/bin/python`) so `import cocoindex` resolves. Unset → bare `python3` on
   * PATH; if that lacks the deps, code retrieval degrades gracefully (best-effort, plans from spec).
   */
  cocoindexPython?: string;
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
  'DATABASE_URL',
  'E2B_API_KEY',
  'MASTER_ENCRYPTION_KEY',
] as const;

/** Truthy env flag: "1"/"true"/"yes" (case-insensitive) → true; anything else → false. */
function parseBool(raw: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((raw ?? '').trim().toLowerCase());
}

export function loadConfig(): Config {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const platformAnthropicKey = process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  const allowPlatformKeyFallback = parseBool(process.env.ALLOW_PLATFORM_KEY_FALLBACK);
  if (allowPlatformKeyFallback && !platformAnthropicKey) {
    throw new Error(
      'ALLOW_PLATFORM_KEY_FALLBACK is enabled but ANTHROPIC_API_KEY (the operator platform key) ' +
        'is not set — set the operator key or disable the fallback.',
    );
  }

  return {
    appId: process.env.APP_ID!,
    privateKey: process.env.PRIVATE_KEY!,
    webhookSecret: process.env.WEBHOOK_SECRET!,
    platformAnthropicKey,
    masterEncryptionKey: parseMasterKey(process.env.MASTER_ENCRYPTION_KEY!),
    allowPlatformKeyFallback,
    databaseUrl: process.env.DATABASE_URL!,
    e2bApiKey: process.env.E2B_API_KEY!,
    e2bTemplate: process.env.E2B_TEMPLATE?.trim() || undefined,
    cocoindexPython: process.env.COCOINDEX_PYTHON?.trim() || undefined,
    port: parseInt(process.env.PORT ?? '3000', 10),
    runBudgetNanoUsd: parseRunBudgetNanoUsd(process.env.RUN_BUDGET_USD),
  };
}
