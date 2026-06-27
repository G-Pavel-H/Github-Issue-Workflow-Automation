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

/** Architect output (Phase 7): a technical plan for the approval gate. */
export const planSchema = z.object({
  summary: z.string(),
  approach: z.string(),
  affectedFiles: z.array(
    z.object({
      path: z.string(),
      change: z.enum(['add', 'modify', 'delete']),
      reason: z.string(),
    }),
  ),
  /** Interfaces / signatures / public contracts introduced or changed. */
  contracts: z.array(z.string()),
  /** Schema, migration, or data-model changes. */
  dataChanges: z.array(z.string()),
  /** How the work will be tested (drives the Phase 8 TDD loop). */
  testStrategy: z.array(z.string()),
});
export type Plan = z.infer<typeof planSchema>;

/** Decomposer output (Phase 8): the plan broken into small, independently testable tasks. */
export const taskListSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      acceptanceCriteria: z.array(z.string()),
    }),
  ),
});
export type TaskList = z.infer<typeof taskListSchema>;

/** Shared output of the Test Author / Implementer / Refactor agents: whole-file edits. */
export const fileSetSchema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  notes: z.string().optional(),
});
export type FileSet = z.infer<typeof fileSetSchema>;
export type FileEdit = FileSet['files'][number];

/** Reviewer output (Phase 9): a self-review of the change against spec, conventions, security. */
export const reviewSchema = z.object({
  verdict: z.enum(['approve', 'request_changes']),
  summary: z.string(),
  findings: z.array(
    z.object({
      severity: z.enum(['info', 'warning', 'blocker']),
      note: z.string(),
      file: z.string().optional(),
    }),
  ),
});
export type Review = z.infer<typeof reviewSchema>;
