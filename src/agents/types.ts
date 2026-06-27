import type { ZodTypeAny } from 'zod';
import type { LlmGateway } from '../llm/gateway.js';
import type { ModelTier } from '../llm/models.js';
import type { ToolSpec } from '../llm/types.js';
import type { Logger } from '../log.js';

/** A tool a role may call: its spec (sent to the model) + a handler (run locally). */
export interface ToolDefinition {
  spec: ToolSpec;
  handler(input: unknown): Promise<string>;
}

/**
 * A role = an instruction file + a model tier + an optional output schema + an
 * optional tool allowlist. Adding an agent later is just one of these + a registry
 * entry; the runner provides all invocation plumbing.
 */
export interface RoleDefinition {
  name: string;
  /** Markdown instruction file under the top-level `agents/` directory. */
  instructionFile: string;
  tier: ModelTier;
  /** Zod schema for schema-constrained (structured) output. */
  schema?: ZodTypeAny;
  tools?: ToolDefinition[];
  /** Cap on model calls in a tool-use loop. */
  maxToolRounds?: number;
  maxTokens?: number;
}

export interface AgentRunContext {
  runId: number;
  gateway: LlmGateway;
  log: Logger;
}
