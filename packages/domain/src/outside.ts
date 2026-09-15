import type { OutsideRule } from "./types.js";

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export function outsideProbability(strength: number, rule: OutsideRule): number {
  const safeStrength = clamp(strength, 0, 1);
  if (safeStrength <= rule.threshold) return 0;
  const normalized = clamp((safeStrength - rule.threshold) / (1 - rule.threshold), 0, 1);
  return rule.maxProbability * normalized ** rule.exponent;
}

export function isOutside(strength: number, rule: OutsideRule, randomUnit: number): boolean {
  if (randomUnit < 0 || randomUnit >= 1) throw new RangeError("randomUnit must be in [0, 1)");
  return randomUnit < outsideProbability(strength, rule);
}
