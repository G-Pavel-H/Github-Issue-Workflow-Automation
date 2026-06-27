import { z } from 'zod';

/** Intake agent output: classification + a clean, structured problem statement. */
export const intakeSchema = z.object({
  classification: z.enum(['bug', 'feature', 'refactor', 'chore']),
  title: z.string(),
  problemStatement: z.string(),
});
export type IntakeResult = z.infer<typeof intakeSchema>;

export const confidenceLevels = ['explicit', 'inferred', 'assumption', 'unknown'] as const;

/** Product Owner output: a functional spec with testable, confidence-tagged criteria. */
export const specSchema = z.object({
  summary: z.string(),
  requirements: z.array(
    z.object({
      id: z.string(),
      statement: z.string(),
      confidence: z.enum(confidenceLevels),
    }),
  ),
  acceptanceCriteria: z.array(
    z.object({
      id: z.string(),
      given: z.string(),
      when: z.string(),
      then: z.string(),
    }),
  ),
  nonGoals: z.array(z.string()),
  edgeCases: z.array(z.string()),
  assumptions: z.array(z.string()),
  /** Genuine unknowns for the Phase 5 clarifier. Captured now; not yet acted on. */
  openQuestions: z.array(z.string()),
});
export type Spec = z.infer<typeof specSchema>;

/**
 * Clarifier output (Phase 5): the genuine clarifying questions to put to the human,
 * derived from the spec's `unknown` and risky `assumption` items. The cap is enforced
 * in code (the orchestrator decides whether to ask, batch, or bounce) — the agent
 * returns every question it would genuinely ask.
 */
export const clarificationSchema = z.object({
  questions: z.array(z.string()),
});
export type Clarification = z.infer<typeof clarificationSchema>;
