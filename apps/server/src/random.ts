import { randomBytes, randomInt, randomUUID } from "node:crypto";
import type { DiceFace } from "@bobing/domain";

export interface RandomSource {
  id(): string;
  token(): string;
  unit(): number;
  die(): DiceFace;
  roomCode(): string;
}

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export const secureRandom: RandomSource = {
  id: randomUUID,
  token: () => randomBytes(32).toString("base64url"),
  unit: () => randomInt(0, 2 ** 24) / 2 ** 24,
  die: () => randomInt(1, 7) as DiceFace,
  roomCode: () => Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)]).join("")
};
