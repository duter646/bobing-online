import type { AwardCode, AwardResult, ChampionRank, Dice, DiceFace, PrizeTier } from "./types.js";

const CHAMPION_CATEGORY: Record<string, ChampionRank["category"]> = {
  CHAMPION: 1,
  FIVE_OF_KIND: 2,
  FIVE_REDS: 3,
  SIX_BLACK: 4,
  SIX_RED: 5,
  CHAMPION_WITH_GOLDEN_FLOWERS: 6
};

function validateDice(dice: readonly number[]): asserts dice is Dice {
  if (dice.length !== 6 || dice.some((face) => !Number.isInteger(face) || face < 1 || face > 6)) {
    throw new RangeError("dice must contain exactly six integer faces from 1 to 6");
  }
}

function result(primary: AwardCode, normalizedDice: DiceFace[], secondary: AwardCode[] = [], remainderScore = 0): AwardResult {
  const category = CHAMPION_CATEGORY[primary];
  return {
    primary,
    secondary,
    normalizedDice,
    ...(category ? { championRank: { category, remainderScore } } : {})
  };
}

export function evaluateRoll(input: readonly number[]): AwardResult {
  validateDice(input);
  const dice = [...input].sort((a, b) => a - b) as DiceFace[];
  const counts = Array.from({ length: 7 }, () => 0);
  for (const face of dice) counts[face] = (counts[face] ?? 0) + 1;
  const repeatedSix = counts.findIndex((count) => count === 6);
  if (repeatedSix > 0) return result(repeatedSix === 4 ? "SIX_RED" : "SIX_BLACK", dice, [], repeatedSix);

  const repeatedFive = counts.findIndex((count) => count === 5);
  if (repeatedFive > 0) {
    const remainder = dice.find((face) => face !== repeatedFive) ?? 0;
    return result(repeatedFive === 4 ? "FIVE_REDS" : "FIVE_OF_KIND", dice, [], remainder);
  }

  if (counts[4] === 4) {
    const remainder = dice.filter((face) => face !== 4);
    const score = (remainder[0] ?? 0) + (remainder[1] ?? 0);
    return result(remainder[0] === 1 && remainder[1] === 1 ? "CHAMPION_WITH_GOLDEN_FLOWERS" : "CHAMPION", dice, [], score);
  }
  if (counts.slice(1).every((count) => count === 1)) return result("STRAIGHT", dice);
  if (counts[4] === 3) return result("THREE_REDS", dice);

  const repeatedFour = counts.findIndex((count, face) => face !== 4 && count === 4);
  if (repeatedFour > 0) {
    const secondary = counts[4] === 2 ? ["TWO_RAISES" as const] : counts[4] === 1 ? ["ONE_SHOW" as const] : [];
    return result("FOUR_ADVANCES", dice, secondary);
  }
  if (counts[4] === 2) return result("TWO_RAISES", dice);
  if (counts[4] === 1) return result("ONE_SHOW", dice);
  return result("NOTHING", dice);
}

export function compareChampion(left: ChampionRank, right: ChampionRank): number {
  return left.category - right.category || left.remainderScore - right.remainderScore;
}

export function prizeTiersFor(resultValue: AwardResult): PrizeTier[] {
  const primary = resultValue.championRank ? "CHAMPION" : resultValue.primary;
  const tiers: PrizeTier[] = [];
  if (["CHAMPION", "STRAIGHT", "THREE_REDS", "FOUR_ADVANCES", "TWO_RAISES", "ONE_SHOW"].includes(primary)) {
    tiers.push(primary as PrizeTier);
  }
  for (const award of resultValue.secondary) tiers.push(award as PrizeTier);
  return tiers;
}
