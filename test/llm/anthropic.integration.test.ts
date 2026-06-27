import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { createPool } from '../../src/db/pool.js';
import { PgStore } from '../../src/store/pg-store.js';
import { AnthropicProvider } from '../../src/llm/anthropic-provider.js';
import { LlmGateway } from '../../src/llm/gateway.js';
import { runAgent } from '../../src/agents/runner.js';
import { RunState, type RunKey } from '../../src/store/types.js';
import { silentLog } from '../helpers.js';
import type { SystemBlock } from '../../src/llm/types.js';

const KEY = process.env.ANTHROPIC_API_KEY;
const DB = process.env.DATABASE_URL;
const key: RunKey = { installationId: 1, owner: 'acme', repo: 'widgets', issueNumber: 1 };

// Real Anthropic calls + real Postgres. Skipped unless BOTH secrets are present;
// never runs in CI (spends tokens). Proves cross-tier logging, caching, and runAgent
// end to end against the live API.
describe.skipIf(!KEY || !DB)('Anthropic integration', () => {
  let pool: Pool;
  let store: PgStore;
  let gateway: LlmGateway;

  beforeAll(() => {
    pool = createPool(DB!);
    store = new PgStore(pool);
    gateway = new LlmGateway(new AnthropicProvider(KEY!), store, silentLog);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE jobs, runs, processed_events, test_runs, llm_calls RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await pool.end();
  });

  async function newRun(): Promise<number> {
    const { run } = await store.findOrCreateRun(key, RunState.Received);
    await store.setRunBudget(run.id, 1_000_000_000);
    return run.id;
  }

  const sys: SystemBlock[] = [{ text: 'You are a terse assistant. Answer in one short word.' }];

  it('logs a call with real token counts and cost on every tier', async () => {
    const runId = await newRun();
    for (const tier of ['triage', 'implementation', 'review'] as const) {
      const { response, costNanoUsd } = await gateway.call({
        runId,
        role: tier,
        tier,
        system: sys,
        messages: [{ role: 'user', content: 'Say hello.' }],
        maxTokens: 32,
      });
      expect(response.usage.inputTokens).toBeGreaterThan(0);
      expect(costNanoUsd).toBeGreaterThan(0);
    }
    expect(await store.getLlmCalls(runId)).toHaveLength(3);
  }, 60_000);

  it('reads from the prompt cache on a repeated large prefix (cache_read > 0)', async () => {
    const runId = await newRun();
    // Build a stable prefix above the 4096-token cache minimum.
    const big = 'Context line repeated for caching. '.repeat(1500);
    const cachedSys: SystemBlock[] = [{ text: big, cacheControl: 'ephemeral' }];
    const params = {
      runId,
      role: 'triage' as const,
      tier: 'triage' as const,
      system: cachedSys,
      messages: [{ role: 'user' as const, content: 'Reply with the word ok.' }],
      maxTokens: 16,
    };
    await gateway.call(params);
    const second = await gateway.call(params);
    expect(second.response.usage.cacheReadInputTokens).toBeGreaterThan(0);
  }, 60_000);

  it('runs the example-echo role end to end via runAgent', async () => {
    const runId = await newRun();
    const result = await runAgent(
      'example-echo',
      { messages: [{ role: 'user', content: 'banana' }] },
      { runId, gateway, log: silentLog },
    );
    expect(typeof (result.output as { echoed: string }).echoed).toBe('string');
    expect((await store.getLlmCalls(runId)).length).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('produces a confidence-tagged spec via the intake + product-owner roles', async () => {
    const runId = await newRun();
    const ctx = { runId, gateway, log: silentLog };
    const issue =
      'Title: Add a dark mode toggle\n\n' +
      'Body: Users have asked for a dark theme. Add a toggle in settings that switches ' +
      'the UI between light and dark and remembers the choice.';

    const intake = await runAgent<{ classification: string; problemStatement: string }>(
      'intake',
      { messages: [{ role: 'user', content: issue }] },
      ctx,
    );
    expect(['feature', 'bug', 'refactor', 'chore']).toContain(intake.output!.classification);

    const spec = await runAgent<{
      requirements: { confidence: string }[];
      acceptanceCriteria: { given: string; when: string; then: string }[];
      assumptions: string[];
    }>(
      'product-owner',
      { messages: [{ role: 'user', content: `Problem: ${intake.output!.problemStatement}\n\n${issue}` }] },
      ctx,
    );
    expect(spec.output!.requirements.length).toBeGreaterThan(0);
    expect(['explicit', 'inferred', 'assumption', 'unknown']).toContain(
      spec.output!.requirements[0]!.confidence,
    );
    expect(spec.output!.acceptanceCriteria[0]!.given).toBeTruthy();

    // Cost logged and within the run budget.
    const run = await store.getRunById(runId);
    expect(run!.spentNanoUsd).toBeGreaterThan(0);
    expect(run!.spentNanoUsd).toBeLessThan(run!.budgetNanoUsd);
    expect((await store.getLlmCalls(runId)).length).toBe(2);
  }, 90_000);
});
