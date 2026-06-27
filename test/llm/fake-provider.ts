import type {
  ContentBlock,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  Usage,
} from '../../src/llm/types.js';

export const zeroUsage: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

export function usage(partial: Partial<Usage>): Usage {
  return { ...zeroUsage, ...partial };
}

export function textResponse(text: string, u: Partial<Usage> = {}): LlmResponse {
  return {
    stopReason: 'end_turn',
    content: [{ type: 'text', text }],
    usage: usage(u),
    model: 'fake',
  };
}

export function toolUseResponse(
  name: string,
  input: unknown,
  u: Partial<Usage> = {},
  id = 'toolu_1',
): LlmResponse {
  const content: ContentBlock[] = [{ type: 'tool_use', id, name, input }];
  return { stopReason: 'tool_use', content, usage: usage(u), model: 'fake' };
}

/** Scriptable provider: returns queued responses in order, records every request. */
export class FakeLlmProvider implements LlmProvider {
  readonly requests: LlmRequest[] = [];
  private queue: LlmResponse[] = [];
  /** When set, every createMessage returns a copy of this instead of draining the queue. */
  always?: LlmResponse;

  constructor(responses: LlmResponse[] = []) {
    this.queue = [...responses];
  }

  enqueue(...responses: LlmResponse[]): void {
    this.queue.push(...responses);
  }

  async createMessage(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const r = this.always ?? this.queue.shift();
    if (!r) throw new Error('FakeLlmProvider: no queued response');
    // Echo back the requested model unless the canned response set its own.
    return { ...r, model: r.model === 'fake' ? req.model : r.model };
  }
}
