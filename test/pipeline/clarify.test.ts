import { describe, it, expect } from 'vitest';
import {
  CLARIFY_QUESTION_CAP,
  renderClarificationComment,
  renderTooUnderspecifiedComment,
  renderSpecUpdatedComment,
} from '../../src/pipeline/clarify.js';

const questions = [
  'Should the export be CSV or JSON?',
  'Which timezone should timestamps use?',
];

describe('CLARIFY_QUESTION_CAP', () => {
  it('is a small positive cap', () => {
    expect(CLARIFY_QUESTION_CAP).toBeGreaterThan(0);
    expect(CLARIFY_QUESTION_CAP).toBeLessThanOrEqual(5);
  });
});

describe('renderClarificationComment', () => {
  const comment = renderClarificationComment(questions);

  it('batches every question into one numbered comment', () => {
    expect(comment).toContain('1.');
    expect(comment).toContain('2.');
    expect(comment).toContain('Should the export be CSV or JSON?');
    expect(comment).toContain('Which timezone should timestamps use?');
  });

  it('invites the human to reply in the thread', () => {
    expect(comment.toLowerCase()).toContain('reply');
  });
});

describe('renderTooUnderspecifiedComment', () => {
  it('explains it is bouncing the issue back, not interrogating', () => {
    const comment = renderTooUnderspecifiedComment(questions);
    expect(comment.toLowerCase()).toContain('underspecified');
    // It still surfaces the questions so the human can flesh out the issue.
    expect(comment).toContain('Should the export be CSV or JSON?');
  });
});

describe('renderSpecUpdatedComment', () => {
  it('acknowledges the answers and that the spec was updated', () => {
    const comment = renderSpecUpdatedComment();
    expect(comment.toLowerCase()).toContain('updated');
  });
});
