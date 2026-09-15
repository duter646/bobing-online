import { afterEach, describe, expect, it } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import { createApplication } from "./app.js";
import { Repository } from "./database.js";
import { secureRandom, type RandomSource } from "./random.js";
import { RoomService } from "./room-service.js";

interface Scenario {
  app: ReturnType<typeof createApplication>;
  base: string;
  roomId: string;
  hostToken: string;
  host: ReturnType<ReturnType<typeof createApplication>["service"]["authenticate"]>;
  hostSocket: Socket;
  playerSocket: Socket;
}

const live: Scenario[] = [];

async function connected(base: string, token: string): Promise<Socket> {
  const socket = connect(base, { auth: { token }, transports: ["websocket"], reconnection: false });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  return socket;
}

async function setup(): Promise<Scenario> {
  const app = createApplication({ dbPath: ":memory:", random: secureRandom, presenceGraceMs: 30, cleanupIntervalMs: 0 });
  const hostCredential = app.service.createSession("并发房主");
  const playerCredential = app.service.createSession("并发玩家");
  const host = app.service.authenticate(hostCredential.token);
  const player = app.service.authenticate(playerCredential.token);
  const room = app.service.createRoom(host);
  const joined = app.service.joinRoom(player, room.code);
  app.service.startRoom(host, room.id, joined.version);
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const hostSocket = await connected(base, hostCredential.token);
  const playerSocket = await connected(base, playerCredential.token);
  await hostSocket.emitWithAck("room:subscribe", { protocolVersion: 1, commandId: `sub-${crypto.randomUUID()}`, roomId: room.id, payload: { lastSequence: 0 } });
  await playerSocket.emitWithAck("room:subscribe", { protocolVersion: 1, commandId: `sub-${crypto.randomUUID()}`, roomId: room.id, payload: { lastSequence: 0 } });
  const scenario = { app, base, roomId: room.id, hostToken: hostCredential.token, host, hostSocket, playerSocket };
  live.push(scenario);
  return scenario;
}

const profile = { start: { x: 0, y: 0 }, direction: { x: 0.2, y: 0.9 }, strength: 0.7, holdDurationMs: 480 };

describe("backend acceptance under concurrency and weak networks", () => {
  afterEach(async () => {
    while (live.length) {
      const scenario = live.pop()!;
      scenario.hostSocket.disconnect();
      scenario.playerSocket.disconnect();
      await scenario.app.close();
    }
  });

  it("settles two concurrent commands for one turn exactly once", async () => {
    const scenario = await setup();
    const version = scenario.app.service.getRoom(scenario.host, scenario.roomId).version;
    const make = (id: string) => scenario.hostSocket.timeout(2_000).emitWithAck("game:roll", {
      protocolVersion: 1, commandId: id, roomId: scenario.roomId, expectedRoomVersion: version, payload: { throwProfile: profile }
    });
    const results = await Promise.all([make("race-roll-a"), make("race-roll-b")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(scenario.app.service.getReport(scenario.host, scenario.roomId).totalRolls).toBe(1);
  });

  it("returns the same result for concurrent duplicate command IDs", async () => {
    const scenario = await setup();
    const version = scenario.app.service.getRoom(scenario.host, scenario.roomId).version;
    const command = { protocolVersion: 1, commandId: "same-roll-command", roomId: scenario.roomId, expectedRoomVersion: version, payload: { throwProfile: profile } };
    const results = await Promise.all([
      scenario.hostSocket.timeout(2_000).emitWithAck("game:roll", command),
      scenario.hostSocket.timeout(2_000).emitWithAck("game:roll", command)
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results[0].data.payload.rollId).toBe(results[1].data.payload.rollId);
    expect(scenario.app.service.getReport(scenario.host, scenario.roomId).totalRolls).toBe(1);
  });

  it("recovers a committed roll after ACK loss, disconnect, delay, and retry", async () => {
    const scenario = await setup();
    const before = scenario.app.service.getRoom(scenario.host, scenario.roomId);
    const command = { protocolVersion: 1, commandId: "lost-ack-roll", roomId: scenario.roomId, expectedRoomVersion: before.version, payload: { throwProfile: profile } };
    const observed = new Promise<any>((resolve) => scenario.playerSocket.once("game:roll-resolved", resolve));
    scenario.hostSocket.emit("game:roll", command);
    const committed = await observed;
    scenario.hostSocket.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const recoveredSocket = await connected(scenario.base, scenario.hostToken);
    scenario.hostSocket = recoveredSocket;
    const sync = await recoveredSocket.timeout(2_000).emitWithAck("room:subscribe", {
      protocolVersion: 1, commandId: "recover-subscribe", roomId: scenario.roomId, payload: { lastSequence: before.sequence }
    });
    expect(sync.ok).toBe(true);
    expect(sync.data.mode).toBe("events");
    expect(sync.data.events.some((item: any) => item.type === "game:roll-resolved" && item.event.payload.rollId === committed.payload.rollId)).toBe(true);

    const retry = await recoveredSocket.timeout(2_000).emitWithAck("game:roll", command);
    expect(retry.ok).toBe(true);
    expect(retry.data.payload.rollId).toBe(committed.payload.rollId);
    expect(scenario.app.service.getReport(scenario.host, scenario.roomId).totalRolls).toBe(1);
  });

  it("lets 12 players exhaust all 63 prizes and finish the required extra round", () => {
    const awardRolls: number[][] = [
      [1, 1, 4, 4, 4, 4],
      ...Array.from({ length: 2 }, () => [1, 2, 3, 4, 5, 6]),
      ...Array.from({ length: 4 }, () => [1, 2, 4, 4, 4, 6]),
      ...Array.from({ length: 8 }, () => [2, 2, 2, 2, 3, 5]),
      ...Array.from({ length: 16 }, () => [1, 2, 3, 4, 4, 6]),
      ...Array.from({ length: 32 }, () => [1, 1, 2, 3, 4, 6])
    ];
    const faces = [...awardRolls, ...Array.from({ length: 21 }, () => [1, 1, 2, 2, 3, 3])].flat(2);
    let id = 0;
    let faceIndex = 0;
    const random: RandomSource = {
      id: () => `twelve-id-${++id}`,
      token: () => `twelve-token-${++id}-xxxxxxxxxxxxxxxxxxxxxxxx`,
      unit: () => 0.9,
      die: () => faces[faceIndex++]! as 1 | 2 | 3 | 4 | 5 | 6,
      roomCode: () => "TWELVE"
    };
    const repository = new Repository(":memory:");
    const service = new RoomService(repository, random);
    const sessions = Array.from({ length: 12 }, (_, index) => {
      const credential = service.createSession(`十二人玩家${index + 1}`);
      return service.authenticate(credential.token);
    });
    const room = service.createRoom(sessions[0]!);
    let joined = room;
    for (const session of sessions.slice(1)) joined = service.joinRoom(session, room.code);
    const started = service.startRoom(sessions[0]!, room.id, joined.version);
    const byMember = new Map(started.members.map((member, index) => [member.id, sessions[index]!]));
    let current = started.game!.currentMemberId;
    let version = started.version;
    for (let turn = 1; turn <= 84; turn += 1) {
      const resolved = service.roll(byMember.get(current)!, room.id, `twelve-roll-${turn}`, profile, version);
      current = resolved.event.payload.nextMemberId;
      version = resolved.event.roomVersion;
      expect(resolved.event.payload.gameFinished).toBe(turn === 84);
    }
    const finished = service.getRoom(sessions[0]!, room.id);
    expect(finished.state).toBe("FINISHED");
    expect(finished.game?.prizes.every((prize) => prize.remaining === 0)).toBe(true);
    expect(service.getReport(sessions[0]!, room.id).totalRolls).toBe(84);
    repository.close();
  });
});
