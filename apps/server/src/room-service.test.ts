import { afterEach, describe, expect, it } from "vitest";
import { Repository } from "./database.js";
import type { RandomSource } from "./random.js";
import { RoomService } from "./room-service.js";

const dice = [1, 1, 4, 4, 4, 4] as const;

function deterministicRandom(): RandomSource {
  let id = 0;
  let dieIndex = 0;
  return {
    id: () => `test-id-${++id}`,
    token: () => `test-token-${++id}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
    unit: () => 0.5,
    die: () => dice[dieIndex++ % dice.length]!,
    roomCode: () => "ABC234"
  };
}

describe("room service", () => {
  let repository: Repository | undefined;
  afterEach(() => repository?.close());

  it("runs an authoritative room flow and replays an idempotent roll", () => {
    repository = new Repository(":memory:");
    const service = new RoomService(repository, deterministicRandom());
    const hostCredential = service.createSession("房主");
    const playerCredential = service.createSession("玩家二");
    const host = service.authenticate(hostCredential.token);
    const player = service.authenticate(playerCredential.token);
    const created = service.createRoom(host, 6);
    const joined = service.joinRoom(player, created.code);
    const started = service.startRoom(host, created.id, joined.version);
    const profile = { start: { x: 0, y: 0 }, direction: { x: 0, y: 1 }, strength: 0.7, holdDurationMs: 500 };

    const first = service.roll(host, created.id, "command-0001", profile, started.version);
    expect(first.event.payload.award.primary).toBe("CHAMPION_WITH_GOLDEN_FLOWERS");
    expect(first.event.payload.outsideProbabilityBasisPoints).toBe(0);
    expect(first.event.payload.nextMemberId).toBe(joined.members[1]!.id);
    expect(service.getRoom(host, created.id).game?.prizes.find((prize) => prize.tier === "CHAMPION")?.remaining).toBe(0);

    const replay = service.roll(host, created.id, "command-0001", profile);
    expect(replay.replayed).toBe(true);
    expect(replay.event.payload.rollId).toBe(first.event.payload.rollId);

    const snapshotSync = service.syncRoom(host, created.id, 0);
    expect(snapshotSync.mode).toBe("snapshot");
    const replaySync = service.syncRoom(host, created.id, started.sequence);
    expect(replaySync.mode).toBe("events");
    if (replaySync.mode === "events") expect(replaySync.events.map((item) => item.type)).toEqual(["game:roll-resolved"]);
  });

  it("persists presence events and resets stale online state during recovery", () => {
    repository = new Repository(":memory:");
    const service = new RoomService(repository, deterministicRandom());
    const hostCredential = service.createSession("房主");
    const playerCredential = service.createSession("玩家二");
    const host = service.authenticate(hostCredential.token);
    const player = service.authenticate(playerCredential.token);
    const created = service.createRoom(host);
    service.joinRoom(player, created.code);

    const onlineEvent = service.setPresence(host, created.id, true)!;
    expect(onlineEvent.payload.online).toBe(true);
    service.setPresence(host, created.id, false);
    const sync = service.syncRoom(host, created.id, onlineEvent.sequence);
    expect(sync.mode).toBe("events");
    if (sync.mode === "events") expect(sync.events[0]?.type).toBe("room:member-updated");

    const staleOnline = service.setPresence(host, created.id, true)!;
    const recovered = new RoomService(repository, deterministicRandom());
    expect(recovered.getRoom(host, created.id).members[0]!.online).toBe(false);
    const recoverySync = recovered.syncRoom(host, created.id, staleOnline.sequence);
    expect(recoverySync.mode).toBe("events");
    if (recoverySync.mode === "events") expect(recoverySync.events[0]?.type).toBe("room:presence-reset");
  });

  it("automatically skips offline turns but waits when everyone is offline", () => {
    repository = new Repository(":memory:");
    const service = new RoomService(repository, deterministicRandom());
    const host = service.authenticate(service.createSession("房主").token);
    const player = service.authenticate(service.createSession("离线玩家").token);
    const third = service.authenticate(service.createSession("在线玩家").token);
    const created = service.createRoom(host);
    service.joinRoom(player, created.code);
    const joined = service.joinRoom(third, created.code);

    service.setPresence(host, created.id, true);
    service.setPresence(third, created.id, true);
    const started = service.startRoom(host, created.id);
    const profile = { start: { x: 0, y: 0 }, direction: { x: 0, y: 1 }, strength: 0.7, holdDurationMs: 500 };
    const rolled = service.roll(host, created.id, "auto-skip-after-roll", profile, started.version);
    expect(rolled.event.payload.nextMemberId).toBe(joined.members[2]!.id);
    expect(rolled.event.payload.nextMemberId).not.toBe(joined.members[1]!.id);

    service.setPresence(host, created.id, false);
    service.setPresence(third, created.id, false);
    expect(service.skipOfflineTurns(created.id)).toBeUndefined();
    expect(service.getRoom(host, created.id).game?.currentMemberId).toBe(joined.members[2]!.id);

    service.setPresence(host, created.id, true);
    const skipped = service.skipOfflineTurns(created.id)!;
    expect(skipped.payload.game?.currentMemberId).toBe(joined.members[0]!.id);
    expect(skipped.payload.game?.turnNo).toBe(3);
  });

  it("supports idempotent host controls and host transfer", () => {
    repository = new Repository(":memory:");
    const service = new RoomService(repository, deterministicRandom());
    const hostCredential = service.createSession("房主");
    const playerCredential = service.createSession("玩家二");
    const host = service.authenticate(hostCredential.token);
    const player = service.authenticate(playerCredential.token);
    const created = service.createRoom(host);
    const joined = service.joinRoom(player, created.code);
    const started = service.startRoom(host, created.id, joined.version);

    const paused = service.pauseRoom(host, created.id, "pause-command", started.version);
    expect(paused.event.payload.state).toBe("PAUSED");
    expect(service.pauseRoom(host, created.id, "pause-command").replayed).toBe(true);
    const resumed = service.resumeRoom(host, created.id, "resume-command", paused.event.roomVersion);
    const skipped = service.skipTurn(host, created.id, "skip-command", resumed.event.roomVersion);
    expect(skipped.event.payload.game?.currentMemberId).toBe(joined.members[1]!.id);
    const transferred = service.transferHost(host, created.id, "transfer-command", joined.members[1]!.id, skipped.event.roomVersion);
    expect(transferred.event.payload.hostMemberId).toBe(joined.members[1]!.id);
    expect(service.transferHost(host, created.id, "transfer-command", joined.members[1]!.id).replayed).toBe(true);
  });

  it("updates prizes, records reactions, auto-transfers a leaving host, and builds reports", () => {
    repository = new Repository(":memory:");
    const service = new RoomService(repository, deterministicRandom());
    const hostCredential = service.createSession("房主");
    const playerCredential = service.createSession("接任房主");
    const thirdCredential = service.createSession("第三位玩家");
    const host = service.authenticate(hostCredential.token);
    const player = service.authenticate(playerCredential.token);
    const third = service.authenticate(thirdCredential.token);
    const createdWithToken = service.createRoomWithReportToken(host);
    const created = createdWithToken.room;
    service.joinRoom(player, created.code);
    const joined = service.joinRoom(third, created.code);
    const prizes = joined.prizeConfig.map((prize) => ({ ...prize, quantity: prize.tier === "CHAMPION" ? 1 : 0 }));
    const settings = service.updateSettings(host, created.id, "settings-command", { maxPlayers: 8, prizes }, joined.version);
    expect(settings.event.payload.maxPlayers).toBe(8);
    expect(service.sendReaction(player, created.id, "reaction-command", "CHEER").event.payload.reaction).toBe("CHEER");

    const beforeLeave = service.getRoom(host, created.id);
    const left = service.leaveRoom(host, created.id, "leave-command", beforeLeave.version);
    expect(left.event.payload.hostMemberId).toBe(joined.members[1]!.id);
    expect(service.leaveRoom(host, created.id, "leave-command").replayed).toBe(true);

    const room = service.getRoom(player, created.id);
    const started = service.startRoom(player, created.id, room.version);
    service.finishRoom(player, created.id, "finish-command", started.version);
    const report = service.getReport(player, created.id);
    expect(report.players).toHaveLength(3);
    expect(service.getPublicReport(created.id, createdWithToken.reportToken).state).toBe("FINISHED");
    expect(service.getRollPage(player, created.id, 0, 10)).toEqual({ items: [], nextCursor: null });
    expect(service.getReportCsv(player, created.id)).toContain("座位,昵称,投掷次数");
    service.deleteReport(player, created.id);
    expect(() => service.getRoom(player, created.id)).toThrow("房间不存在");
  });

  it("finishes the current round plus one extra round after prizes are depleted", () => {
    repository = new Repository(":memory:");
    const combinations: number[][] = [
      [1, 1, 4, 4, 4, 4],
      ...Array.from({ length: 2 }, () => [1, 2, 3, 4, 5, 6]),
      ...Array.from({ length: 4 }, () => [1, 2, 4, 4, 4, 6]),
      ...Array.from({ length: 8 }, () => [2, 2, 2, 2, 3, 5]),
      ...Array.from({ length: 16 }, () => [1, 2, 3, 4, 4, 6]),
      ...Array.from({ length: 32 }, () => [1, 1, 2, 3, 4, 6]),
      [1, 1, 2, 2, 3, 3],
      [1, 1, 2, 2, 3, 3],
      [1, 1, 2, 2, 3, 3]
    ];
    const faces = combinations.flat();
    let id = 0;
    let dieIndex = 0;
    const random: RandomSource = {
      id: () => `ending-id-${++id}`,
      token: () => `ending-token-${++id}-xxxxxxxxxxxxxxxxxxxxxxxx`,
      unit: () => 0.9,
      die: () => faces[dieIndex++]! as 1 | 2 | 3 | 4 | 5 | 6,
      roomCode: () => "END234"
    };
    const service = new RoomService(repository, random);
    const credential = service.createSession("单人测试");
    const secondCredential = service.createSession("第二位玩家");
    const session = service.authenticate(credential.token);
    const secondSession = service.authenticate(secondCredential.token);
    const created = service.createRoom(session);
    const joined = service.joinRoom(secondSession, created.code);
    service.startRoom(session, created.id, joined.version);
    const profile = { start: { x: 0, y: 0 }, direction: { x: 0, y: 1 }, strength: 0.7, holdDurationMs: 500 };

    for (let turn = 1; turn <= 63; turn += 1) {
      const room = service.getRoom(session, created.id);
      const currentSession = room.game?.currentMemberId === room.members[0]!.id ? session : secondSession;
      service.roll(currentSession, created.id, `deplete-${turn}`, profile, room.version);
    }
    const ending = service.getRoom(session, created.id);
    expect(ending.state).toBe("PLAYING");
    expect(ending.game?.ending).toEqual({ triggeredAtTurnNo: 63, finishAfterRoundNo: 33 });

    for (let turn = 1; turn <= 2; turn += 1) {
      const room = service.getRoom(session, created.id);
      const currentSession = room.game?.currentMemberId === room.members[0]!.id ? session : secondSession;
      service.roll(currentSession, created.id, `ending-${turn}`, profile, room.version);
      expect(service.getRoom(session, created.id).state).toBe("PLAYING");
    }
    const beforeFinal = service.getRoom(session, created.id);
    const finalSession = beforeFinal.game?.currentMemberId === beforeFinal.members[0]!.id ? session : secondSession;
    const finalRoll = service.roll(finalSession, created.id, "ending-3", profile, beforeFinal.version);
    expect(finalRoll.event.payload.gameFinished).toBe(true);
    expect(service.getRoom(session, created.id).state).toBe("FINISHED");
  });
});
