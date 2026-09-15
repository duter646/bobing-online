import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limiter.js";

describe("rate limiter", () => {
  it("rejects requests over the limit and resets after the window", () => {
    const limiter = new RateLimiter();
    limiter.consume("player", 2, 1_000, 10_000);
    limiter.consume("player", 2, 1_000, 10_100);
    expect(() => limiter.consume("player", 2, 1_000, 10_200)).toThrow("操作过于频繁");
    expect(() => limiter.consume("player", 2, 1_000, 11_001)).not.toThrow();
  });
});
