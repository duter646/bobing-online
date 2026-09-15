import { afterEach, describe, expect, it } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import { createApplication } from "./app.js";
import type { RandomSource } from "./random.js";

const scriptedRandom = (): RandomSource => {
  const faces = [1, 1, 4, 4, 4, 4] as const;
  let counter = 0;
  let face = 0;
  return {
    id: () => `network-id-${++counter}`,
    token: () => `network-token-${++counter}-xxxxxxxxxxxxxxxxxxxxxxxx`,
    unit: () => 0.9,
    die: () => faces[face++ % faces.length]!,
    roomCode: () => "NET234"
  };
};

describe("HTTP and Socket.IO application", () => {
  const app = createApplication({ dbPath: ":memory:", random: scriptedRandom(), presenceGraceMs: 0, cleanupIntervalMs: 0 });
  const sockets: Socket[] = [];
  afterEach(async () => { sockets.forEach((socket) => socket.disconnect()); await app.close(); });

  it("creates, starts, subscribes and resolves a roll", async () => {
    const port = await app.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const sessionResponse = await fetch(`${base}/api/sessions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "端到端玩家" })
    });
    const credential = await sessionResponse.json() as { token: string };
    const headers = { authorization: `Bearer ${credential.token}`, "content-type": "application/json" };
    const roomResponse = await fetch(`${base}/api/rooms`, { method: "POST", headers, body: "{}" });
    const room = await roomResponse.json() as { id: string; code: string; version: number; reportToken: string };
    const secondResponse = await fetch(`${base}/api/sessions`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "第二位玩家" })
    });
    const secondCredential = await secondResponse.json() as { token: string };
    const joinResponse = await fetch(`${base}/api/rooms/join`, {
      method: "POST",
      headers: { authorization: `Bearer ${secondCredential.token}`, "content-type": "application/json" },
      body: JSON.stringify({ code: room.code })
    });
    const joined = await joinResponse.json() as { version: number };
    const startResponse = await fetch(`${base}/api/rooms/${room.id}/start`, {
      method: "POST", headers, body: JSON.stringify({ expectedRoomVersion: joined.version })
    });
    const started = await startResponse.json() as { version: number };

    const socket = connect(base, { auth: { token: credential.token }, transports: ["websocket"] });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
    const subscribe = await socket.timeout(2_000).emitWithAck("room:subscribe", {
      protocolVersion: 1, commandId: "subscribe-001", roomId: room.id, payload: { lastSequence: 0 }
    });
    expect(subscribe.ok).toBe(true);
    expect(subscribe.data.mode).toBe("snapshot");
    expect(subscribe.data.snapshot.members[0].online).toBe(true);

    const secondTab = connect(base, { auth: { token: credential.token }, transports: ["websocket"] });
    sockets.push(secondTab);
    await new Promise<void>((resolve, reject) => { secondTab.once("connect", resolve); secondTab.once("connect_error", reject); });
    const secondSync = await secondTab.timeout(2_000).emitWithAck("room:subscribe", {
      protocolVersion: 1, commandId: "subscribe-002", roomId: room.id, payload: { lastSequence: subscribe.data.snapshot.sequence }
    });
    expect(secondSync.data).toMatchObject({ mode: "events", events: [] });
    const oldTabAttempt = await socket.timeout(2_000).emitWithAck("game:roll", {
      protocolVersion: 1, commandId: "old-tab-roll", roomId: room.id,
      expectedRoomVersion: subscribe.data.snapshot.version,
      payload: { throwProfile: { start: { x: 0, y: 0 }, direction: { x: 0, y: 1 }, strength: 0.7, holdDurationMs: 500 } }
    });
    expect(oldTabAttempt).toMatchObject({ ok: false, error: { code: "COMMAND_CONFLICT" } });
    socket.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stillOnline = await fetch(`${base}/api/rooms/${room.id}`, { headers });
    expect(((await stillOnline.json()) as { members: Array<{ online: boolean }> }).members[0]!.online).toBe(true);

    const roll = await secondTab.timeout(2_000).emitWithAck("game:roll", {
      protocolVersion: 1, commandId: "network-roll-001", roomId: room.id, expectedRoomVersion: subscribe.data.snapshot.version,
      payload: { throwProfile: { start: { x: 0, y: 0 }, direction: { x: 0, y: 1 }, strength: 0.7, holdDurationMs: 500 } }
    });
    expect(roll.ok).toBe(true);
    expect(roll.data.payload.award.primary).toBe("CHAMPION_WITH_GOLDEN_FLOWERS");

    const historyResponse = await fetch(`${base}/api/rooms/${room.id}/rolls?limit=10`, { headers });
    expect(((await historyResponse.json()) as { items: unknown[] }).items).toHaveLength(1);
    const finish = await secondTab.timeout(2_000).emitWithAck("game:finish", {
      protocolVersion: 1, commandId: "finish-network-001", roomId: room.id,
      expectedRoomVersion: roll.data.roomVersion, payload: {}
    });
    expect(finish.ok).toBe(true);
    const publicReport = await fetch(`${base}/api/reports/${room.id}?token=${encodeURIComponent(room.reportToken)}`);
    expect(((await publicReport.json()) as { totalRolls: number }).totalRolls).toBe(1);

    secondTab.disconnect();
    let offline = false;
    for (let attempt = 0; attempt < 20 && !offline; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const response = await fetch(`${base}/api/rooms/${room.id}`, { headers });
      offline = !((await response.json()) as { members: Array<{ online: boolean }> }).members[0]!.online;
    }
    expect(offline).toBe(true);
  });
});
