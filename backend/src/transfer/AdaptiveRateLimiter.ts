export class AdaptiveRateLimiter {
  private currentConcurrency: number;
  private minConcurrency: number;
  private maxConcurrency: number;
  private lastDownscaleTime: number = 0;
  private lastUpscaleTime: number = 0;
  
  private lastBandwidthCheckTime: number = Date.now();
  private lastBandwidth: number = 0;

  constructor(defaultConcurrency: number = 16, min: number = 4, max: number = 30) {
    const envInitial = process.env.TRANSFER_INITIAL_CONCURRENCY ? parseInt(process.env.TRANSFER_INITIAL_CONCURRENCY, 10) : NaN;
    const envMin = process.env.TRANSFER_MIN_CONCURRENCY ? parseInt(process.env.TRANSFER_MIN_CONCURRENCY, 10) : NaN;
    const envMax = process.env.TRANSFER_MAX_CONCURRENCY ? parseInt(process.env.TRANSFER_MAX_CONCURRENCY, 10) : NaN;

    this.minConcurrency = !isNaN(envMin) ? envMin : min;
    this.maxConcurrency = !isNaN(envMax) ? envMax : max;
    this.currentConcurrency = !isNaN(envInitial) ? envInitial : defaultConcurrency;
  }

  public getConcurrency(): number {
    return this.currentConcurrency;
  }
  
  public setMaxConcurrency(max: number) {
    this.maxConcurrency = max;
  }

  public reportRateLimit() {
    const now = Date.now();
    // Aggressive exponential backoff
    if (now - this.lastDownscaleTime > 2000) {
      this.currentConcurrency = Math.max(this.minConcurrency, Math.floor(this.currentConcurrency * 0.5));
      this.lastDownscaleTime = now;
      console.log(`[RateLimiter] 429/403 hit. Downscaled aggressively to ${this.currentConcurrency}`);
    }
  }

  public reportBandwidth(bytesPerSecond: number) {
    const now = Date.now();
    
    if (now - this.lastBandwidthCheckTime > 5000 && now - this.lastDownscaleTime > 10000) {
       // Tune concurrency if we have traffic > 10 KB/s
       if (bytesPerSecond > 10240) {
           if (bytesPerSecond >= this.lastBandwidth * 0.95 && this.currentConcurrency < this.maxConcurrency) {
              this.currentConcurrency = Math.min(this.maxConcurrency, this.currentConcurrency + 4);
              this.lastUpscaleTime = now;
              console.log(`[RateLimiter] Probing bandwidth. Upscaled to ${this.currentConcurrency}`);
           } else if (bytesPerSecond < this.lastBandwidth * 0.8) {
              this.currentConcurrency = Math.max(this.minConcurrency, this.currentConcurrency - 2);
              console.log(`[RateLimiter] Throughput plateaued/dropped. Scaling back to ${this.currentConcurrency}`);
           }
       }
       this.lastBandwidth = bytesPerSecond;
       this.lastBandwidthCheckTime = now;
    }
  }

  public reportSuccess() {
  }
}
