import { describe, it, expect, beforeEach } from 'vitest';
import { runAgent } from '../../src/agents/runner.js';
import { LlmGateway } from '../../src/llm/gateway.js';
import { InMemoryStore } from '../../src/store/memory-store.js';
import { RunState, type RunKey } from '../../src/store/types.js';
import { FakeLlmProvider, textResponse, toolUseResponse } from '../llm/fake-provider.js';
import { silentLog } from '../helpers.js';
import type { AgentRunContext } from '../../src/agents/types.js';

const key: RunKey = { installationId: 1, owner: 'acme', repo: 'widgets', issueNumber: 1 };

async function context(store: InMemoryStore, provider: FakeLlmProvider): Promise<AgentRunContext> {
  const { run } = await store.findOrCreateRun(key, RunState.Received);
  return { runId: run.id, gateway: new LlmGateway(provider, store, silentLog), log: silentLog };
}

describe('runAgent — single-shot structured role', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('returns schema-valid output and logs the call', async () => {
    const provider = new FakeLlmProvider([
      textResponse(JSON.stringify({ echoed: 'hello world' }), { inputTokens: 50, outputTokens: 10 }),
    ]);
    const ctx = await context(store, provider);

    const result = await runAgent('example-echo', { messages: [{ role: 'user', content: 'hello world' }] }, ctx);

    expect(result.output).toEqual({ echoed: 'hello world' });
    expect((await store.getLlmCalls(ctx.runId)).length).toBe(1);
    // The stable instruction prefix is marked cacheable.
    expect(provider.requests[0]!.system.at(-1)?.cacheControl).toBe('ephemeral');
  });

  it('rejects output that does not satisfy the schema', async () => {
    const provider = new FakeLlmProvider([textResponse(JSON.stringify({ wrong: 1 }))]);
    const ctx = await context(store, provider);
    await expect(
      runAgent('example-echo', { messages: [{ role: 'user', content: 'x' }] }, ctx),
    ).rejects.toBeTruthy();
  });
});

describe('runAgent — tool-use loop', () => {
  let store: InMemoryStore;
  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('calls the stub tool, feeds the result back, and terminates normally', async () => {
    const provider = new FakeLlmProvider([
      toolUseResponse('ping', {}, { inputTokens: 20, outputTokens: 5 }),
      textResponse('pong received', { inputTokens: 30, outputTokens: 5 }),
    ]);
    const ctx = await context(store, provider);

    const result = await runAgent('example-tool-pinger', { messages: [{ role: 'user', content: 'ping please' }] }, ctx);

    expect(result.rounds).toBe(2);
    expect(result.stopReason).toBe('end_turn');
    // The second request must carry the tool_result from the first round.
    const secondMsgs = provider.requests[1]!.messages;
    const toolResult = secondMsgs.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => b.type === 'tool_result');
    expect(toolResult).toBeDefined();
    expect(await store.getLlmCalls(ctx.runId)).toHaveLength(2);
  });

  it('terminates at the round cap when the model keeps calling tools', async () => {
    const provider = new FakeLlmProvider();
    provider.always = toolUseResponse('ping', {}, { inputTokens: 10, outputTokens: 2 });
    const ctx = await context(store, provider);

    const result = await runAgent('example-tool-pinger', { messages: [{ role: 'user', content: 'loop' }] }, ctx);

    // example-tool-pinger caps at 3 rounds → 3 model calls, then stop (no infinite loop).
    expect(result.rounds).toBe(3);
    expect(provider.requests).toHaveLength(3);
  });
});
