import { describe, it, expect } from 'vitest';
import { renderSpecMarkdown, renderSpecComment } from '../../src/pipeline/spec.js';
import type { Spec } from '../../src/pipeline/schemas.js';

const spec: Spec = {
  summary: 'Add a dark mode toggle to the settings page.',
  requirements: [
    { id: 'R1', statement: 'A toggle switches the UI between light and dark.', confidence: 'explicit' },
    { id: 'R2', statement: 'The choice persists across reloads.', confidence: 'inferred' },
    { id: 'R3', statement: 'Defaults to the OS theme on first visit.', confidence: 'assumption' },
  ],
  acceptanceCriteria: [
    {
      id: 'AC1',
      given: 'the user is on the settings page',
      when: 'they click the dark mode toggle',
      then: 'the UI switches to the dark theme immediately',
    },
  ],
  nonGoals: ['Per-component theme overrides'],
  edgeCases: ['OS theme changes while the app is open'],
  assumptions: ['Preference is stored in localStorage'],
  openQuestions: [],
};

describe('renderSpecMarkdown', () => {
  const md = renderSpecMarkdown(spec, { issueNumber: 42, title: 'Dark mode', classification: 'feature' });

  it('renders Given/When/Then acceptance criteria', () => {
    expect(md).toMatch(/Given/);
    expect(md).toMatch(/When/);
    expect(md).toMatch(/Then/);
    expect(md).toContain('they click the dark mode toggle');
  });

  it('tags each requirement with its confidence level', () => {
    expect(md).toContain('explicit');
    expect(md).toContain('inferred');
    expect(md).toContain('assumption');
  });

  it('includes assumptions, non-goals, and edge cases', () => {
    expect(md).toContain('Preference is stored in localStorage');
    expect(md).toContain('Per-component theme overrides');
    expect(md).toContain('OS theme changes while the app is open');
  });
});

describe('renderSpecComment', () => {
  it('includes an assumptions section', () => {
    const comment = renderSpecComment(spec);
    expect(comment.toLowerCase()).toContain('assumptions i'); // "Assumptions I'm making"
    expect(comment).toContain('Preference is stored in localStorage');
  });
});
