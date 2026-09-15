import { AppError } from "./errors.js";

interface Bucket { count: number; resetsAt: number }

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  consume(key: string, limit: number, windowMs: number, now = Date.now()): void {
    const current = this.buckets.get(key);
    if (!current || current.resetsAt <= now) {
      this.buckets.set(key, { count: 1, resetsAt: now + windowMs });
      return;
    }
    if (current.count >= limit) throw new AppError("RATE_LIMITED", "操作过于频繁，请稍后再试", 429, { retryAfterMs: current.resetsAt - now });
    current.count += 1;
  }

  clear(): void { this.buckets.clear(); }
}
