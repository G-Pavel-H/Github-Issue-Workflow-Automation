/**
 * Model tiers and their concrete model IDs. Tiering by phase/role is a locked
 * decision: Haiku for triage/classification, Sonnet for implementation/tests,
 * Opus for spec/plan/review. IDs are exact (no date suffix).
 */
export type ModelTier = 'triage' | 'implementation' | 'review';

export const TIER_MODELS: Record<ModelTier, string> = {
  triage: 'claude-haiku-4-5',
  implementation: 'claude-sonnet-4-6',
  review: 'claude-opus-4-8',
};
