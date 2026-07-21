import type { LlmProvider } from './types.js';
import type { CredentialVault } from '../secrets/credential-vault.js';

/**
 * Resolves the `LlmProvider` to use for a given installation's run (Phase 12). This is
 * where per-installation billing happens: each run's model calls go to a provider built
 * from *that installation's* key. Injected into the `LlmGateway`, which calls it with the
 * run's `installationId` before every model call.
 */
export type ProviderResolver = (installationId: number) => Promise<LlmProvider>;

/** Build an `LlmProvider` from a plaintext API key. Injectable so tests avoid the real SDK. */
export type ProviderFactory = (apiKey: string) => LlmProvider;

/**
 * Thrown when an installation has no key on file and no operator fallback is allowed.
 * Propagates unchanged through the gateway (never caught there) so it refuses *before*
 * any model call — the worker turns it into a graceful "set up your key" refusal.
 */
export class MissingInstallationKeyError extends Error {
  constructor(readonly installationId: number) {
    super(`No Anthropic API key on file for installation ${installationId}`);
    this.name = 'MissingInstallationKeyError';
  }
}

export interface ProviderResolverOptions {
  vault: CredentialVault;
  /** Build a provider from a plaintext key (default in prod: `new AnthropicProvider(key)`). */
  factory: ProviderFactory;
  /** Operator fallback for self-host / dogfooding — off unless explicitly enabled. */
  allowPlatformFallback?: boolean;
  /** The operator's platform key, used only when `allowPlatformFallback` is true. */
  platformKey?: string;
}

/**
 * Resolution order: the installation's own stored key → (if fallback is enabled) the
 * operator platform key → otherwise refuse with `MissingInstallationKeyError`. Resolving
 * per call (not once at startup) means a rotated key takes effect on the next call and
 * two installations never share a provider.
 */
export function buildProviderResolver(opts: ProviderResolverOptions): ProviderResolver {
  return async (installationId: number): Promise<LlmProvider> => {
    const key = await opts.vault.getAnthropicKey(installationId);
    if (key) return opts.factory(key);
    if (opts.allowPlatformFallback && opts.platformKey) return opts.factory(opts.platformKey);
    throw new MissingInstallationKeyError(installationId);
  };
}

/** Wrap a fixed provider as a resolver — used by tests and by the gateway's compat path. */
export function constantProviderResolver(provider: LlmProvider): ProviderResolver {
  return async () => provider;
}
