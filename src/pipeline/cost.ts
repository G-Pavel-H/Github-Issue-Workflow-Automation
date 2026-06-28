import { formatUsd } from '../llm/pricing.js';
import type { LlmCall } from '../store/types.js';

/** One role's rolled-up usage across a run. */
interface RoleTotal {
  role: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costNanoUsd: number;
}

function rollUpByRole(calls: LlmCall[]): RoleTotal[] {
  const byRole = new Map<string, RoleTotal>();
  for (const c of calls) {
    const t =
      byRole.get(c.role) ??
      { role: c.role, calls: 0, inputTokens: 0, outputTokens: 0, costNanoUsd: 0 };
    t.calls += 1;
    t.inputTokens += c.inputTokens + c.cacheCreationTokens + c.cacheReadTokens;
    t.outputTokens += c.outputTokens;
    t.costNanoUsd += c.costNanoUsd;
    byRole.set(c.role, t);
  }
  return [...byRole.values()].sort((a, b) => b.costNanoUsd - a.costNanoUsd);
}

/**
 * Per-run cost summary as a compact markdown block: a headline total plus a
 * per-role breakdown. Surfaces in the PR body and an issue comment so the run's
 * measured cost is visible in GitHub with no external dashboard.
 */
export function renderCostSummary(calls: LlmCall[]): string {
  const totalNanoUsd = calls.reduce((sum, c) => sum + c.costNanoUsd, 0);
  const headline = `**💰 Run cost:** ${formatUsd(totalNanoUsd)} across ${calls.length} model call${
    calls.length === 1 ? '' : 's'
  }.`;
  if (calls.length === 0) return headline;

  const rows = rollUpByRole(calls)
    .map(
      (t) =>
        `| ${t.role} | ${t.calls} | ${t.inputTokens}/${t.outputTokens} | ${formatUsd(t.costNanoUsd)} |`,
    )
    .join('\n');

  return [
    headline,
    '',
    '| Role | Calls | Tokens (in/out) | Cost |',
    '| --- | --- | --- | --- |',
    rows,
  ].join('\n');
}
