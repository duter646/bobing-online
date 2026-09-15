import { describe, expect, it } from "vitest";
import { DEFAULT_OUTSIDE_RULE, evaluateRoll, outsideProbability } from "./index.js";

describe("xiamen-traditional-v1", () => {
  it.each([
    [[1, 1, 4, 4, 4, 4], "CHAMPION_WITH_GOLDEN_FLOWERS"],
    [[4, 4, 4, 4, 4, 4], "SIX_RED"],
    [[2, 2, 2, 2, 2, 2], "SIX_BLACK"],
    [[3, 4, 4, 4, 4, 4], "FIVE_REDS"],
    [[3, 3, 3, 3, 3, 6], "FIVE_OF_KIND"],
    [[2, 3, 4, 4, 4, 4], "CHAMPION"],
    [[1, 2, 3, 4, 5, 6], "STRAIGHT"],
    [[1, 2, 4, 4, 4, 6], "THREE_REDS"],
    [[2, 2, 2, 2, 4, 4], "FOUR_ADVANCES"],
    [[1, 2, 3, 4, 4, 6], "TWO_RAISES"],
    [[1, 1, 2, 3, 4, 6], "ONE_SHOW"],
    [[1, 1, 2, 2, 3, 3], "NOTHING"]
  ])("classifies %j as %s", (dice, award) => expect(evaluateRoll(dice as number[]).primary).toBe(award));

  it("classifies every ordered roll and is permutation invariant", () => {
    for (let value = 0; value < 6 ** 6; value += 1) {
      let cursor = value;
      const dice = Array.from({ length: 6 }, () => { const face = (cursor % 6) + 1; cursor = Math.floor(cursor / 6); return face; });
      const reversed = [...dice].reverse();
      expect(evaluateRoll(dice).primary).toBe(evaluateRoll(reversed).primary);
    }
  });
});

describe("outside probability", () => {
  it.each([[0.8, 0], [0.85, 0.015625], [0.9, 0.0625], [0.95, 0.140625], [1, 0.25]])(
    "maps strength %s", (strength, expected) => expect(outsideProbability(strength, DEFAULT_OUTSIDE_RULE)).toBeCloseTo(expected)
  );
});
