import type { Logger } from '../log.js';
import type { Store } from '../store/types.js';
import { TIER_MODELS, type ModelTier } from './models.js';
import { costNanoUsd, formatUsd } from './pricing.js';
import type {
  LlmMessage,
  LlmProvider,
  LlmResponse,
  SystemBlock,
  ToolChoice,
  ToolSpec,
} from './types.js';
import { constantProviderResolver, type ProviderResolver } from './provider-resolver.js';

/** Thrown when a run's budget is spent — the orchestrator stops at the next safe point. */
export class BudgetExhaustedError extends Error {
  constructor(
    readonly runId: number,
    readonly budgetRemainingNanoUsd: number,
  ) {
    super(`Run ${runId} budget exhausted (remaining ${budgetRemainingNanoUsd} nano-USD)`);
    this.name = 'BudgetExhaustedError';
  }
}

export interface GatewayCallParams {
  runId: number;
  /** Label recorded against the call (usually the agent role name). */
  role: string;
  /** Explicit model, or resolve one from `tier`. One of the two is required. */
  model?: string;
  tier?: ModelTier;
  system: SystemBlock[];
  messages: LlmMessage[];
  maxTokens?: number;
  tools?: ToolSpec[];
  toolChoice?: ToolChoice;
  outputFormat?: unknown;
}

export interface GatewayCallResult {
  response: LlmResponse;
  costNanoUsd: number;
  budgetRemainingNanoUsd: number;
}

const DEFAULT_MAX_TOKENS = 4096;

/**
 * The single instrumented chokepoint for all model calls. Resolves the model + the
 * per-installation provider, enforces the per-run budget, and logs tokens + dollar cost
 * against the run. Never make an uninstrumented model call — always go through here.
 *
 * The provider is resolved per call from the run's `installationId` (Phase 12), so each
 * installation's spend goes to its own Anthropic key. For convenience/back-compat the
 * constructor also accepts a fixed `LlmProvider`, which is wrapped as a constant resolver.
 */
export class LlmGateway {
  private readonly resolveProvider: ProviderResolver;

  constructor(
    providerOrResolver: LlmProvider | ProviderResolver,
    private readonly store: Store,
    private readonly log: Logger,
  ) {
    this.resolveProvider =
      typeof providerOrResolver === 'function'
        ? providerOrResolver
        : constantProviderResolver(providerOrResolver);
  }

  async call(params: GatewayCallParams): Promise<GatewayCallResult> {
    const model = params.model ?? (params.tier ? TIER_MODELS[params.tier] : undefined);
    if (!model) throw new Error('LlmGateway.call requires either `model` or `tier`');

    // Pre-check: refuse before spending if the budget is already exhausted.
    const run = await this.store.getRunById(params.runId);
    if (!run) throw new Error(`Run ${params.runId} not found`);
    const remainingBefore = run.budgetNanoUsd - run.spentNanoUsd;
    if (remainingBefore <= 0) {
      throw new BudgetExhaustedError(params.runId, remainingBefore);
    }

    // Resolve the installation's provider *before* spending. A missing key throws
    // MissingInstallationKeyError here — refusing before any model call or cost record.
    const provider = await this.resolveProvider(run.installationId);

    const response = await provider.createMessage({
      model,
      system: params.system,
      messages: params.messages,
      maxTokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
      tools: params.tools,
      toolChoice: params.toolChoice,
      outputFormat: params.outputFormat,
    });

    const cost = costNanoUsd(model, response.usage);
    const { budgetRemainingNanoUsd } = await this.store.recordLlmCall({
      runId: params.runId,
      role: params.role,
      model,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cacheCreationTokens: response.usage.cacheCreationInputTokens,
      cacheReadTokens: response.usage.cacheReadInputTokens,
      costNanoUsd: cost,
    });

    this.log.info(
      {
        runId: params.runId,
        role: params.role,
        model,
        usage: response.usage,
        cost: formatUsd(cost),
        budgetRemaining: formatUsd(budgetRemainingNanoUsd),
      },
      'LLM call',
    );

    return { response, costNanoUsd: cost, budgetRemainingNanoUsd };
  }
}
