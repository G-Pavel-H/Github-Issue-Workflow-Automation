import { describe, it, expect } from 'vitest';
import { computeBackoffMs, MAX_BACKOFF_MS, JOB_BACKOFF_BASE_MS } from '../../src/worker/retry.js';

describe('computeBackoffMs', () => {
  it('waits exactly the base delay on the first retry', () => {
    expect(computeBackoffMs(1, 1000)).toBe(1000);
  });

  it('doubles each subsequent attempt', () => {
    expect(computeBackoffMs(2, 1000)).toBe(2000);
    expect(computeBackoffMs(3, 1000)).toBe(4000);
    expect(computeBackoffMs(4, 1000)).toBe(8000);
  });

  it('is monotonic non-decreasing in attempts', () => {
    let prev = 0;
    for (let a = 1; a <= 12; a++) {
      const v = computeBackoffMs(a, JOB_BACKOFF_BASE_MS);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('caps at MAX_BACKOFF_MS no matter how high the attempt count', () => {
    expect(computeBackoffMs(50, JOB_BACKOFF_BASE_MS)).toBe(MAX_BACKOFF_MS);
  });

  it('defaults to the base backoff constant', () => {
    expect(computeBackoffMs(1)).toBe(JOB_BACKOFF_BASE_MS);
  });
});
