import { describe, test, expect } from 'vitest';
import { AdaptiveRateLimiter } from '../src/transfer/AdaptiveRateLimiter';

describe('Bucket Concurrency & Rate Limiter Stability', () => {
  test('AdaptiveRateLimiter maintains min/max concurrency bounds', () => {
    const limiter = new AdaptiveRateLimiter(16, 2, 20);
    expect(limiter.getConcurrency()).toBe(16);

    limiter.setMaxConcurrency(8);
    expect(limiter.getConcurrency()).toBe(8);

    limiter.reportRateLimit();
    expect(limiter.getConcurrency()).toBeGreaterThanOrEqual(2);
  });

  test('AdaptiveRateLimiter does not downscale on minor bandwidth drops without errors', () => {
    const limiter = new AdaptiveRateLimiter(10, 2, 20);
    limiter.reportBandwidth(5 * 1024 * 1024); // 5 MB/s
    limiter.reportBandwidth(3 * 1024 * 1024); // 3 MB/s (40% drop)
    
    // Concurrency should stay at 10, avoiding rate limit oscillation
    expect(limiter.getConcurrency()).toBe(10);
  });
});
