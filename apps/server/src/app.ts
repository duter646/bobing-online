import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { Server as SocketServer } from "socket.io";
import { z } from "zod";
import { reactionCommandSchema, rollCommandSchema, roomControlCommandSchema, subscribeCommandSchema, transferHostCommandSchema, updateSettingsCommandSchema, type CommandAck } from "@bobing/protocol";
import { Repository } from "./database.js";
import { AppError, asPublicError } from "./errors.js";
import { secureRandom, type RandomSource } from "./random.js";
import { RoomService } from "./room-service.js";
import { RateLimiter } from "./rate-limiter.js";

const sessionSchema = z.object({ displayName: z.string() }).strict();
const registerSchema = z.object({ email: z.string(), password: z.string(), displayName: z.string() }).strict();
const loginSchema = z.object({ email: z.string(), password: z.string() }).strict();
const sessionNameSchema = z.object({ displayName: z.string() }).strict();
const createRoomSchema = z.object({ maxPlayers: z.number().int().optional() }).strict();
const joinRoomSchema = z.object({ code: z.string().min(6).max(6) }).strict();
const startRoomSchema = z.object({ expectedRoomVersion: z.number().int().nonnegative().optional() }).strict();

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 32_768) throw new AppError("VALIDATION_FAILED", "请求体不能超过 32 KB", 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AppError("VALIDATION_FAILED", "请求体不是合法 JSON"); }
}

function bearer(request: IncomingMessage): string | undefined {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : undefined;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  response.end(JSON.stringify(body));
}

function sendCsv(response: ServerResponse, filename: string, body: string): void {
  response.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${filename}"`,
    "access-control-allow-origin": "*"
  });
  response.end(body);
}

export function createApplication(options: { dbPath?: string; random?: RandomSource; presenceGraceMs?: number; cleanupIntervalMs?: number } = {}) {
  const repository = new Repository(options.dbPath ?? resolve(process.cwd(), "data/bobing.sqlite"));
  const service = new RoomService(repository, options.random ?? secureRandom);
  const rateLimiter = new RateLimiter();
  service.cleanupExpired();
  const cleanupIntervalMs = options.cleanupIntervalMs ?? 60 * 60 * 1_000;
  const cleanupTimer = cleanupIntervalMs > 0 ? setInterval(() => service.cleanupExpired(), cleanupIntervalMs) : undefined;
  cleanupTimer?.unref();
  const httpServer = createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS" });
      return response.end();
    }
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") return send(response, 200, { ok: true });
      if (request.method === "POST" && url.pathname === "/api/sessions") {
        rateLimiter.consume(`session:${request.socket.remoteAddress ?? "unknown"}`, 20, 60_000);
        const body = sessionSchema.parse(await readJson(request));
        return send(response, 201, service.createSession(body.displayName));
      }
      if (request.method === "POST" && url.pathname === "/api/auth/register") {
        rateLimiter.consume(`register:${request.socket.remoteAddress ?? "unknown"}`, 10, 60_000);
        const body = registerSchema.parse(await readJson(request));
        return send(response, 201, await service.register(body.email, body.password, body.displayName));
      }
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        rateLimiter.consume(`login:${request.socket.remoteAddress ?? "unknown"}`, 20, 60_000);
        const body = loginSchema.parse(await readJson(request));
        return send(response, 200, await service.login(body.email, body.password));
      }
      const publicReportMatch = url.pathname.match(/^\/api\/reports\/([^/]+)$/);
      if (request.method === "GET" && publicReportMatch) return send(response, 200, service.getPublicReport(publicReportMatch[1]!, url.searchParams.get("token") ?? ""));
      const session = service.authenticate(bearer(request));
      if (request.method === "GET" && url.pathname === "/api/auth/me") return send(response, 200, service.identity(session));
      if (request.method === "GET" && url.pathname === "/api/me/stats") return send(response, 200, service.stats(session));
      if (request.method === "POST" && url.pathname === "/api/session/name") {
        const body = sessionNameSchema.parse(await readJson(request));
        return send(response, 200, service.updateSessionName(session, body.displayName));
      }
      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        service.logout(session);
        return send(response, 200, { loggedOut: true });
      }
      if (request.method === "POST" && url.pathname === "/api/rooms") {
        rateLimiter.consume(`room-create:${session.id}`, 10, 60_000);
        const body = createRoomSchema.parse(await readJson(request));
        const created = service.createRoomWithReportToken(session, body.maxPlayers);
        return send(response, 201, { ...created.room, reportToken: created.reportToken });
      }
      if (request.method === "POST" && url.pathname === "/api/rooms/join") {
        rateLimiter.consume(`room-join:${session.id}`, 30, 60_000);
        const body = joinRoomSchema.parse(await readJson(request));
        const room = service.joinRoom(session, body.code);
        io.to(room.id).emit("room:snapshot", room);
        return send(response, 200, room);
      }
      const startMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/start$/);
      if (request.method === "POST" && startMatch) {
        const body = startRoomSchema.parse(await readJson(request));
        return send(response, 200, service.startRoom(session, startMatch[1]!, body.expectedRoomVersion));
      }
      const reportMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/report$/);
      if (request.method === "GET" && reportMatch) return send(response, 200, service.getReport(session, reportMatch[1]!));
      const csvMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/report\.csv$/);
      if (request.method === "GET" && csvMatch) return sendCsv(response, `bobing-${csvMatch[1]}.csv`, service.getReportCsv(session, csvMatch[1]!));
      const rollsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/rolls$/);
      if (request.method === "GET" && rollsMatch) {
        const after = Math.max(0, Number(url.searchParams.get("after") ?? 0));
        const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
        if (!Number.isInteger(after) || !Number.isInteger(limit)) throw new AppError("VALIDATION_FAILED", "分页参数不合法");
        return send(response, 200, service.getRollPage(session, rollsMatch[1]!, after, limit));
      }
      const roomMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)$/);
      if (request.method === "GET" && roomMatch) return send(response, 200, service.getRoom(session, roomMatch[1]!));
      if (request.method === "DELETE" && roomMatch) {
        service.deleteReport(session, roomMatch[1]!);
        return send(response, 200, { deleted: true });
      }
      return send(response, 404, { error: { code: "NOT_FOUND", message: "接口不存在" } });
    } catch (error) {
      if (error instanceof z.ZodError) return send(response, 400, { error: { code: "VALIDATION_FAILED", message: "输入不合法", details: z.treeifyError(error) } });
      const publicError = asPublicError(error);
      return send(response, error instanceof AppError ? error.status : 500, { error: publicError });
    }
  });

  const io = new SocketServer(httpServer, { cors: { origin: "*" } });
  const presenceConnections = new Map<string, Set<string>>();
  const pendingOffline = new Map<string, ReturnType<typeof setTimeout>>();
  const presenceGraceMs = options.presenceGraceMs ?? 10_000;
  let closing = false;
  const presenceKey = (roomId: string, sessionId: string) => `${roomId}:${sessionId}`;
  const presenceIdentity = (session: { id: string; userId?: string }) => session.userId ?? session.id;

  const publishPresence = (session: { id: string; displayName: string; userId?: string }, roomId: string, online: boolean): void => {
    const event = service.setPresence(session, roomId, online);
    if (event) io.to(roomId).emit("room:member-updated", event);
    const turnEvent = service.skipOfflineTurns(roomId);
    if (turnEvent) io.to(roomId).emit("game:turn-changed", turnEvent);
  };

  const assertWritable = (socket: import("socket.io").Socket, roomId: string): void => {
    const readOnlyRooms = socket.data.readOnlyRooms as Set<string> | undefined;
    if (readOnlyRooms?.has(roomId)) throw new AppError("COMMAND_CONFLICT", "该身份已在新页面连接，本页面为只读", 409);
  };

  const addPresence = (socket: import("socket.io").Socket, roomId: string): void => {
    const subscribed = (socket.data.subscribedRooms ??= new Set<string>()) as Set<string>;
    if (subscribed.has(roomId)) return;
    subscribed.add(roomId);
    const key = presenceKey(roomId, presenceIdentity(socket.data.session));
    const pending = pendingOffline.get(key);
    if (pending) { clearTimeout(pending); pendingOffline.delete(key); }
    const connections = presenceConnections.get(key) ?? new Set<string>();
    const wasOffline = connections.size === 0;
    for (const connectionId of connections) {
      const older = io.sockets.sockets.get(connectionId);
      if (older) ((older.data.readOnlyRooms ??= new Set<string>()) as Set<string>).add(roomId);
    }
    ((socket.data.readOnlyRooms ??= new Set<string>()) as Set<string>).delete(roomId);
    connections.add(socket.id);
    presenceConnections.set(key, connections);
    if (wasOffline) publishPresence(socket.data.session, roomId, true);
  };

  const removePresence = (socket: import("socket.io").Socket): void => {
    if (closing) return;
    const subscribed = socket.data.subscribedRooms as Set<string> | undefined;
    if (!subscribed) return;
    for (const roomId of subscribed) {
      const key = presenceKey(roomId, presenceIdentity(socket.data.session));
      const connections = presenceConnections.get(key);
      connections?.delete(socket.id);
      if (connections && connections.size > 0) {
        const promotedId = [...connections].at(-1)!;
        const promoted = io.sockets.sockets.get(promotedId);
        (promoted?.data.readOnlyRooms as Set<string> | undefined)?.delete(roomId);
      }
      if (connections && connections.size === 0) {
        presenceConnections.delete(key);
        const timer = setTimeout(() => {
          pendingOffline.delete(key);
          if (presenceConnections.has(key)) return;
          try {
            publishPresence(socket.data.session, roomId, false);
          } catch {
            // Disconnect cleanup must not crash the realtime server.
          }
        }, presenceGraceMs);
        pendingOffline.set(key, timer);
      }
    }
  };

  io.use((socket, next) => {
    try { socket.data.session = service.authenticate(typeof socket.handshake.auth.token === "string" ? socket.handshake.auth.token : undefined); next(); }
    catch (error) { next(new Error(asPublicError(error).code)); }
  });
  const acknowledge = (ack: unknown, value: CommandAck<unknown>): void => {
    if (typeof ack === "function") (ack as (response: CommandAck<unknown>) => void)(value);
  };
  io.on("connection", (socket) => {
    socket.on("room:subscribe", async (raw: unknown, ack: (value: CommandAck<unknown>) => void) => {
      const fallbackId = typeof raw === "object" && raw && "commandId" in raw ? String(raw.commandId) : "invalid";
      try {
        const command = subscribeCommandSchema.parse(raw);
        service.getRoom(socket.data.session, command.roomId);
        await socket.join(command.roomId);
        addPresence(socket, command.roomId);
        const sync = service.syncRoom(socket.data.session, command.roomId, command.payload.lastSequence);
        acknowledge(ack, { ok: true, commandId: command.commandId, data: sync });
      } catch (error) { acknowledge(ack, { ok: false, commandId: fallbackId, error: asPublicError(error) }); }
    });
    socket.on("game:roll", (raw: unknown, ack: (value: CommandAck<unknown>) => void) => {
      const fallbackId = typeof raw === "object" && raw && "commandId" in raw ? String(raw.commandId) : "invalid";
      try {
        const command = rollCommandSchema.parse(raw);
        assertWritable(socket, command.roomId);
        rateLimiter.consume(`roll:${socket.data.session.id}`, 12, 10_000);
        const resolved = service.roll(socket.data.session, command.roomId, command.commandId, command.payload.throwProfile, command.expectedRoomVersion);
        if (!resolved.replayed) io.to(command.roomId).emit("game:roll-resolved", resolved.event);
        acknowledge(ack, { ok: true, commandId: command.commandId, data: resolved.event });
      } catch (error) {
        const normalized = error instanceof z.ZodError ? new AppError("VALIDATION_FAILED", "投掷参数不合法", 400, z.treeifyError(error)) : error;
        acknowledge(ack, { ok: false, commandId: fallbackId, error: asPublicError(normalized) });
      }
    });

    const control = (
      socketEvent: string,
      serverEvent: string,
      run: (command: z.infer<typeof roomControlCommandSchema>) => { event: unknown; replayed: boolean }
    ) => {
      socket.on(socketEvent, (raw: unknown, ack: (value: CommandAck<unknown>) => void) => {
        const fallbackId = typeof raw === "object" && raw && "commandId" in raw ? String(raw.commandId) : "invalid";
        try {
          const command = roomControlCommandSchema.parse(raw);
          assertWritable(socket, command.roomId);
          const resolved = run(command);
          if (!resolved.replayed) io.to(command.roomId).emit(serverEvent, resolved.event);
          acknowledge(ack, { ok: true, commandId: command.commandId, data: resolved.event });
        } catch (error) {
          const normalized = error instanceof z.ZodError ? new AppError("VALIDATION_FAILED", "命令参数不合法", 400, z.treeifyError(error)) : error;
          acknowledge(ack, { ok: false, commandId: fallbackId, error: asPublicError(normalized) });
        }
      });
    };

    control("room:pause", "room:state-changed", (command) => service.pauseRoom(socket.data.session, command.roomId, command.commandId, command.expectedRoomVersion));
    control("room:resume", "room:state-changed", (command) => service.resumeRoom(socket.data.session, command.roomId, command.commandId, command.expectedRoomVersion));
    control("room:skip-turn", "game:turn-changed", (command) => service.skipTurn(socket.data.session, command.roomId, command.commandId, command.expectedRoomVersion));
    control("game:finish", "game:finished", (command) => service.finishRoom(socket.data.session, command.roomId, command.commandId, command.expectedRoomVersion));
    control("room:leave", "room:member-updated", (command) => service.leaveRoom(socket.data.session, command.roomId, command.commandId, command.expectedRoomVersion));

    socket.on("room:transfer-host", (raw: unknown, ack: (value: CommandAck<unknown>) => void) => {
      const fallbackId = typeof raw === "object" && raw && "commandId" in raw ? String(raw.commandId) : "invalid";
      try {
        const command = transferHostCommandSchema.parse(raw);
        assertWritable(socket, command.roomId);
        const resolved = service.transferHost(socket.data.session, command.roomId, command.commandId, command.payload.memberId, command.expectedRoomVersion);
        if (!resolved.replayed) io.to(command.roomId).emit("room:host-transferred", resolved.event);
        acknowledge(ack, { ok: true, commandId: command.commandId, data: resolved.event });
      } catch (error) {
        const normalized = error instanceof z.ZodError ? new AppError("VALIDATION_FAILED", "命令参数不合法", 400, z.treeifyError(error)) : error;
        acknowledge(ack, { ok: false, commandId: fallbackId, error: asPublicError(normalized) });
      }
    });
    socket.on("room:update-settings", (raw: unknown, ack: (value: CommandAck<unknown>) => void) => {
      const fallbackId = typeof raw === "object" && raw && "commandId" in raw ? String(raw.commandId) : "invalid";
      try {
        const command = updateSettingsCommandSchema.parse(raw);
        assertWritable(socket, command.roomId);
        const resolved = service.updateSettings(socket.data.session, command.roomId, command.commandId, command.payload, command.expectedRoomVersion);
        if (!resolved.replayed) io.to(command.roomId).emit("room:settings-updated", resolved.event);
        acknowledge(ack, { ok: true, commandId: command.commandId, data: resolved.event });
      } catch (error) {
        const normalized = error instanceof z.ZodError ? new AppError("VALIDATION_FAILED", "房间设置不合法", 400, z.treeifyError(error)) : error;
        acknowledge(ack, { ok: false, commandId: fallbackId, error: asPublicError(normalized) });
      }
    });
    socket.on("reaction:send", (raw: unknown, ack: (value: CommandAck<unknown>) => void) => {
      const fallbackId = typeof raw === "object" && raw && "commandId" in raw ? String(raw.commandId) : "invalid";
      try {
        const command = reactionCommandSchema.parse(raw);
        assertWritable(socket, command.roomId);
        rateLimiter.consume(`reaction:${socket.data.session.id}`, 10, 10_000);
        const resolved = service.sendReaction(socket.data.session, command.roomId, command.commandId, command.payload.reaction);
        if (!resolved.replayed) io.to(command.roomId).emit("reaction:received", resolved.event);
        acknowledge(ack, { ok: true, commandId: command.commandId, data: resolved.event });
      } catch (error) { acknowledge(ack, { ok: false, commandId: fallbackId, error: asPublicError(error) }); }
    });
    socket.on("disconnect", () => removePresence(socket));
  });

  return {
    service,
    listen(port = 3000): Promise<number> {
      return new Promise((resolvePromise) => httpServer.listen(port, "127.0.0.1", () => resolvePromise((httpServer.address() as { port: number }).port)));
    },
    close(): Promise<void> {
      closing = true;
      pendingOffline.forEach((timer) => clearTimeout(timer));
      pendingOffline.clear();
      if (cleanupTimer) clearInterval(cleanupTimer);
      rateLimiter.clear();
      return new Promise((resolvePromise) => io.close(() => { repository.close(); resolvePromise(); }));
    }
  };
}
