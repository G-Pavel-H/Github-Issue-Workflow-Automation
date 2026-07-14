import Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  MessageBlock,
} from './types.js';

function toSdkBlock(block: MessageBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case 'text':
      return {
        type: 'text',
        text: block.text,
        ...(block.cacheControl ? { cache_control: { type: 'ephemeral' as const } } : {}),
      };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
  }
}

/**
 * Production LlmProvider wrapping the Anthropic SDK. This is the one isolated
 * SDK adapter (verified live, not in CI). It maps our provider-agnostic request
 * shape to `messages.create` params and the response back — including prompt-cache
 * breakpoints and `output_config.format` for schema-constrained output.
 */
export class AnthropicProvider implements LlmProvider {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async createMessage(req: LlmRequest): Promise<LlmResponse> {
    const system: Anthropic.TextBlockParam[] = req.system.map((b) => ({
      type: 'text',
      text: b.text,
      ...(b.cacheControl ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }));

    const messages: Anthropic.MessageParam[] = req.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map(toSdkBlock),
    }));

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system,
      messages,
    };
    if (req.tools) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }
    if (req.toolChoice) body.tool_choice = req.toolChoice;
    if (req.outputFormat) body.output_config = { format: req.outputFormat };

    const res = await this.client.messages.create(
      body as unknown as Anthropic.MessageCreateParamsNonStreaming,
    );

    const content: ContentBlock[] = [];
    for (const block of res.content) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text });
      else if (block.type === 'tool_use')
        content.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
    }

    return {
      stopReason: res.stop_reason ?? 'end_turn',
      content,
      usage: {
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
        cacheCreationInputTokens: res.usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: res.usage.cache_read_input_tokens ?? 0,
      },
      model: res.model,
    };
  }
}
