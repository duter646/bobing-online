export type DiceFace = 1 | 2 | 3 | 4 | 5 | 6;
export type Dice = readonly [DiceFace, DiceFace, DiceFace, DiceFace, DiceFace, DiceFace];

export const awardCodes = [
  "OUTSIDE",
  "NOTHING",
  "ONE_SHOW",
  "TWO_RAISES",
  "FOUR_ADVANCES",
  "THREE_REDS",
  "STRAIGHT",
  "CHAMPION",
  "FIVE_OF_KIND",
  "FIVE_REDS",
  "SIX_BLACK",
  "SIX_RED",
  "CHAMPION_WITH_GOLDEN_FLOWERS"
] as const;

export type AwardCode = (typeof awardCodes)[number];
export type PrizeTier = "CHAMPION" | "STRAIGHT" | "THREE_REDS" | "FOUR_ADVANCES" | "TWO_RAISES" | "ONE_SHOW";

export interface ChampionRank {
  category: 1 | 2 | 3 | 4 | 5 | 6;
  remainderScore: number;
}

export interface AwardResult {
  primary: AwardCode;
  secondary: AwardCode[];
  normalizedDice: DiceFace[];
  championRank?: ChampionRank;
}

export interface OutsideRule {
  threshold: number;
  maxProbability: number;
  exponent: number;
}

export const DEFAULT_OUTSIDE_RULE: OutsideRule = {
  threshold: 0.8,
  maxProbability: 0.25,
  exponent: 2
};

export const DEFAULT_PRIZES: Readonly<Record<PrizeTier, number>> = {
  CHAMPION: 1,
  STRAIGHT: 2,
  THREE_REDS: 4,
  FOUR_ADVANCES: 8,
  TWO_RAISES: 16,
  ONE_SHOW: 32
};
