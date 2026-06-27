import type { Usage } from './types.js';

/** USD per million tokens (input/output). Cache write = 1.25x input, read = 0.1x input. */
interface Rate {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const PRICING: Record<string, Rate> = {
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
};

const NANO_PER_USD = 1_000_000_000;

/**
 * Exact cost of one call in integer nano-USD (1e-9 USD). USD/MTok × 1e9 / 1e6 = ×1000
 * per token, so per-token rates are whole nano-USD numbers — no float drift.
 */
export function costNanoUsd(model: string, usage: Usage): number {
  const rate = PRICING[model];
  if (!rate) throw new Error(`No pricing for model "${model}"`);
  const inputNano = rate.inputPerMTok * 1000;
  const outputNano = rate.outputPerMTok * 1000;
  const cacheWriteNano = inputNano * 1.25;
  const cacheReadNano = inputNano * 0.1;
  return Math.round(
    usage.inputTokens * inputNano +
      usage.outputTokens * outputNano +
      usage.cacheCreationInputTokens * cacheWriteNano +
      usage.cacheReadInputTokens * cacheReadNano,
  );
}

/** Render nano-USD as a dollar string for logs/summaries. */
export function formatUsd(nanoUsd: number): string {
  return `$${(nanoUsd / NANO_PER_USD).toFixed(6)}`;
}
