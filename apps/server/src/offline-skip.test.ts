import { afterEach, describe, expect, it } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import { createApplication } from "./app.js";

describe("offline turn skipping", () => {
  const sockets: Socket[] = [];
  const app = createApplication({ dbPath: ":memory:", presenceGraceMs: 20, cleanupIntervalMs: 0 });

  afterEach(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await app.close();
  });

  it("skips the current player after the disconnect grace period", async () => {
    const port = await app.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const createSession = async (displayName: string) => {
      const response = await fetch(`${base}/api/sessions`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName })
      });
      return response.json() as Promise<{ token: string }>;
    };
    const host = await createSession("房主");
    const player = await createSession("断线玩家");
    const hostHeaders = { authorization: `Bearer ${host.token}`, "content-type": "application/json" };
    const roomResponse = await fetch(`${base}/api/rooms`, { method: "POST", headers: hostHeaders, body: "{}" });
    const created = await roomResponse.json() as { id: string; code: string };
    await fetch(`${base}/api/rooms/join`, {
      method: "POST", headers: { authorization: `Bearer ${player.token}`, "content-type": "application/json" },
      body: JSON.stringify({ code: created.code })
    });

    const open = async (token: string, commandId: string) => {
      const socket = connect(base, { auth: { token }, transports: ["websocket"] });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
      await socket.timeout(2_000).emitWithAck("room:subscribe", {
        protocolVersion: 1, commandId, roomId: created.id, payload: { lastSequence: 0 }
      });
      return socket;
    };
    const hostSocket = await open(host.token, "offline-host-subscribe");
    const playerSocket = await open(player.token, "offline-player-subscribe");
    const currentResponse = await fetch(`${base}/api/rooms/${created.id}`, { headers: hostHeaders });
    const current = await currentResponse.json() as { version: number; members: Array<{ id: string }> };
    const startResponse = await fetch(`${base}/api/rooms/${created.id}/start`, {
      method: "POST", headers: hostHeaders, body: JSON.stringify({ expectedRoomVersion: current.version })
    });
    const started = await startResponse.json() as { version: number };
    const roll = await hostSocket.timeout(2_000).emitWithAck("game:roll", {
      protocolVersion: 1, commandId: "offline-host-roll", roomId: created.id, expectedRoomVersion: started.version,
      payload: { throwProfile: { start: { x: 0, y: 0 }, direction: { x: 0, y: 1 }, strength: 0.5, holdDurationMs: 300 } }
    });
    expect(roll.ok).toBe(true);
    expect(roll.data.payload.nextMemberId).toBe(current.members[1]!.id);

    const turnChanged = new Promise<{ payload: { game: { currentMemberId: string }; members: Array<{ id: string; online: boolean }> } }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("没有收到离线自动跳过事件")), 2_000);
      hostSocket.once("game:turn-changed", (event) => { clearTimeout(timeout); resolve(event); });
    });
    playerSocket.disconnect();
    const event = await turnChanged;
    expect(event.payload.game.currentMemberId).toBe(current.members[0]!.id);
    expect(event.payload.members[1]!.online).toBe(false);
  });
});
