import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Room, RollResolution, StoredRoomEvent } from "./types.js";

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export class Repository {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS guest_sessions (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
        user_id TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL, created_at TEXT NOT NULL, last_login_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, public_token_hash TEXT NOT NULL DEFAULT '', state TEXT NOT NULL, rule_preset_id TEXT NOT NULL,
        settings_json TEXT NOT NULL, version INTEGER NOT NULL, last_sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS room_members (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), session_id TEXT NOT NULL REFERENCES guest_sessions(id),
        display_name TEXT NOT NULL, seat_no INTEGER NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, joined_at TEXT NOT NULL,
        UNIQUE(room_id, seat_no), UNIQUE(room_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id), status TEXT NOT NULL,
        current_member_id TEXT NOT NULL, round_no INTEGER NOT NULL, turn_no INTEGER NOT NULL,
        champion_roll_id TEXT, started_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE TABLE IF NOT EXISTS prize_pools (
        id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id), tier TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        initial_quantity INTEGER NOT NULL CHECK(initial_quantity >= 0),
        remaining_quantity INTEGER NOT NULL CHECK(remaining_quantity >= 0), sort_order INTEGER NOT NULL,
        UNIQUE(game_id, tier)
      );
      CREATE TABLE IF NOT EXISTS rolls (
        id TEXT PRIMARY KEY, game_id TEXT NOT NULL REFERENCES games(id), member_id TEXT NOT NULL REFERENCES room_members(id),
        command_id TEXT NOT NULL, turn_no INTEGER NOT NULL, throw_profile_json TEXT NOT NULL,
        outside_probability_bp INTEGER NOT NULL, is_outside INTEGER NOT NULL, dice_json TEXT,
        primary_award TEXT NOT NULL, result_json TEXT NOT NULL, champion_rank_json TEXT, created_at TEXT NOT NULL,
        UNIQUE(game_id, command_id), UNIQUE(game_id, turn_no)
      );
      CREATE TABLE IF NOT EXISTS prize_claims (
        id TEXT PRIMARY KEY, roll_id TEXT NOT NULL REFERENCES rolls(id), prize_pool_id TEXT NOT NULL REFERENCES prize_pools(id),
        member_id TEXT NOT NULL REFERENCES room_members(id), quantity INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_events (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), sequence INTEGER NOT NULL,
        room_version INTEGER NOT NULL, event_type TEXT NOT NULL, actor_member_id TEXT, command_id TEXT, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(room_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS room_snapshots (
        room_id TEXT PRIMARY KEY REFERENCES rooms(id), sequence INTEGER NOT NULL, room_version INTEGER NOT NULL,
        state_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const eventColumns = this.db.prepare("PRAGMA table_info(room_events)").all() as Array<{ name: string }>;
    if (!eventColumns.some((column) => column.name === "room_version")) {
      this.db.exec("ALTER TABLE room_events ADD COLUMN room_version INTEGER NOT NULL DEFAULT 0");
    }
    const prizeColumns = this.db.prepare("PRAGMA table_info(prize_pools)").all() as Array<{ name: string }>;
    if (!prizeColumns.some((column) => column.name === "display_name")) this.db.exec("ALTER TABLE prize_pools ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
    const roomColumns = this.db.prepare("PRAGMA table_info(rooms)").all() as Array<{ name: string }>;
    if (!roomColumns.some((column) => column.name === "public_token_hash")) this.db.exec("ALTER TABLE rooms ADD COLUMN public_token_hash TEXT NOT NULL DEFAULT ''");
    const sessionColumns = this.db.prepare("PRAGMA table_info(guest_sessions)").all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "user_id")) this.db.exec("ALTER TABLE guest_sessions ADD COLUMN user_id TEXT");
    if (!sessionColumns.some((column) => column.name === "revoked_at")) this.db.exec("ALTER TABLE guest_sessions ADD COLUMN revoked_at TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS room_event_command_type ON room_events(room_id, command_id, event_type) WHERE command_id IS NOT NULL");
  }

  createSession(id: string, token: string, displayName: string, now: string, expiresAt: string, userId: string | null = null): void {
    this.db.prepare(`INSERT INTO guest_sessions
      (id, token_hash, display_name, user_id, created_at, expires_at, last_seen_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`)
      .run(id, hashToken(token), displayName, userId, now, expiresAt, now);
  }

  resolveSession(token: string, now: string): { id: string; displayName: string; userId?: string } | undefined {
    const row = this.db.prepare("SELECT id, display_name, user_id, expires_at, revoked_at FROM guest_sessions WHERE token_hash = ?").get(hashToken(token)) as { id: string; display_name: string; user_id: string | null; expires_at: string; revoked_at: string | null } | undefined;
    if (!row || row.expires_at <= now || row.revoked_at) return undefined;
    this.db.prepare("UPDATE guest_sessions SET last_seen_at = ? WHERE id = ?").run(now, row.id);
    return { id: row.id, displayName: row.display_name, ...(row.user_id ? { userId: row.user_id } : {}) };
  }

  createUserAndSession(input: { userId: string; email: string; passwordHash: string; displayName: string; sessionId: string; token: string; now: string; expiresAt: string }): void {
    this.transaction(() => {
      this.db.prepare("INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)").run(input.userId, input.email, input.passwordHash, input.displayName, input.now, input.now);
      this.createSession(input.sessionId, input.token, input.displayName, input.now, input.expiresAt, input.userId);
    });
  }

  findUserByEmail(email: string): { id: string; email: string; passwordHash: string; displayName: string } | undefined {
    const row = this.db.prepare("SELECT id, email, password_hash, display_name FROM users WHERE email = ?").get(email) as {
      id: string; email: string; password_hash: string; display_name: string;
    } | undefined;
    return row ? { id: row.id, email: row.email, passwordHash: row.password_hash, displayName: row.display_name } : undefined;
  }

  touchUserLogin(userId: string, now: string): void { this.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now, userId); }
  updateSessionDisplayName(sessionId: string, displayName: string): void { this.db.prepare("UPDATE guest_sessions SET display_name = ? WHERE id = ?").run(displayName, sessionId); }
  revokeSession(sessionId: string, now: string): void { this.db.prepare("UPDATE guest_sessions SET revoked_at = ? WHERE id = ?").run(now, sessionId); }

  userStats(sessionId: string, userId?: string) {
    const where = userId ? "gs.user_id = ?" : "rm.session_id = ?";
    const identity = userId ?? sessionId;
    const awards = this.db.prepare(`SELECT r.primary_award AS award, COUNT(*) AS count
      FROM rolls r JOIN room_members rm ON rm.id = r.member_id JOIN guest_sessions gs ON gs.id = rm.session_id
      WHERE ${where} GROUP BY r.primary_award ORDER BY count DESC`).all(identity) as Array<{ award: string; count: number }>;
    const totalRolls = awards.reduce((sum, row) => sum + Number(row.count), 0);
    const prizes = this.db.prepare(`SELECT pp.tier, SUM(pc.quantity) AS quantity
      FROM prize_claims pc JOIN prize_pools pp ON pp.id = pc.prize_pool_id
      JOIN room_members rm ON rm.id = pc.member_id JOIN guest_sessions gs ON gs.id = rm.session_id
      WHERE ${where} AND pc.status = 'FINAL' GROUP BY pp.tier`).all(identity) as Array<{ tier: string; quantity: number }>;
    const games = this.db.prepare(`SELECT DISTINCT g.id, g.started_at, g.finished_at
      FROM games g JOIN room_members rm ON rm.room_id = g.room_id JOIN guest_sessions gs ON gs.id = rm.session_id
      WHERE ${where}`).all(identity) as Array<{ id: string; started_at: string; finished_at: string | null }>;
    const playDurationMs = games.reduce((sum, game) => sum + (game.finished_at ? Math.max(0, Date.parse(game.finished_at) - Date.parse(game.started_at)) : 0), 0);
    return {
      totalRolls,
      awards: awards.map((row) => ({ award: row.award, count: Number(row.count), frequency: totalRolls ? Number(row.count) / totalRolls : 0 })),
      prizes: Object.fromEntries(prizes.map((row) => [row.tier, Number(row.quantity)])),
      gamesPlayed: games.length,
      completedGames: games.filter((game) => game.finished_at).length,
      playDurationMs
    };
  }

  saveNewRoom(room: Room, reportToken: string): void {
    const now = room.createdAt;
    this.transaction(() => {
      this.db.prepare(`INSERT INTO rooms
        (id, code, public_token_hash, state, rule_preset_id, settings_json, version, last_sequence, created_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`).run(
        room.id, room.code, hashToken(reportToken), room.state, room.rulePresetId, JSON.stringify({ maxPlayers: room.maxPlayers, outsideRule: room.outsideRule }), room.version, room.sequence, now
      );
      this.insertMember(room.id, room.members[0]!, now);
      this.saveSnapshot(room, now);
    });
  }

  addMember(room: Room, memberIndex: number, event: import("./types.js").RoomEvent<{ member: Room["members"][number] }>): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      this.insertMember(room.id, room.members[memberIndex]!, now);
      this.insertEvent(event, "room:member-joined", room.members[memberIndex]!.id, null);
      this.updateRoomAndSnapshot(room, now);
    });
  }

  startGame(room: Room, event: import("./types.js").RoomEvent<Room>): void {
    const game = room.game!;
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("INSERT INTO games VALUES (?, ?, 'PLAYING', ?, ?, ?, NULL, ?, NULL)").run(game.id, room.id, game.currentMemberId, game.roundNo, game.turnNo, now);
      const insert = this.db.prepare(`INSERT INTO prize_pools
        (id, game_id, tier, display_name, initial_quantity, remaining_quantity, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      game.prizes.forEach((prize, index) => insert.run(`${game.id}:${prize.tier}`, game.id, prize.tier,
        room.prizeConfig.find((item) => item.tier === prize.tier)?.displayName ?? prize.tier, prize.initial, prize.remaining, index));
      this.insertEvent(event, "room:state-changed", room.hostMemberId, null);
      this.updateRoomAndSnapshot(room, now);
    });
  }

  findRoll(gameId: string, commandId: string): { throwProfileJson: string; event: import("./types.js").RoomEvent<RollResolution> } | undefined {
    const row = this.db.prepare(`SELECT r.throw_profile_json, r.result_json, e.id AS event_id, e.room_id, e.sequence, e.room_version, e.created_at
      FROM rolls r JOIN games g ON g.id = r.game_id
      JOIN room_events e ON e.room_id = g.room_id AND e.command_id = r.command_id AND e.event_type = 'game:roll-resolved'
      WHERE r.game_id = ? AND r.command_id = ?`).get(gameId, commandId) as {
        throw_profile_json: string; result_json: string; event_id: string; room_id: string; sequence: number; room_version: number; created_at: string;
      } | undefined;
    return row ? { throwProfileJson: row.throw_profile_json, event: {
      protocolVersion: 1, eventId: row.event_id, roomId: row.room_id, sequence: row.sequence,
      roomVersion: row.room_version, occurredAt: row.created_at, payload: JSON.parse(row.result_json) as RollResolution
    } } : undefined;
  }

  saveRoll(room: Room, commandId: string, event: import("./types.js").RoomEvent<RollResolution>, championChanged: boolean): void {
    const game = room.game!;
    const resolution = event.payload;
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`INSERT INTO rolls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(resolution.rollId, game.id, resolution.memberId, commandId, game.turnNo, JSON.stringify(resolution.throwProfile),
          resolution.outsideProbabilityBasisPoints, resolution.outcome === "OUTSIDE" ? 1 : 0,
          resolution.dice ? JSON.stringify(resolution.dice) : null, resolution.award.primary, JSON.stringify(resolution),
          resolution.award.championRank ? JSON.stringify(resolution.award.championRank) : null, now);
      for (const claim of resolution.claims) {
        this.db.prepare("UPDATE prize_pools SET remaining_quantity = remaining_quantity - 1 WHERE game_id = ? AND tier = ? AND remaining_quantity > 0").run(game.id, claim.tier);
        this.db.prepare("INSERT INTO prize_claims VALUES (?, ?, ?, ?, 1, ?, ?)").run(
          `${resolution.rollId}:${claim.tier}`, resolution.rollId, `${game.id}:${claim.tier}`, resolution.memberId,
          claim.tier === "CHAMPION" ? "PROVISIONAL" : "FINAL", now
        );
      }
      if (championChanged) {
        this.db.prepare("UPDATE prize_claims SET status = 'REVOKED' WHERE prize_pool_id = ? AND roll_id <> ? AND status = 'PROVISIONAL'").run(`${game.id}:CHAMPION`, resolution.rollId);
      }
      this.db.prepare("UPDATE games SET status = ?, current_member_id = ?, round_no = ?, turn_no = ?, champion_roll_id = ?, finished_at = ? WHERE id = ?")
        .run(game.status, game.currentMemberId, game.roundNo, game.turnNo, game.champion?.rollId ?? null, game.status === "FINISHED" ? now : null, game.id);
      if (game.status === "FINISHED") this.db.prepare("UPDATE prize_claims SET status = 'FINAL' WHERE prize_pool_id = ? AND status = 'PROVISIONAL'").run(`${game.id}:CHAMPION`);
      this.insertEvent(event, "game:roll-resolved", resolution.memberId, commandId);
      this.updateRoomAndSnapshot(room, now);
    });
  }

  saveStateEvent<T>(room: Room, event: import("./types.js").RoomEvent<T>, eventType: string, actorMemberId: string | null, commandId: string | null): void {
    const now = event.occurredAt;
    this.transaction(() => {
      if (room.game) {
        this.db.prepare("UPDATE games SET status = ?, current_member_id = ?, round_no = ?, turn_no = ?, champion_roll_id = ?, finished_at = ? WHERE id = ?")
          .run(room.game.status, room.game.currentMemberId, room.game.roundNo, room.game.turnNo, room.game.champion?.rollId ?? null,
            room.game.status === "FINISHED" ? now : null, room.game.id);
        if (room.game.status === "FINISHED") this.db.prepare("UPDATE prize_claims SET status = 'FINAL' WHERE prize_pool_id = ? AND status = 'PROVISIONAL'").run(`${room.game.id}:CHAMPION`);
      }
      const updateMember = this.db.prepare("UPDATE room_members SET role = ?, status = ? WHERE id = ?");
      room.members.forEach((member) => updateMember.run(member.role, member.status, member.id));
      this.insertEvent(event, eventType, actorMemberId, commandId);
      this.updateRoomAndSnapshot(room, now);
    });
  }

  findEvent<T>(roomId: string, commandId: string, eventType: string): import("./types.js").RoomEvent<T> | undefined {
    const row = this.db.prepare(`SELECT id, sequence, room_version, payload_json, created_at FROM room_events
      WHERE room_id = ? AND command_id = ? AND event_type = ?`).get(roomId, commandId, eventType) as {
        id: string; sequence: number; room_version: number; payload_json: string; created_at: string;
      } | undefined;
    return row ? { protocolVersion: 1, eventId: row.id, roomId, sequence: row.sequence, roomVersion: row.room_version, occurredAt: row.created_at, payload: JSON.parse(row.payload_json) as T } : undefined;
  }

  eventsAfter(roomId: string, sequence: number, limit: number): StoredRoomEvent[] {
    const rows = this.db.prepare(`SELECT id, sequence, room_version, event_type, payload_json, created_at FROM room_events
      WHERE room_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`).all(roomId, sequence, limit) as Array<{
        id: string; sequence: number; room_version: number; event_type: string; payload_json: string; created_at: string;
      }>;
    return rows.map((row) => ({ type: row.event_type, event: {
      protocolVersion: 1, eventId: row.id, roomId, sequence: row.sequence, roomVersion: row.room_version,
      occurredAt: row.created_at, payload: JSON.parse(row.payload_json) as unknown
    } }));
  }

  verifyReportToken(roomId: string, token: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM rooms WHERE id = ? AND public_token_hash = ?").get(roomId, hashToken(token)));
  }

  rollPage(gameId: string, afterTurn: number, limit: number): { items: RollResolution[]; nextCursor: number | null } {
    const rows = this.db.prepare("SELECT turn_no, result_json FROM rolls WHERE game_id = ? AND turn_no > ? ORDER BY turn_no ASC LIMIT ?")
      .all(gameId, afterTurn, limit + 1) as Array<{ turn_no: number; result_json: string }>;
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return { items: page.map((row) => JSON.parse(row.result_json) as RollResolution), nextCursor: hasMore ? page.at(-1)!.turn_no : null };
  }

  allRolls(gameId: string): RollResolution[] {
    return (this.db.prepare("SELECT result_json FROM rolls WHERE game_id = ? ORDER BY turn_no").all(gameId) as Array<{ result_json: string }>)
      .map((row) => JSON.parse(row.result_json) as RollResolution);
  }

  cleanupCandidates(lobbyBefore: string, finishedBefore: string): string[] {
    return (this.db.prepare(`SELECT id FROM rooms WHERE
      (state = 'LOBBY' AND created_at < ?) OR (state IN ('FINISHED', 'EXPIRED') AND COALESCE(finished_at, created_at) < ?)`)
      .all(lobbyBefore, finishedBefore) as Array<{ id: string }>).map((row) => row.id);
  }

  deleteRoom(roomId: string): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM prize_claims WHERE roll_id IN (SELECT id FROM rolls WHERE game_id IN (SELECT id FROM games WHERE room_id = ?))").run(roomId);
      this.db.prepare("DELETE FROM rolls WHERE game_id IN (SELECT id FROM games WHERE room_id = ?)").run(roomId);
      this.db.prepare("DELETE FROM prize_pools WHERE game_id IN (SELECT id FROM games WHERE room_id = ?)").run(roomId);
      this.db.prepare("DELETE FROM games WHERE room_id = ?").run(roomId);
      this.db.prepare("DELETE FROM room_events WHERE room_id = ?").run(roomId);
      this.db.prepare("DELETE FROM room_snapshots WHERE room_id = ?").run(roomId);
      this.db.prepare("DELETE FROM room_members WHERE room_id = ?").run(roomId);
      this.db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId);
    });
  }

  cleanupExpiredSessions(now: string): void {
    this.db.prepare("DELETE FROM guest_sessions WHERE expires_at < ? AND NOT EXISTS (SELECT 1 FROM room_members WHERE room_members.session_id = guest_sessions.id)").run(now);
  }

  loadRooms(): Room[] {
    return (this.db.prepare("SELECT state_json FROM room_snapshots").all() as Array<{ state_json: string }>).map((row) => {
      const room = JSON.parse(row.state_json) as Room;
      room.prizeConfig ??= Object.entries({ CHAMPION: 1, STRAIGHT: 2, THREE_REDS: 4, FOUR_ADVANCES: 8, TWO_RAISES: 16, ONE_SHOW: 32 }).map(([tier, quantity]) => ({ tier, displayName: tier, quantity })) as Room["prizeConfig"];
      for (const member of room.members) member.online ??= false;
      if (room.game) room.game.status ??= room.state === "FINISHED" ? "FINISHED" : room.state === "PAUSED" ? "PAUSED" : "PLAYING";
      return room;
    });
  }

  saveRecoverySnapshot(room: Room): void {
    this.saveSnapshot(room, new Date().toISOString());
  }

  private insertMember(roomId: string, member: Room["members"][number], now: string): void {
    this.db.prepare("INSERT INTO room_members VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(member.id, roomId, member.sessionId, member.displayName, member.seatNo, member.role, member.status, now);
  }

  private updateRoomAndSnapshot(room: Room, now: string): void {
    this.db.prepare("UPDATE rooms SET state = ?, version = ?, last_sequence = ?, started_at = COALESCE(started_at, ?), finished_at = ? WHERE id = ?")
      .run(room.state, room.version, room.sequence, room.state === "LOBBY" ? null : now, room.state === "FINISHED" ? now : null, room.id);
    this.saveSnapshot(room, now);
  }

  private insertEvent(event: import("./types.js").RoomEvent<unknown>, eventType: string, actorMemberId: string | null, commandId: string | null): void {
    this.db.prepare(`INSERT INTO room_events
      (id, room_id, sequence, room_version, event_type, actor_member_id, command_id, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(event.eventId, event.roomId, event.sequence, event.roomVersion, eventType, actorMemberId, commandId, JSON.stringify(event.payload), event.occurredAt);
  }

  private saveSnapshot(room: Room, now: string): void {
    this.db.prepare(`INSERT INTO room_snapshots VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET sequence=excluded.sequence, room_version=excluded.room_version,
      state_json=excluded.state_json, updated_at=excluded.updated_at`)
      .run(room.id, room.sequence, room.version, JSON.stringify(room), now);
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN IMMEDIATE");
    try { work(); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  close(): void { this.db.close(); }
}
