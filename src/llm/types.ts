/** Token usage from a single model call. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** A system-prompt block. The last stable block carries `cacheControl` for prompt caching. */
export interface SystemBlock {
  text: string;
  cacheControl?: 'ephemeral';
}

export interface TextBlock {
  type: 'text';
  text: string;
  /** Marks the end of a cacheable prefix (prompt caching), mirroring `SystemBlock.cacheControl`. */
  cacheControl?: 'ephemeral';
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/** Blocks the model produces. */
export type ContentBlock = TextBlock | ToolUseBlock;
/** Blocks that may appear in a message we send back. */
export type MessageBlock = ContentBlock | ToolResultBlock;

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | MessageBlock[];
}

/** A tool the model may call (Anthropic tool spec shape). */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolChoice {
  type: 'auto' | 'any' | 'tool';
  name?: string;
}

export interface LlmRequest {
  model: string;
  system: SystemBlock[];
  messages: LlmMessage[];
  maxTokens: number;
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
  /** Opaque `output_config.format` object (e.g. from the SDK's zodOutputFormat). */
  outputFormat?: unknown;
}

export interface LlmResponse {
  stopReason: string;
  content: ContentBlock[];
  usage: Usage;
  model: string;
}

/** The provider boundary. Real impl wraps the Anthropic SDK; tests use a fake. */
export interface LlmProvider {
  createMessage(req: LlmRequest): Promise<LlmResponse>;
}
