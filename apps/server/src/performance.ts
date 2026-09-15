import { performance } from "node:perf_hooks";
import { io as connect, type Socket } from "socket.io-client";
import { createApplication } from "./app.js";
import { Repository } from "./database.js";
import { secureRandom } from "./random.js";
import { RoomService, type Session } from "./room-service.js";

const profile = { start: { x: 0, y: 0 }, direction: { x: 0.2, y: 0.9 }, strength: 0.72, holdDurationMs: 500 };
const percentile = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
};
const summary = (values: number[]) => ({
  count: values.length,
  p50Ms: Number(percentile(values, 0.5).toFixed(3)),
  p95Ms: Number(percentile(values, 0.95).toFixed(3)),
  p99Ms: Number(percentile(values, 0.99).toFixed(3)),
  maxMs: Number(Math.max(...values).toFixed(3))
});

async function coreBenchmark(rollCount = 3_000) {
  const repository = new Repository(":memory:");
  const service = new RoomService(repository, secureRandom);
  const sessions: Session[] = [];
  for (let index = 0; index < 12; index += 1) {
    const credential = service.createSession(`基准玩家${index + 1}`);
    sessions.push(service.authenticate(credential.token));
  }
  const room = service.createRoom(sessions[0]!);
  let joined = room;
  for (const session of sessions.slice(1)) joined = service.joinRoom(session, room.code);
  const prizes = joined.prizeConfig.map((prize) => ({ ...prize, quantity: 999 }));
  const configured = service.updateSettings(sessions[0]!, room.id, "benchmark-settings", { maxPlayers: 12, prizes }, joined.version).event.payload;
  const started = service.startRoom(sessions[0]!, room.id, configured.version);
  const byMember = new Map(started.members.map((member, index) => [member.id, sessions[index]!]));
  let currentMemberId = started.game!.currentMemberId;
  let version = started.version;
  const latencies: number[] = [];
  const began = performance.now();
  for (let index = 0; index < rollCount; index += 1) {
    const before = performance.now();
    const resolved = service.roll(byMember.get(currentMemberId)!, room.id, `benchmark-roll-${index}`, profile, version);
    latencies.push(performance.now() - before);
    currentMemberId = resolved.event.payload.nextMemberId;
    version = resolved.event.roomVersion;
  }
  const elapsedMs = performance.now() - began;
  repository.close();
  return { rolls: rollCount, elapsedMs: Number(elapsedMs.toFixed(1)), rollsPerSecond: Number((rollCount / elapsedMs * 1_000).toFixed(1)), latency: summary(latencies) };
}

async function websocketBenchmark(roomCount = 30) {
  const app = createApplication({ dbPath: ":memory:", presenceGraceMs: 0, cleanupIntervalMs: 0 });
  const rooms: Array<{ id: string; token: string; session: Session }> = [];
  for (let index = 0; index < roomCount; index += 1) {
    const hostCredential = app.service.createSession(`房主${index}`);
    const playerCredential = app.service.createSession(`玩家${index}`);
    const host = app.service.authenticate(hostCredential.token);
    const player = app.service.authenticate(playerCredential.token);
    const room = app.service.createRoom(host);
    const joined = app.service.joinRoom(player, room.code);
    app.service.startRoom(host, room.id, joined.version);
    rooms.push({ id: room.id, token: hostCredential.token, session: host });
  }
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const sockets: Socket[] = [];
  const setupStart = performance.now();
  await Promise.all(rooms.map(async (room, index) => {
    const socket = connect(base, { auth: { token: room.token }, transports: ["websocket"], reconnection: false });
    sockets[index] = socket;
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
    await socket.timeout(3_000).emitWithAck("room:subscribe", { protocolVersion: 1, commandId: `bench-sub-${index}`, roomId: room.id, payload: { lastSequence: 0 } });
  }));
  const setupMs = performance.now() - setupStart;
  const latencies: number[] = [];
  const began = performance.now();
  await Promise.all(rooms.map(async (room, index) => {
    const version = app.service.getRoom(room.session, room.id).version;
    const before = performance.now();
    const ack = await sockets[index]!.timeout(3_000).emitWithAck("game:roll", {
      protocolVersion: 1, commandId: `bench-network-roll-${index}`, roomId: room.id, expectedRoomVersion: version, payload: { throwProfile: profile }
    });
    if (!ack.ok) throw new Error(`roll rejected: ${ack.error.code}`);
    latencies.push(performance.now() - before);
  }));
  const elapsedMs = performance.now() - began;
  sockets.forEach((socket) => socket.disconnect());
  await app.close();
  return { rooms: roomCount, websocketSetupMs: Number(setupMs.toFixed(1)), concurrentRollBatchMs: Number(elapsedMs.toFixed(1)), latency: summary(latencies) };
}

const result = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  core: await coreBenchmark(Number(process.env.BOBING_BENCH_ROLLS ?? 3_000)),
  websocket: await websocketBenchmark(Number(process.env.BOBING_BENCH_ROOMS ?? 30))
};
console.log(JSON.stringify(result, null, 2));
