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
    expect(config.anthropicApiKey).toBe('sk-ant-fake-key');
    expect(config.databaseUrl).toBe('postgres://localhost:5432/tsukinome');
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

  it('throws when ANTHROPIC_API_KEY is missing', () => {
    const { ANTHROPIC_API_KEY: _, ...rest } = validEnv;
    Object.assign(process.env, rest);
    expect(() => loadConfig()).toThrow('ANTHROPIC_API_KEY');
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
});
