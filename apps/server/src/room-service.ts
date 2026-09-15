import { DEFAULT_OUTSIDE_RULE, DEFAULT_PRIZES, compareChampion, evaluateRoll, isOutside, outsideProbability, prizeTiersFor, type AwardResult, type DiceFace, type PrizeTier } from "@bobing/domain";
import type { ThrowProfile } from "@bobing/protocol";
import { AppError } from "./errors.js";
import type { Repository } from "./database.js";
import type { RandomSource } from "./random.js";
import type { Member, Room, RoomEvent, RollResolution, RoomSync } from "./types.js";

export interface Session { id: string; displayName: string }
const PRIZE_NAMES: Record<PrizeTier, string> = { CHAMPION: "状元", STRAIGHT: "对堂", THREE_REDS: "三红", FOUR_ADVANCES: "四进", TWO_RAISES: "二举", ONE_SHOW: "一秀" };

export class RoomService {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly repository: Repository, private readonly random: RandomSource) {
    for (const room of repository.loadRooms()) {
      const staleOnlineMemberIds = room.members.filter((member) => member.online).map((member) => member.id);
      for (const member of room.members) member.online = false;
      if (staleOnlineMemberIds.length > 0) {
        room.version += 1;
        room.sequence += 1;
        const event = this.event(room, { memberIds: staleOnlineMemberIds, online: false }, this.random.id());
        repository.saveStateEvent(room, event, "room:presence-reset", null, null);
      } else {
        repository.saveRecoverySnapshot(room);
      }
      this.rooms.set(room.id, room);
    }
  }

  createSession(displayName: string): { sessionId: string; token: string; expiresAt: string } {
    const name = displayName.trim();
    if (name.length < 1 || name.length > 24 || /[\u0000-\u001f\u007f]/.test(name)) throw new AppError("VALIDATION_FAILED", "昵称应为 1～24 个可见字符");
    const sessionId = this.random.id();
    const token = this.random.token();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 86_400_000).toISOString();
    this.repository.createSession(sessionId, token, name, now.toISOString(), expiresAt);
    return { sessionId, token, expiresAt };
  }

  authenticate(token: string | undefined): Session {
    if (!token) throw new AppError("UNAUTHENTICATED", "缺少会话令牌", 401);
    const session = this.repository.resolveSession(token, new Date().toISOString());
    if (!session) throw new AppError("UNAUTHENTICATED", "会话无效或已过期", 401);
    return session;
  }

  createRoom(session: Session, maxPlayers = 12): Room {
    return this.createRoomWithReportToken(session, maxPlayers).room;
  }

  createRoomWithReportToken(session: Session, maxPlayers = 12): { room: Room; reportToken: string } {
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 12) throw new AppError("VALIDATION_FAILED", "玩家上限应为 2～12");
    let code = this.random.roomCode();
    const existingCodes = new Set([...this.rooms.values()].map((room) => room.code));
    for (let attempt = 0; existingCodes.has(code) && attempt < 10; attempt += 1) code = this.random.roomCode();
    if (existingCodes.has(code)) throw new AppError("PERSISTENCE_FAILED", "暂时无法生成房间码", 500);
    const memberId = this.random.id();
    const room: Room = {
      id: this.random.id(), code, state: "LOBBY", version: 1, sequence: 0, hostMemberId: memberId,
      rulePresetId: "xiamen-traditional-v1", maxPlayers, outsideRule: { ...DEFAULT_OUTSIDE_RULE },
      prizeConfig: Object.entries(DEFAULT_PRIZES).map(([tier, quantity]) => ({ tier: tier as PrizeTier, displayName: PRIZE_NAMES[tier as PrizeTier], quantity })),
      members: [{ id: memberId, sessionId: session.id, displayName: session.displayName, seatNo: 1, role: "HOST", status: "ACTIVE", online: false }],
      createdAt: new Date().toISOString()
    };
    const reportToken = this.random.token();
    this.repository.saveNewRoom(room, reportToken);
    this.rooms.set(room.id, room);
    return { room: this.view(room), reportToken };
  }

  joinRoom(session: Session, code: string): Room {
    const room = [...this.rooms.values()].find((candidate) => candidate.code === code.trim().toUpperCase());
    if (!room) throw new AppError("ROOM_NOT_FOUND", "房间不存在", 404);
    const current = room.members.find((member) => member.sessionId === session.id && member.status === "ACTIVE");
    if (current) return this.view(room);
    if (room.state !== "LOBBY") throw new AppError("ROOM_LOCKED", "房间已经开始，暂时不能加入", 409);
    if (room.members.filter((member) => member.status === "ACTIVE").length >= room.maxPlayers) throw new AppError("ROOM_FULL", "房间人数已满", 409);
    if (room.members.some((member) => member.status === "ACTIVE" && member.displayName === session.displayName)) throw new AppError("VALIDATION_FAILED", "房间内已有同名玩家，请换一个昵称", 409);
    const before = structuredClone(room);
    room.members.push({ id: this.random.id(), sessionId: session.id, displayName: session.displayName, seatNo: room.members.length + 1, role: "PLAYER", status: "ACTIVE", online: false });
    room.version += 1;
    room.sequence += 1;
    const joinedMember = { ...room.members.at(-1)!, sessionId: "" };
    const event = this.event(room, { member: joinedMember }, this.random.id());
    try { this.repository.addMember(room, room.members.length - 1, event); } catch (error) { this.rooms.set(room.id, before); throw error; }
    return this.view(room);
  }

  getRoom(session: Session, roomId: string): Room {
    const room = this.requireRoom(roomId);
    this.requireMember(room, session.id);
    return this.view(room);
  }

  getRollPage(session: Session, roomId: string, afterTurn: number, limit: number) {
    const room = this.requireRoom(roomId);
    this.requireMember(room, session.id);
    if (!room.game) return { items: [], nextCursor: null };
    return this.repository.rollPage(room.game.id, afterTurn, limit);
  }

  getReport(session: Session, roomId: string) {
    const room = this.requireRoom(roomId);
    this.requireMember(room, session.id);
    return this.buildReport(room);
  }

  getReportCsv(session: Session, roomId: string): string {
    const room = this.requireRoom(roomId);
    const member = this.requireMember(room, session.id);
    if (member.id !== room.hostMemberId) throw new AppError("NOT_HOST", "只有房主可以导出战报", 403);
    const report = this.buildReport(room);
    const escape = (value: unknown) => `"${String(value).replaceAll('"', '""')}"`;
    const rows = report.players.map((player) => [player.seatNo, player.displayName, player.totalRolls, JSON.stringify(player.awards), JSON.stringify(player.prizes)].map(escape).join(","));
    return `\uFEFF座位,昵称,投掷次数,奖项统计,奖品统计\r\n${rows.join("\r\n")}\r\n`;
  }

  getPublicReport(roomId: string, token: string) {
    const room = this.requireRoom(roomId);
    if (!this.repository.verifyReportToken(roomId, token)) throw new AppError("UNAUTHENTICATED", "战报链接无效", 401);
    if (room.state !== "FINISHED") throw new AppError("INVALID_ROOM_STATE", "对局结束后才会公开战报", 409);
    return this.buildReport(room);
  }

  deleteReport(session: Session, roomId: string): void {
    const room = this.requireRoom(roomId);
    const member = this.requireMember(room, session.id);
    if (member.id !== room.hostMemberId) throw new AppError("NOT_HOST", "只有房主可以删除战报", 403);
    if (room.state !== "FINISHED" && room.state !== "EXPIRED") throw new AppError("INVALID_ROOM_STATE", "只能删除已结束的战报", 409);
    this.repository.deleteRoom(room.id);
    this.rooms.delete(room.id);
  }

  cleanupExpired(now = new Date()): number {
    const ids = this.repository.cleanupCandidates(
      new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString(),
      new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString()
    );
    for (const id of ids) { this.repository.deleteRoom(id); this.rooms.delete(id); }
    this.repository.cleanupExpiredSessions(now.toISOString());
    return ids.length;
  }

  private buildReport(room: Room) {
    const rolls = room.game ? this.repository.allRolls(room.game.id) : [];
    const players = room.members.map((member) => {
      const own = rolls.filter((roll) => roll.memberId === member.id);
      const awards: Record<string, number> = {};
      const prizes: Record<string, number> = {};
      for (const roll of own) {
        awards[roll.award.primary] = (awards[roll.award.primary] ?? 0) + 1;
        for (const claim of roll.claims) prizes[claim.tier] = (prizes[claim.tier] ?? 0) + claim.quantity;
      }
      return { memberId: member.id, displayName: member.displayName, seatNo: member.seatNo, totalRolls: own.length, awards, prizes };
    });
    return {
      roomId: room.id, code: room.code, state: room.state, rulePresetId: room.rulePresetId,
      createdAt: room.createdAt, champion: room.game?.champion ?? null, prizes: room.game?.prizes ?? [],
      totalRolls: rolls.length, players
    };
  }

  syncRoom(session: Session, roomId: string, lastSequence: number): RoomSync {
    const room = this.requireRoom(roomId);
    this.requireMember(room, session.id);
    if (lastSequence === room.sequence) return { mode: "events", events: [], roomVersion: room.version, sequence: room.sequence };
    const gap = room.sequence - lastSequence;
    if (lastSequence > 0 && gap > 0 && gap <= 200) {
      const events = this.repository.eventsAfter(room.id, lastSequence, 200);
      if (events.length === gap) return { mode: "events", events, roomVersion: room.version, sequence: room.sequence };
    }
    return { mode: "snapshot", snapshot: this.view(room) };
  }

  setPresence(session: Session, roomId: string, online: boolean): RoomEvent<{ memberId: string; online: boolean }> | undefined {
    const room = this.requireRoom(roomId);
    const member = this.requireMember(room, session.id);
    if (member.online === online) return undefined;
    const before = structuredClone(room);
    member.online = online;
    room.version += 1;
    room.sequence += 1;
    const event = this.event(room, { memberId: member.id, online }, this.random.id());
    try { this.repository.saveStateEvent(room, event, "room:member-updated", member.id, null); }
    catch (error) { this.rooms.set(room.id, before); throw error; }
    return event;
  }

  startRoom(session: Session, roomId: string, expectedVersion?: number): Room {
    const room = this.requireRoom(roomId);
    const member = this.requireMember(room, session.id);
    if (member.id !== room.hostMemberId) throw new AppError("NOT_HOST", "只有房主可以开始", 403);
    if (room.state !== "LOBBY") throw new AppError("INVALID_ROOM_STATE", "房间不在等待状态", 409);
    this.checkVersion(room, expectedVersion);
    const before = structuredClone(room);
    const active = room.members.filter((item) => item.status === "ACTIVE").sort((a, b) => a.seatNo - b.seatNo);
    if (active.length < 2) throw new AppError("INVALID_ROOM_STATE", "至少需要两名玩家才能开始", 409);
    room.state = "PLAYING";
    room.version += 1;
    room.sequence += 1;
    room.game = {
      id: this.random.id(), status: "PLAYING", currentMemberId: active[0]!.id, roundNo: 1, turnNo: 0,
      prizes: room.prizeConfig.map(({ tier, quantity }) => ({ tier, initial: quantity, remaining: quantity }))
    };
    const event = this.event(room, this.view(room), this.random.id());
    try { this.repository.startGame(room, event); } catch (error) { this.rooms.set(room.id, before); throw error; }
    return this.view(room);
  }

  updateSettings(session: Session, roomId: string, commandId: string, settings: { maxPlayers: number; prizes: Array<{ tier: PrizeTier; displayName: string; quantity: number }> }, expectedVersion?: number) {
    return this.changeState(session, roomId, commandId, "room:settings-updated", expectedVersion, (room) => {
      if (room.state !== "LOBBY") throw new AppError("ROOM_LOCKED", "开始后不能修改房间设置", 409);
      const tiers = new Set(settings.prizes.map((prize) => prize.tier));
      if (tiers.size !== 6 || settings.prizes.reduce((sum, prize) => sum + prize.quantity, 0) < 1) throw new AppError("VALIDATION_FAILED", "奖品档位必须完整且总数大于零");
      if (settings.maxPlayers < room.members.filter((member) => member.status === "ACTIVE").length) throw new AppError("VALIDATION_FAILED", "玩家上限不能小于当前人数");
      room.maxPlayers = settings.maxPlayers;
      room.prizeConfig = settings.prizes.map((prize) => ({ ...prize, displayName: prize.displayName.trim() }));
    });
  }

  roll(session: Session, roomId: string, commandId: string, throwProfile: ThrowProfile, expectedVersion?: number): { event: RoomEvent<RollResolution>; replayed: boolean } {
    const room = this.requireRoom(roomId);
    const member = this.requireMember(room, session.id);
    if (!room.game) throw new AppError("INVALID_ROOM_STATE", "游戏尚未开始", 409);
    const prior = this.repository.findRoll(room.game.id, commandId);
    if (prior) {
      if (prior.throwProfileJson !== JSON.stringify(throwProfile)) throw new AppError("COMMAND_CONFLICT", "同一 commandId 已用于不同投掷", 409);
      return { event: prior.event, replayed: true };
    }
    if (room.state !== "PLAYING") throw new AppError("INVALID_ROOM_STATE", "当前不能投掷", 409);
    if (room.game.currentMemberId !== member.id) throw new AppError("NOT_YOUR_TURN", "还没轮到你", 409);
    this.checkVersion(room, expectedVersion);

    const before = structuredClone(room);
    const probability = outsideProbability(throwProfile.strength, room.outsideRule);
    const outside = isOutside(throwProfile.strength, room.outsideRule, this.random.unit());
    const dice = outside ? null : Array.from({ length: 6 }, () => this.random.die()) as DiceFace[];
    const award: AwardResult = outside ? { primary: "OUTSIDE", secondary: [], normalizedDice: [] } : evaluateRoll(dice!);
    const rollId = this.random.id();
    const championChanged = Boolean(award.championRank && (!room.game.champion || compareChampion(award.championRank, room.game.champion.rank) > 0));
    const claims: Array<{ tier: PrizeTier; quantity: 1 }> = [];
    for (const tier of prizeTiersFor(award)) {
      const pool = room.game.prizes.find((candidate) => candidate.tier === tier)!;
      if (tier === "CHAMPION") {
        if (championChanged) {
          if (pool.remaining > 0) pool.remaining -= 1;
          claims.push({ tier, quantity: 1 });
        }
      } else if (pool.remaining > 0) {
        pool.remaining -= 1;
        claims.push({ tier, quantity: 1 });
      }
    }
    if (championChanged) room.game.champion = { rollId, memberId: member.id, rank: award.championRank! };
    if (!room.game.ending && room.game.prizes.every((prize) => prize.remaining === 0)) {
      room.game.ending = { triggeredAtTurnNo: room.game.turnNo + 1, finishAfterRoundNo: room.game.roundNo + 1 };
    }
    const nextMemberId = this.advanceTurn(room);
    if (room.game.ending && room.game.roundNo > room.game.ending.finishAfterRoundNo) {
      room.state = "FINISHED";
      room.game.status = "FINISHED";
    }
    room.version += 1;
    room.sequence += 1;
    const resolution: RollResolution = {
      rollId, memberId: member.id, outcome: outside ? "OUTSIDE" : "DICE", dice,
      outsideProbabilityBasisPoints: Math.round(probability * 10_000), visualSeed: this.random.token().slice(0, 22),
      throwProfile, award, claims, nextMemberId, gameFinished: room.state === "FINISHED"
    };
    const eventId = this.random.id();
    const event = this.event(room, resolution, eventId);
    try { this.repository.saveRoll(room, commandId, event, championChanged); }
    catch (error) { this.rooms.set(room.id, before); throw error; }
    return { event, replayed: false };
  }

  pauseRoom(session: Session, roomId: string, commandId: string, expectedVersion?: number): { event: RoomEvent<Room>; replayed: boolean } {
    return this.changeState(session, roomId, commandId, "room:state-changed", expectedVersion, (room) => {
      if (room.state !== "PLAYING") throw new AppError("INVALID_ROOM_STATE", "只有进行中的房间可以暂停", 409);
      room.state = "PAUSED";
      room.game!.status = "PAUSED";
    });
  }

  resumeRoom(session: Session, roomId: string, commandId: string, expectedVersion?: number): { event: RoomEvent<Room>; replayed: boolean } {
    return this.changeState(session, roomId, commandId, "room:state-changed", expectedVersion, (room) => {
      if (room.state !== "PAUSED") throw new AppError("INVALID_ROOM_STATE", "房间没有暂停", 409);
      room.state = "PLAYING";
      room.game!.status = "PLAYING";
    });
  }

  skipTurn(session: Session, roomId: string, commandId: string, expectedVersion?: number): { event: RoomEvent<Room>; replayed: boolean } {
    return this.changeState(session, roomId, commandId, "game:turn-changed", expectedVersion, (room) => {
      if (room.state !== "PLAYING") throw new AppError("INVALID_ROOM_STATE", "当前不能跳过玩家", 409);
      this.advanceTurn(room);
      if (room.game!.ending && room.game!.roundNo > room.game!.ending.finishAfterRoundNo) {
        room.state = "FINISHED";
        room.game!.status = "FINISHED";
      }
    });
  }

  finishRoom(session: Session, roomId: string, commandId: string, expectedVersion?: number): { event: RoomEvent<Room>; replayed: boolean } {
    return this.changeState(session, roomId, commandId, "game:finished", expectedVersion, (room) => {
      if (!room.game || room.state === "FINISHED" || room.state === "LOBBY") throw new AppError("INVALID_ROOM_STATE", "当前没有可结束的对局", 409);
      room.state = "FINISHED";
      room.game.status = "FINISHED";
    });
  }

  transferHost(session: Session, roomId: string, commandId: string, targetMemberId: string, expectedVersion?: number): { event: RoomEvent<Room>; replayed: boolean } {
    return this.changeState(session, roomId, commandId, "room:host-transferred", expectedVersion, (room) => {
      const target = room.members.find((member) => member.id === targetMemberId && member.status === "ACTIVE");
      if (!target) throw new AppError("NOT_A_MEMBER", "目标玩家不在房间中", 404);
      const previous = room.members.find((member) => member.id === room.hostMemberId)!;
      previous.role = "PLAYER";
      target.role = "HOST";
      room.hostMemberId = target.id;
    });
  }

  leaveRoom(session: Session, roomId: string, commandId: string, expectedVersion?: number): { event: RoomEvent<Room>; replayed: boolean } {
    const room = this.requireRoom(roomId);
    const member = room.members.find((candidate) => candidate.sessionId === session.id);
    if (!member) throw new AppError("NOT_A_MEMBER", "你不是该房间成员", 403);
    const prior = this.repository.findEvent<Room>(room.id, commandId, "room:member-updated");
    if (prior) return { event: prior, replayed: true };
    if (member.status !== "ACTIVE") throw new AppError("NOT_A_MEMBER", "你已经离开该房间", 403);
    this.checkVersion(room, expectedVersion);
    const before = structuredClone(room);
    member.status = "LEFT";
    member.online = false;
    const active = room.members.filter((item) => item.status === "ACTIVE").sort((a, b) => a.seatNo - b.seatNo);
    if (member.id === room.hostMemberId && active[0]) {
      member.role = "PLAYER";
      active[0].role = "HOST";
      room.hostMemberId = active[0].id;
    }
    if (active.length === 0) {
      room.state = "EXPIRED";
      if (room.game) room.game.status = "FINISHED";
    } else if (room.game && room.game.currentMemberId === member.id) {
      room.game.currentMemberId = active[0]!.id;
      room.game.turnNo += 1;
      if (active[0]!.seatNo <= member.seatNo) room.game.roundNo += 1;
    }
    if (room.game && active.length === 1 && room.state === "PLAYING") {
      room.state = "PAUSED";
      room.game.status = "PAUSED";
    }
    room.version += 1;
    room.sequence += 1;
    const event = this.event(room, this.view(room), this.random.id());
    try { this.repository.saveStateEvent(room, event, "room:member-updated", member.id, commandId); }
    catch (error) { this.rooms.set(room.id, before); throw error; }
    return { event, replayed: false };
  }

  sendReaction(session: Session, roomId: string, commandId: string, reaction: "CHEER" | "CLAP" | "WOW" | "LUCK" | "LAUGH") {
    const room = this.requireRoom(roomId);
    const member = this.requireMember(room, session.id);
    const prior = this.repository.findEvent<{ memberId: string; reaction: string }>(room.id, commandId, "reaction:received");
    if (prior) return { event: prior, replayed: true };
    const before = structuredClone(room);
    room.sequence += 1;
    const event = this.event(room, { memberId: member.id, reaction }, this.random.id());
    try { this.repository.saveStateEvent(room, event, "reaction:received", member.id, commandId); }
    catch (error) { this.rooms.set(room.id, before); throw error; }
    return { event, replayed: false };
  }

  private changeState(
    session: Session,
    roomId: string,
    commandId: string,
    eventType: string,
    expectedVersion: number | undefined,
    mutate: (room: Room) => void
  ): { event: RoomEvent<Room>; replayed: boolean } {
    const room = this.requireRoom(roomId);
    const actor = this.requireMember(room, session.id);
    const prior = this.repository.findEvent<Room>(room.id, commandId, eventType);
    if (prior) return { event: prior, replayed: true };
    if (actor.id !== room.hostMemberId) throw new AppError("NOT_HOST", "只有房主可以执行此操作", 403);
    this.checkVersion(room, expectedVersion);
    const before = structuredClone(room);
    mutate(room);
    room.version += 1;
    room.sequence += 1;
    const event = this.event(room, this.view(room), this.random.id());
    try { this.repository.saveStateEvent(room, event, eventType, actor.id, commandId); }
    catch (error) { this.rooms.set(room.id, before); throw error; }
    return { event, replayed: false };
  }

  private advanceTurn(room: Room): string {
    const game = room.game!;
    const active = room.members.filter((member) => member.status === "ACTIVE").sort((a, b) => a.seatNo - b.seatNo);
    const currentIndex = active.findIndex((member) => member.id === game.currentMemberId);
    const nextIndex = (currentIndex + 1) % active.length;
    game.turnNo += 1;
    if (nextIndex === 0) game.roundNo += 1;
    game.currentMemberId = active[nextIndex]!.id;
    return game.currentMemberId;
  }

  private event<T>(room: Room, payload: T, eventId: string): RoomEvent<T> {
    return { protocolVersion: 1, eventId, roomId: room.id, sequence: room.sequence, roomVersion: room.version, occurredAt: new Date().toISOString(), payload };
  }

  private requireRoom(roomId: string): Room {
    const room = this.rooms.get(roomId);
    if (!room) throw new AppError("ROOM_NOT_FOUND", "房间不存在", 404);
    return room;
  }

  private requireMember(room: Room, sessionId: string): Member {
    const member = room.members.find((candidate) => candidate.sessionId === sessionId && candidate.status === "ACTIVE");
    if (!member) throw new AppError("NOT_A_MEMBER", "你不是该房间成员", 403);
    return member;
  }

  private checkVersion(room: Room, expected?: number): void {
    if (expected !== undefined && expected !== room.version) throw new AppError("STALE_ROOM_VERSION", "房间状态已经更新", 409, { currentVersion: room.version });
  }

  private view(room: Room): Room {
    const copy = structuredClone(room);
    for (const member of copy.members) member.sessionId = "";
    return copy;
  }
}
