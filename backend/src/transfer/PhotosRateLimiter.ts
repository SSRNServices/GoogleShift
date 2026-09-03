export class PhotosRateLimiter {
  private currentConcurrency: number;
  private minConcurrency: number;
  private maxConcurrency: number;
  private lastDownscaleTime: number = 0;
  private backoffUntil: number = 0;
  private consecutive429Count: number = 0;

  constructor(defaultConcurrency: number = 4, min: number = 1, max: number = 10) {
    const envInitial = process.env.PHOTOS_UPLOAD_CONCURRENCY ? parseInt(process.env.PHOTOS_UPLOAD_CONCURRENCY, 10) : NaN;
    const envMin = process.env.PHOTOS_MIN_CONCURRENCY ? parseInt(process.env.PHOTOS_MIN_CONCURRENCY, 10) : NaN;
    const envMax = process.env.PHOTOS_MAX_CONCURRENCY ? parseInt(process.env.PHOTOS_MAX_CONCURRENCY, 10) : NaN;

    this.minConcurrency = !isNaN(envMin) ? envMin : min;
    this.maxConcurrency = !isNaN(envMax) ? envMax : max;
    this.currentConcurrency = !isNaN(envInitial) ? envInitial : Math.min(defaultConcurrency, this.maxConcurrency);
  }

  public getConcurrency(): number {
    return this.currentConcurrency;
  }

  public async acquireToken(): Promise<void> {
    const now = Date.now();
    if (this.backoffUntil > now) {
      const waitMs = this.backoffUntil - now;
      console.log(`[PhotosRateLimiter] Throttling active. Waiting ${waitMs}ms before acquiring token...`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }

  public reportRateLimit(retryAfterSeconds?: number): number {
    const now = Date.now();
    this.consecutive429Count++;

    const baseDelay = retryAfterSeconds && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : Math.min(60000, Math.pow(2, this.consecutive429Count) * 1000 + Math.random() * 500);

    this.backoffUntil = now + baseDelay;

    if (now - this.lastDownscaleTime > 5000) {
      const newConcurrency = Math.max(this.minConcurrency, Math.floor(this.currentConcurrency * 0.75));
      if (newConcurrency !== this.currentConcurrency) {
        console.log(`[PhotosRateLimiter] Rate limit 429/5xx hit. Downscaling concurrency: ${this.currentConcurrency} -> ${newConcurrency}`);
        this.currentConcurrency = newConcurrency;
      }
      this.lastDownscaleTime = now;
    }

    return baseDelay;
  }

  public reportSuccess() {
    if (this.consecutive429Count > 0) {
      this.consecutive429Count = Math.max(0, this.consecutive429Count - 1);
    }
  }
}
