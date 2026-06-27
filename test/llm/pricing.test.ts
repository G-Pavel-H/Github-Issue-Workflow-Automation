import { describe, it, expect } from 'vitest';
import { costNanoUsd, formatUsd } from '../../src/llm/pricing.js';
import { usage } from './fake-provider.js';

describe('costNanoUsd', () => {
  it('prices Opus input + output tokens (5/25 per MTok)', () => {
    // 1000 in * 5000 nano + 500 out * 25000 nano = 5_000_000 + 12_500_000
    const cost = costNanoUsd('claude-opus-4-8', usage({ inputTokens: 1000, outputTokens: 500 }));
    expect(cost).toBe(17_500_000);
  });

  it('prices Sonnet (3/15 per MTok)', () => {
    const cost = costNanoUsd('claude-sonnet-4-6', usage({ inputTokens: 1000, outputTokens: 1000 }));
    expect(cost).toBe(3_000_000 + 15_000_000);
  });

  it('prices Haiku (1/5 per MTok)', () => {
    const cost = costNanoUsd('claude-haiku-4-5', usage({ inputTokens: 2000, outputTokens: 100 }));
    expect(cost).toBe(2000 * 1000 + 100 * 5000);
  });

  it('prices cache writes at 1.25x and cache reads at 0.1x input', () => {
    // Opus input rate 5000 nano/token → write 6250, read 500
    const cost = costNanoUsd(
      'claude-opus-4-8',
      usage({ cacheCreationInputTokens: 1000, cacheReadInputTokens: 1000 }),
    );
    expect(cost).toBe(1000 * 6250 + 1000 * 500);
  });

  it('throws for an unknown model', () => {
    expect(() => costNanoUsd('gpt-4', usage({ inputTokens: 1 }))).toThrow();
  });
});

describe('formatUsd', () => {
  it('renders nano-USD as a dollar string', () => {
    expect(formatUsd(17_500_000)).toBe('$0.017500');
  });
});
