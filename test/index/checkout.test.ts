import { describe, it, expect } from 'vitest';
import { redactToken } from '../../src/index/checkout.js';

describe('redactToken', () => {
  it('removes every occurrence of the token', () => {
    const token = 'ghs_secret123';
    const text = `cloning https://x-access-token:${token}@github.com/acme/widgets.git failed; ${token}`;
    const out = redactToken(text, token);
    expect(out).not.toContain(token);
    expect(out).toContain('***');
  });

  it('is a no-op for an empty token', () => {
    expect(redactToken('nothing to redact', '')).toBe('nothing to redact');
  });
});
