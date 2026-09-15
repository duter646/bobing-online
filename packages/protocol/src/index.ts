import { z } from "zod";

export const throwProfileSchema = z.object({
  start: z.object({ x: z.number().min(-1).max(1), y: z.number().min(-1).max(1) }),
  direction: z.object({ x: z.number().min(-1).max(1), y: z.number().min(-1).max(1) }),
  strength: z.number().min(0).max(1),
  holdDurationMs: z.number().int().min(0).max(10_000)
}).strict().refine(
  ({ direction }) => Math.hypot(direction.x, direction.y) >= 0.1,
  { message: "direction vector is too small", path: ["direction"] }
);

export type ThrowProfile = z.infer<typeof throwProfileSchema>;

export const commandEnvelopeSchema = <T extends z.ZodType>(payload: T) => z.object({
  protocolVersion: z.literal(1),
  commandId: z.string().min(8).max(128),
  roomId: z.string().min(8).max(64),
  expectedRoomVersion: z.number().int().nonnegative().optional(),
  payload
}).strict();

export const rollCommandSchema = commandEnvelopeSchema(z.object({ throwProfile: throwProfileSchema }).strict());
export const subscribeCommandSchema = commandEnvelopeSchema(z.object({ lastSequence: z.number().int().nonnegative().default(0) }).strict());
export const roomControlCommandSchema = commandEnvelopeSchema(z.object({}).strict());
export const transferHostCommandSchema = commandEnvelopeSchema(z.object({ memberId: z.string().min(8).max(64) }).strict());
export const prizeTierSchema = z.enum(["CHAMPION", "STRAIGHT", "THREE_REDS", "FOUR_ADVANCES", "TWO_RAISES", "ONE_SHOW"]);
export const updateSettingsCommandSchema = commandEnvelopeSchema(z.object({
  maxPlayers: z.number().int().min(2).max(12),
  prizes: z.array(z.object({ tier: prizeTierSchema, displayName: z.string().trim().min(1).max(40), quantity: z.number().int().min(0).max(999) }).strict()).length(6)
}).strict());
export const reactionCommandSchema = commandEnvelopeSchema(z.object({ reaction: z.enum(["CHEER", "CLAP", "WOW", "LUCK", "LAUGH"]) }).strict());

export type RollCommand = z.infer<typeof rollCommandSchema>;
export type SubscribeCommand = z.infer<typeof subscribeCommandSchema>;
export type RoomControlCommand = z.infer<typeof roomControlCommandSchema>;
export type TransferHostCommand = z.infer<typeof transferHostCommandSchema>;

export const protocolErrorCodes = [
  "UNAUTHENTICATED", "ROOM_NOT_FOUND", "ROOM_FULL", "ROOM_LOCKED", "NOT_A_MEMBER", "NOT_HOST",
  "INVALID_ROOM_STATE", "NOT_YOUR_TURN", "STALE_ROOM_VERSION", "COMMAND_CONFLICT", "RATE_LIMITED",
  "VALIDATION_FAILED", "PERSISTENCE_FAILED"
] as const;

export type ProtocolErrorCode = (typeof protocolErrorCodes)[number];
export interface ProtocolError { code: ProtocolErrorCode; message: string; details?: unknown }
export type CommandAck<T> = { ok: true; commandId: string; data: T } | { ok: false; commandId: string; error: ProtocolError };
