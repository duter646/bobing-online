import type { AwardResult, ChampionRank, DiceFace, OutsideRule, PrizeTier } from "@bobing/domain";
import type { ThrowProfile } from "@bobing/protocol";

export type RoomState = "LOBBY" | "PLAYING" | "PAUSED" | "FINISHED" | "EXPIRED";

export interface Member {
  id: string;
  sessionId: string;
  userId?: string;
  displayName: string;
  seatNo: number;
  role: "HOST" | "PLAYER";
  status: "ACTIVE" | "LEFT";
  online: boolean;
}

export interface PrizePool { tier: PrizeTier; initial: number; remaining: number }
export interface PrizeConfig { tier: PrizeTier; displayName: string; quantity: number }
export interface Champion { rollId: string; memberId: string; rank: ChampionRank }
export interface Game {
  id: string;
  status: "PLAYING" | "PAUSED" | "FINISHED";
  currentMemberId: string;
  roundNo: number;
  turnNo: number;
  prizes: PrizePool[];
  champion?: Champion;
  ending?: {
    triggeredAtTurnNo: number;
    finishAfterRoundNo: number;
  };
}

export interface Room {
  id: string;
  code: string;
  state: RoomState;
  version: number;
  sequence: number;
  hostMemberId: string;
  rulePresetId: "xiamen-traditional-v1";
  maxPlayers: number;
  outsideRule: OutsideRule;
  prizeConfig: PrizeConfig[];
  members: Member[];
  game?: Game;
  createdAt: string;
}

export interface RollResolution {
  rollId: string;
  memberId: string;
  outcome: "DICE" | "OUTSIDE";
  dice: DiceFace[] | null;
  outsideProbabilityBasisPoints: number;
  visualSeed: string;
  throwProfile: ThrowProfile;
  award: AwardResult;
  claims: Array<{ tier: PrizeTier; quantity: 1 }>;
  nextMemberId: string;
  gameFinished: boolean;
}

export interface RoomEvent<T = unknown> {
  protocolVersion: 1;
  eventId: string;
  roomId: string;
  sequence: number;
  roomVersion: number;
  occurredAt: string;
  payload: T;
}

export interface StoredRoomEvent<T = unknown> {
  type: string;
  event: RoomEvent<T>;
}

export type RoomSync =
  | { mode: "snapshot"; snapshot: Room }
  | { mode: "events"; events: StoredRoomEvent[]; roomVersion: number; sequence: number };
