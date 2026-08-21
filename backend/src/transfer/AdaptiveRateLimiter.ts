export class AdaptiveRateLimiter {
  private currentConcurrency: number;
  private minConcurrency: number;
  private maxConcurrency: number;
  private lastDownscaleTime: number = 0;
  private lastUpscaleTime: number = 0;
  
  private lastBandwidthCheckTime: number = Date.now();
  private lastBandwidth: number = 0;
  private recentErrorsCount: number = 0;
  private recentSuccessCount: number = 0;

  constructor(defaultConcurrency: number = 16, min: number = 2, max: number = 30) {
    const envInitial = process.env.TRANSFER_INITIAL_CONCURRENCY ? parseInt(process.env.TRANSFER_INITIAL_CONCURRENCY, 10) : NaN;
    const envMin = process.env.TRANSFER_MIN_CONCURRENCY ? parseInt(process.env.TRANSFER_MIN_CONCURRENCY, 10) : NaN;
    const envMax = process.env.TRANSFER_MAX_CONCURRENCY ? parseInt(process.env.TRANSFER_MAX_CONCURRENCY, 10) : NaN;

    this.minConcurrency = !isNaN(envMin) ? envMin : min;
    this.maxConcurrency = !isNaN(envMax) ? envMax : max;
    this.currentConcurrency = !isNaN(envInitial) ? envInitial : Math.min(defaultConcurrency, this.maxConcurrency);
  }

  public getConcurrency(): number {
    return this.currentConcurrency;
  }
  
  public setMaxConcurrency(max: number) {
    this.maxConcurrency = max;
    if (this.currentConcurrency > max) {
      this.currentConcurrency = max;
    }
  }

  /**
   * Called when 429/403 rate limits or 5xx server errors occur.
   */
  public reportRateLimit() {
    const now = Date.now();
    this.recentErrorsCount++;
    // Multiplicative decrease with 5s cooldown
    if (now - this.lastDownscaleTime > 5000) {
      const newConcurrency = Math.max(this.minConcurrency, Math.floor(this.currentConcurrency * 0.75));
      if (newConcurrency !== this.currentConcurrency) {
        console.log(`[RateLimiter] Rate limit hit (429/5xx). Downscaling concurrency: ${this.currentConcurrency} -> ${newConcurrency}`);
        this.currentConcurrency = newConcurrency;
      }
      this.lastDownscaleTime = now;
    }
  }

  /**
   * Called periodically with current measured throughput.
   */
  public reportBandwidth(bytesPerSecond: number) {
    const now = Date.now();
    
    // Evaluate tuning at most once every 10 seconds, with at least 15s after last downscale
    if (now - this.lastBandwidthCheckTime > 10000 && now - this.lastDownscaleTime > 15000) {
      // Additive increase if bandwidth is strong and error rate is low
      if (bytesPerSecond > 50 * 1024 && this.recentErrorsCount === 0) {
        if (bytesPerSecond >= this.lastBandwidth * 1.1 && this.currentConcurrency < this.maxConcurrency) {
          this.currentConcurrency = Math.min(this.maxConcurrency, this.currentConcurrency + 2);
          this.lastUpscaleTime = now;
          console.log(`[RateLimiter] Throughput increasing (${(bytesPerSecond / 1024 / 1024).toFixed(2)} MB/s). Upscaled concurrency to ${this.currentConcurrency}`);
        }
      }
      
      this.recentErrorsCount = 0;
      this.recentSuccessCount = 0;
      this.lastBandwidth = bytesPerSecond;
      this.lastBandwidthCheckTime = now;
    }
  }

  public reportSuccess() {
    this.recentSuccessCount++;
  }
}

