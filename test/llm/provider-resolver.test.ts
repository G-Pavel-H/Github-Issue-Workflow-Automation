import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { InMemoryStore } from '../../src/store/memory-store.js';
import { CredentialVault } from '../../src/secrets/credential-vault.js';
import {
  buildProviderResolver,
  MissingInstallationKeyError,
} from '../../src/llm/provider-resolver.js';
import type { LlmProvider } from '../../src/llm/types.js';

const masterKey = randomBytes(32);

/** A provider whose only observable property is the key it was built from. */
function fakeProviderFor(apiKey: string): LlmProvider & { apiKey: string } {
  return {
    apiKey,
    async createMessage() {
      throw new Error('not used in resolver tests');
    },
  };
}

describe('buildProviderResolver', () => {
  let store: InMemoryStore;
  let vault: CredentialVault;
  const factory = (apiKey: string) => fakeProviderFor(apiKey);
  beforeEach(() => {
    store = new InMemoryStore();
    vault = new CredentialVault(store, masterKey);
  });

  it("builds a provider from the installation's own stored key", async () => {
    await vault.setAnthropicKey(42, 'sk-ant-42');
    const resolve = buildProviderResolver({ vault, factory });
    const provider = (await resolve(42)) as ReturnType<typeof fakeProviderFor>;
    expect(provider.apiKey).toBe('sk-ant-42');
  });

  it('resolves different installations to different keys (per-run isolation)', async () => {
    await vault.setAnthropicKey(1, 'sk-ant-one');
    await vault.setAnthropicKey(2, 'sk-ant-two');
    const resolve = buildProviderResolver({ vault, factory });
    expect(((await resolve(1)) as ReturnType<typeof fakeProviderFor>).apiKey).toBe('sk-ant-one');
    expect(((await resolve(2)) as ReturnType<typeof fakeProviderFor>).apiKey).toBe('sk-ant-two');
  });

  it('refuses with MissingInstallationKeyError when no key is on file and fallback is off', async () => {
    const resolve = buildProviderResolver({ vault, factory });
    await expect(resolve(42)).rejects.toBeInstanceOf(MissingInstallationKeyError);
  });

  it('does not fall back to the platform key unless fallback is explicitly enabled', async () => {
    const resolve = buildProviderResolver({
      vault,
      factory,
      allowPlatformFallback: false,
      platformKey: 'sk-ant-platform',
    });
    await expect(resolve(42)).rejects.toBeInstanceOf(MissingInstallationKeyError);
  });

  it('falls back to the operator platform key when fallback is enabled and no key is on file', async () => {
    const resolve = buildProviderResolver({
      vault,
      factory,
      allowPlatformFallback: true,
      platformKey: 'sk-ant-platform',
    });
    expect(((await resolve(42)) as ReturnType<typeof fakeProviderFor>).apiKey).toBe(
      'sk-ant-platform',
    );
  });

  it("prefers the installation's own key over the platform fallback", async () => {
    await vault.setAnthropicKey(42, 'sk-ant-42');
    const resolve = buildProviderResolver({
      vault,
      factory,
      allowPlatformFallback: true,
      platformKey: 'sk-ant-platform',
    });
    expect(((await resolve(42)) as ReturnType<typeof fakeProviderFor>).apiKey).toBe('sk-ant-42');
  });

  it('refuses when fallback is on but no platform key is configured', async () => {
    const resolve = buildProviderResolver({ vault, factory, allowPlatformFallback: true });
    await expect(resolve(42)).rejects.toBeInstanceOf(MissingInstallationKeyError);
  });
});
