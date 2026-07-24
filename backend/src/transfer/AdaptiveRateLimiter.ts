export class AdaptiveRateLimiter {
  private currentConcurrency: number;
  private minConcurrency: number;
  private maxConcurrency: number;
  private lastDownscaleTime: number = 0;
  private lastUpscaleTime: number = 0;
  
  private lastBandwidthCheckTime: number = Date.now();
  private lastBandwidth: number = 0;

  constructor(defaultConcurrency: number = 10, min: number = 2, max: number = 50) {
    this.currentConcurrency = defaultConcurrency;
    this.minConcurrency = min;
    this.maxConcurrency = max;
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
       // Only tune if we have significant traffic (e.g. > 100 KB/s) to avoid tuning noise
       if (bytesPerSecond > 102400) {
           if (bytesPerSecond >= this.lastBandwidth * 0.95 && this.currentConcurrency < this.maxConcurrency) {
              this.currentConcurrency = Math.min(this.maxConcurrency, this.currentConcurrency + 5);
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
