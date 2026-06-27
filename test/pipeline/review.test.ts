import { describe, it, expect } from 'vitest';
import { renderPrBody, renderPrTitle, renderReviewedComment } from '../../src/pipeline/review.js';
import type { Plan, Review, Spec } from '../../src/pipeline/schemas.js';

const spec: Spec = {
  summary: 'Add a JSON export of the report.',
  requirements: [{ id: 'R1', statement: 'Export is JSON.', confidence: 'explicit' }],
  acceptanceCriteria: [{ id: 'AC1', given: 'data', when: 'export', then: 'json produced' }],
  nonGoals: ['CSV export'],
  edgeCases: [],
  assumptions: ['Timestamps are UTC'],
  openQuestions: [],
};

const plan: Plan = {
  summary: 'Add an exporter module.',
  approach: 'Reuse the serializer.',
  affectedFiles: [{ path: 'src/export.ts', change: 'add', reason: 'exporter' }],
  contracts: [],
  dataChanges: [],
  testStrategy: ['unit test exportJson'],
};

const review: Review = {
  verdict: 'approve',
  summary: 'Clean, matches the spec.',
  findings: [{ severity: 'info', note: 'Consider a streaming writer later', file: 'src/export.ts' }],
};

describe('renderPrTitle', () => {
  it('includes the issue number and title', () => {
    const title = renderPrTitle({ title: 'JSON export' }, 42);
    expect(title).toContain('#42');
    expect(title).toContain('JSON export');
  });
});

describe('renderPrBody', () => {
  const body = renderPrBody({ spec, plan, review, issueNumber: 42 });

  it('summarizes spec, plan, and assumptions', () => {
    expect(body).toContain('Add a JSON export');
    expect(body).toContain('Add an exporter module');
    expect(body).toContain('Timestamps are UTC');
  });

  it('records the review verdict and links the issue', () => {
    expect(body.toLowerCase()).toContain('approve');
    expect(body).toContain('Resolves #42');
  });
});

describe('renderReviewedComment', () => {
  it('links the PR and surfaces the verdict', () => {
    const comment = renderReviewedComment('https://github.com/acme/widgets/pull/7', review);
    expect(comment).toContain('https://github.com/acme/widgets/pull/7');
    expect(comment.toLowerCase()).toContain('approve');
  });
});
