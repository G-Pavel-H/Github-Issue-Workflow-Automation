import { resolve } from 'node:path';
import { z } from 'zod';
import { clarificationSchema, intakeSchema, specSchema } from '../pipeline/schemas.js';
import type { RoleDefinition, ToolDefinition } from './types.js';

export { TIER_MODELS } from '../llm/models.js';

/**
 * Top-level `agents/` directory holding role instruction files. Resolved relative
 * to this module so it works whether running from `src/` (tests) or `dist/`.
 */
export const AGENTS_DIR = resolve(import.meta.dirname, '..', '..', 'agents');

// --- Phase 3 throwaway demo roles (prove the abstraction; removable later) ---

const echoSchema = z.object({ echoed: z.string() });

const pingTool: ToolDefinition = {
  spec: {
    name: 'ping',
    description: 'Returns "pong". A stub tool used to exercise the tool-use loop.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  handler: async () => 'pong',
};

export const ROLES: Record<string, RoleDefinition> = {
  'example-echo': {
    name: 'example-echo',
    instructionFile: 'example-echo.md',
    tier: 'triage',
    schema: echoSchema,
    maxTokens: 256,
  },
  'example-tool-pinger': {
    name: 'example-tool-pinger',
    instructionFile: 'example-tool-pinger.md',
    tier: 'triage',
    tools: [pingTool],
    maxToolRounds: 3,
    maxTokens: 512,
  },

  // --- Phase 4 pipeline roles ---
  intake: {
    name: 'intake',
    instructionFile: 'intake.md',
    tier: 'triage',
    schema: intakeSchema,
    maxTokens: 1024,
  },
  'product-owner': {
    name: 'product-owner',
    instructionFile: 'product-owner.md',
    tier: 'review',
    schema: specSchema,
    maxTokens: 4096,
  },

  // --- Phase 5 clarification gate ---
  clarifier: {
    name: 'clarifier',
    instructionFile: 'clarifier.md',
    tier: 'triage',
    schema: clarificationSchema,
    maxTokens: 1024,
  },
};
