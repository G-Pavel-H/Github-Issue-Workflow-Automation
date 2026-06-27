/**
 * Phase 5 clarification-gate rendering. The Clarifier (LLM) produces the questions;
 * these helpers turn the orchestrator's deterministic decisions into issue comments.
 */

/**
 * Max clarifying questions to put to a human in one batch. If the Clarifier wants
 * more than this, the issue is too underspecified to interrogate — bounce it back.
 */
export const CLARIFY_QUESTION_CAP = 4;

function numbered(questions: string[]): string {
  return questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
}

/** The single batched question comment posted when the run parks for clarification. */
export function renderClarificationComment(questions: string[]): string {
  return [
    "❓ **A few questions before I start.** I need these answered to spec this correctly — " +
      'reply in this thread and I’ll pick it back up.',
    '',
    numbered(questions),
  ].join('\n');
}

/** The bounce comment when the Clarifier wants more than the cap allows. */
export function renderTooUnderspecifiedComment(questions: string[]): string {
  return [
    "🛑 **This issue is too underspecified for me to work on yet.** I’d need answers to more " +
      'open questions than I can reasonably ask in one round. Could you flesh out the issue with ' +
      'more detail and re-open or re-trigger me?',
    '',
    'The biggest gaps I see:',
    '',
    numbered(questions),
  ].join('\n');
}

/** Posted on resume after the human's answers are folded into the spec. */
export function renderSpecUpdatedComment(): string {
  return (
    '✅ **Thanks — spec updated.** I’ve folded your answers into the spec and re-committed it to ' +
    'the working branch. Moving on.'
  );
}
