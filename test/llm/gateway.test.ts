import { describe, it, expect, beforeEach } from 'vitest';
import { LlmGateway, BudgetExhaustedError } from '../../src/llm/gateway.js';
import { MissingInstallationKeyError } from '../../src/llm/provider-resolver.js';
import { InMemoryStore } from '../../src/store/memory-store.js';
import { RunState, type RunKey } from '../../src/store/types.js';
import { costNanoUsd } from '../../src/llm/pricing.js';
import { FakeLlmProvider, textResponse, usage } from './fake-provider.js';
import { silentLog } from '../helpers.js';
import type { SystemBlock, LlmMessage } from '../../src/llm/types.js';

const key: RunKey = { installationId: 1, owner: 'acme', repo: 'widgets', issueNumber: 1 };
const system: SystemBlock[] = [{ text: 'You are a test agent.', cacheControl: 'ephemeral' }];
const messages: LlmMessage[] = [{ role: 'user', content: 'hi' }];

async function newRun(store: InMemoryStore): Promise<number> {
  const { run } = await store.findOrCreateRun(key, RunState.Received);
  return run.id;
}

async function newRunForInstallation(store: InMemoryStore, installationId: number): Promise<number> {
  const { run } = await store.findOrCreateRun(
    { ...key, installationId, issueNumber: installationId },
    RunState.Received,
  );
  return run.id;
}

describe('LlmGateway', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('routes each tier to the expected model', async () => {
    const provider = new FakeLlmProvider();
    provider.always = textResponse('ok', { inputTokens: 10, outputTokens: 5 });
    const gw = new LlmGateway(provider, store, silentLog);
    const runId = await newRun(store);

    await gw.call({ runId, role: 'triage', tier: 'triage', system, messages });
    await gw.call({ runId, role: 'impl', tier: 'implementation', system, messages });
    await gw.call({ runId, role: 'review', tier: 'review', system, messages });

    expect(provider.requests.map((r) => r.model)).toEqual([
      'claude-haiku-4-5',
      'claude-sonnet-4-6',
      'claude-opus-4-8',
    ]);
  });

  it('logs the call with token counts and cost, and decrements the budget', async () => {
    const provider = new FakeLlmProvider([
      textResponse('ok', { inputTokens: 1000, outputTokens: 500 }),
    ]);
    const gw = new LlmGateway(provider, store, silentLog);
    const runId = await newRun(store);
    const before = (await store.getRunById(runId))!.budgetNanoUsd;

    const result = await gw.call({ runId, role: 'triage', tier: 'review', system, messages });

    const expectedCost = costNanoUsd('claude-opus-4-8', usage({ inputTokens: 1000, outputTokens: 500 }));
    expect(result.costNanoUsd).toBe(expectedCost);
    expect(result.budgetRemainingNanoUsd).toBe(before - expectedCost);

    const calls = await store.getLlmCalls(runId);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      model: 'claude-opus-4-8',
      inputTokens: 1000,
      outputTokens: 500,
      costNanoUsd: expectedCost,
    });
  });

  it('stops with BudgetExhaustedError instead of continuing once the budget is spent', async () => {
    const provider = new FakeLlmProvider();
    provider.always = textResponse('ok', { inputTokens: 1000, outputTokens: 1000 });
    const gw = new LlmGateway(provider, store, silentLog);
    const runId = await newRun(store);
    await store.setRunBudget(runId, 1); // 1 nano-USD — first call overspends it

    // First call proceeds (budget not yet exhausted) and overspends.
    await gw.call({ runId, role: 'triage', tier: 'triage', system, messages });

    // Second call must refuse without hitting the provider again.
    await expect(
      gw.call({ runId, role: 'triage', tier: 'triage', system, messages }),
    ).rejects.toBeInstanceOf(BudgetExhaustedError);

    expect(provider.requests).toHaveLength(1);
  });

  it("resolves the provider per the run's installation id", async () => {
    const providerA = new FakeLlmProvider();
    providerA.always = textResponse('a', { inputTokens: 1, outputTokens: 1 });
    const providerB = new FakeLlmProvider();
    providerB.always = textResponse('b', { inputTokens: 1, outputTokens: 1 });

    // Resolver keys off installation id: 100 → providerA, anything else → providerB.
    const gw = new LlmGateway(
      async (installationId: number) => (installationId === 100 ? providerA : providerB),
      store,
      silentLog,
    );
    const runA = await newRunForInstallation(store, 100);
    const runB = await newRunForInstallation(store, 200);

    await gw.call({ runId: runA, role: 'triage', tier: 'triage', system, messages });
    await gw.call({ runId: runB, role: 'triage', tier: 'triage', system, messages });

    expect(providerA.requests).toHaveLength(1);
    expect(providerB.requests).toHaveLength(1);
  });

  it('refuses before any spend when the resolver reports no key on file', async () => {
    const provider = new FakeLlmProvider();
    provider.always = textResponse('never', { inputTokens: 1, outputTokens: 1 });
    const gw = new LlmGateway(
      async (installationId: number) => {
        throw new MissingInstallationKeyError(installationId);
      },
      store,
      silentLog,
    );
    const runId = await newRun(store);

    await expect(
      gw.call({ runId, role: 'triage', tier: 'triage', system, messages }),
    ).rejects.toBeInstanceOf(MissingInstallationKeyError);

    // No model call, no cost recorded.
    expect(provider.requests).toHaveLength(0);
    expect(await store.getLlmCalls(runId)).toHaveLength(0);
    expect((await store.getRunById(runId))!.spentNanoUsd).toBe(0);
  });

  it('still accepts a fixed provider (backwards-compatible constructor)', async () => {
    const provider = new FakeLlmProvider();
    provider.always = textResponse('ok', { inputTokens: 1, outputTokens: 1 });
    const gw = new LlmGateway(provider, store, silentLog);
    const runId = await newRun(store);
    await gw.call({ runId, role: 'triage', tier: 'triage', system, messages });
    expect(provider.requests).toHaveLength(1);
  });
});
