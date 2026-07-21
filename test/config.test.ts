import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  const validEnv = {
    APP_ID: '12345',
    PRIVATE_KEY: 'fake-private-key',
    WEBHOOK_SECRET: 'fake-webhook-secret',
    ANTHROPIC_API_KEY: 'sk-ant-fake-key',
    DATABASE_URL: 'postgres://localhost:5432/tsukinome',
    E2B_API_KEY: 'e2b-fake-key',
    MASTER_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  };

  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Clear all relevant env vars
    for (const key of Object.keys(validEnv)) {
      delete process.env[key];
    }
    delete process.env.PORT;
    delete process.env.RUN_BUDGET_USD;
    delete process.env.ALLOW_PLATFORM_KEY_FALLBACK;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('defaults the per-run budget to $1.00 (1e9 nano-USD) when RUN_BUDGET_USD is unset', () => {
    Object.assign(process.env, validEnv);
    delete process.env.RUN_BUDGET_USD;
    expect(loadConfig().runBudgetNanoUsd).toBe(1_000_000_000);
  });

  it('parses RUN_BUDGET_USD (dollars) into integer nano-USD', () => {
    Object.assign(process.env, validEnv, { RUN_BUDGET_USD: '2.5' });
    expect(loadConfig().runBudgetNanoUsd).toBe(2_500_000_000);
  });

  it('rejects a non-positive RUN_BUDGET_USD', () => {
    Object.assign(process.env, validEnv, { RUN_BUDGET_USD: '0' });
    expect(() => loadConfig()).toThrow('RUN_BUDGET_USD');
  });

  it('parses all required env vars into a typed config', () => {
    Object.assign(process.env, validEnv);
    const config = loadConfig();

    expect(config.appId).toBe('12345');
    expect(config.privateKey).toBe('fake-private-key');
    expect(config.webhookSecret).toBe('fake-webhook-secret');
    expect(config.platformAnthropicKey).toBe('sk-ant-fake-key');
    expect(config.databaseUrl).toBe('postgres://localhost:5432/tsukinome');
    expect(config.masterEncryptionKey).toHaveLength(32);
    expect(config.port).toBe(3000); // default
  });

  it('uses PORT from env when provided', () => {
    Object.assign(process.env, validEnv, { PORT: '8080' });
    const config = loadConfig();
    expect(config.port).toBe(8080);
  });

  it('throws when APP_ID is missing', () => {
    const { APP_ID: _, ...rest } = validEnv;
    Object.assign(process.env, rest);
    expect(() => loadConfig()).toThrow('APP_ID');
  });

  it('throws when PRIVATE_KEY is missing', () => {
    const { PRIVATE_KEY: _, ...rest } = validEnv;
    Object.assign(process.env, rest);
    expect(() => loadConfig()).toThrow('PRIVATE_KEY');
  });

  it('throws when WEBHOOK_SECRET is missing', () => {
    const { WEBHOOK_SECRET: _, ...rest } = validEnv;
    Object.assign(process.env, rest);
    expect(() => loadConfig()).toThrow('WEBHOOK_SECRET');
  });

  it('treats ANTHROPIC_API_KEY as optional (pure BYO deploys need no operator key)', () => {
    const { ANTHROPIC_API_KEY: _, ...rest } = validEnv;
    Object.assign(process.env, rest);
    const config = loadConfig();
    expect(config.platformAnthropicKey).toBeUndefined();
    expect(config.allowPlatformKeyFallback).toBe(false);
  });

  it('throws when MASTER_ENCRYPTION_KEY is missing', () => {
    const { MASTER_ENCRYPTION_KEY: _, ...rest } = validEnv;
    Object.assign(process.env, rest);
    expect(() => loadConfig()).toThrow('MASTER_ENCRYPTION_KEY');
  });

  it('throws when MASTER_ENCRYPTION_KEY does not decode to 32 bytes', () => {
    Object.assign(process.env, validEnv, {
      MASTER_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64'),
    });
    expect(() => loadConfig()).toThrow('MASTER_ENCRYPTION_KEY');
  });

  it('parses ALLOW_PLATFORM_KEY_FALLBACK and keeps the operator key for fallback', () => {
    Object.assign(process.env, validEnv, { ALLOW_PLATFORM_KEY_FALLBACK: 'true' });
    const config = loadConfig();
    expect(config.allowPlatformKeyFallback).toBe(true);
    expect(config.platformAnthropicKey).toBe('sk-ant-fake-key');
  });

  it('throws when fallback is enabled but no operator ANTHROPIC_API_KEY is set', () => {
    const { ANTHROPIC_API_KEY: _, ...rest } = validEnv;
    Object.assign(process.env, rest, { ALLOW_PLATFORM_KEY_FALLBACK: 'true' });
    expect(() => loadConfig()).toThrow(/ALLOW_PLATFORM_KEY_FALLBACK/);
  });

  it('throws when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _, ...rest } = validEnv;
    Object.assign(process.env, rest);
    expect(() => loadConfig()).toThrow('DATABASE_URL');
  });

  it('throws when E2B_API_KEY is missing', () => {
    const { E2B_API_KEY: _, ...rest } = validEnv;
    Object.assign(process.env, rest);
    expect(() => loadConfig()).toThrow('E2B_API_KEY');
  });

  it('parses E2B_API_KEY into the config', () => {
    Object.assign(process.env, validEnv);
    expect(loadConfig().e2bApiKey).toBe('e2b-fake-key');
  });

  it('leaves cocoindexPython undefined when COCOINDEX_PYTHON is unset', () => {
    Object.assign(process.env, validEnv);
    delete process.env.COCOINDEX_PYTHON;
    expect(loadConfig().cocoindexPython).toBeUndefined();
  });

  it('parses COCOINDEX_PYTHON (interpreter path) into the config', () => {
    Object.assign(process.env, validEnv, { COCOINDEX_PYTHON: '/repo/.venv/bin/python' });
    expect(loadConfig().cocoindexPython).toBe('/repo/.venv/bin/python');
  });

  it('treats a blank COCOINDEX_PYTHON as unset', () => {
    Object.assign(process.env, validEnv, { COCOINDEX_PYTHON: '   ' });
    expect(loadConfig().cocoindexPython).toBeUndefined();
  });
});
