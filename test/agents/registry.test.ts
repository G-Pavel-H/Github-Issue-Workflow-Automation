import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES, AGENTS_DIR } from '../../src/agents/registry.js';
import { TIER_MODELS } from '../../src/llm/models.js';

describe('role registry', () => {
  it('maps tiers to the expected model IDs', () => {
    expect(TIER_MODELS.triage).toBe('claude-haiku-4-5');
    expect(TIER_MODELS.implementation).toBe('claude-sonnet-4-6');
    expect(TIER_MODELS.review).toBe('claude-opus-4-8');
  });

  it('defines the Phase 3 example roles', () => {
    expect(ROLES['example-echo']).toBeDefined();
    expect(ROLES['example-tool-pinger']).toBeDefined();
  });

  it('every role points at an instruction file that exists', () => {
    for (const role of Object.values(ROLES)) {
      const contents = readFileSync(join(AGENTS_DIR, role.instructionFile), 'utf-8');
      expect(contents.length).toBeGreaterThan(0);
    }
  });

  it('the tool-pinger role declares a ping tool and a round cap', () => {
    const role = ROLES['example-tool-pinger']!;
    expect(role.tools?.map((t) => t.spec.name)).toContain('ping');
    expect(role.maxToolRounds).toBeGreaterThan(0);
  });

  it('defines the Phase 4 pipeline roles on the expected tiers', () => {
    expect(ROLES['intake']).toBeDefined();
    expect(ROLES['intake']!.tier).toBe('triage');
    expect(ROLES['intake']!.schema).toBeDefined();

    expect(ROLES['product-owner']).toBeDefined();
    expect(ROLES['product-owner']!.tier).toBe('review');
    expect(ROLES['product-owner']!.schema).toBeDefined();
  });
});
