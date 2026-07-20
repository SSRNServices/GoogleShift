export class AdaptiveRateLimiter {
  private currentConcurrency: number;
  private minConcurrency: number;
  private maxConcurrency: number;
  private lastDownscaleTime: number = 0;
  private lastUpscaleTime: number = 0;

  constructor(defaultConcurrency: number = 10, min: number = 2, max: number = 20) {
    this.currentConcurrency = defaultConcurrency;
    this.minConcurrency = min;
    this.maxConcurrency = max;
  }

  public getConcurrency(): number {
    return this.currentConcurrency;
  }

  public reportRateLimit() {
    const now = Date.now();
    // Only downscale at most once every 5 seconds to avoid over-reacting to a burst of 429s
    if (now - this.lastDownscaleTime > 5000) {
      this.currentConcurrency = Math.max(this.minConcurrency, this.currentConcurrency - 2);
      this.lastDownscaleTime = now;
      console.log(`[RateLimiter] Downscaled concurrency to ${this.currentConcurrency} due to rate limits`);
    }
  }

  public reportSuccess() {
    const now = Date.now();
    // If stable for 30 seconds since the last change (downscale or upscale), we can increase concurrency
    const lastChange = Math.max(this.lastDownscaleTime, this.lastUpscaleTime);
    if (now - lastChange > 30000 && this.currentConcurrency < this.maxConcurrency) {
      this.currentConcurrency = Math.min(this.maxConcurrency, this.currentConcurrency + 1);
      this.lastUpscaleTime = now;
      console.log(`[RateLimiter] Upscaled concurrency to ${this.currentConcurrency}`);
    }
  }
}
