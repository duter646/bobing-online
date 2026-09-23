import { afterEach, describe, expect, it } from "vitest";
import { Repository } from "./database.js";
import type { RandomSource } from "./random.js";
import { RoomService } from "./room-service.js";

const randomSource = (): RandomSource => {
  const dice = [1, 1, 4, 4, 4, 4] as const;
  let counter = 0;
  let face = 0;
  return {
    id: () => `auth-id-${++counter}`,
    token: () => `auth-token-${++counter}-xxxxxxxxxxxxxxxxxxxxxxxx`,
    unit: () => 0.9,
    die: () => dice[face++ % dice.length]!,
    roomCode: () => "AUTH88"
  };
};

describe("email/password accounts and statistics", () => {
  let repository: Repository | undefined;
  afterEach(() => repository?.close());

  it("registers, logs in, restores account room identity, and rejects invalid credentials", async () => {
    repository = new Repository(":memory:");
    const service = new RoomService(repository, randomSource());
    const registered = await service.register(" User@Example.COM ", "correct-password", "默认名字");
    const original = service.authenticate(registered.token);
    expect(service.identity(original)).toMatchObject({ authenticated: true, defaultDisplayName: "默认名字" });
    expect(registered.account.email).toBe("user@example.com");
    await expect(service.register("user@example.com", "another-password", "重复账户")).rejects.toThrow("已经注册");
    await expect(service.login("user@example.com", "wrong-password")).rejects.toThrow("邮箱或密码错误");

    const room = service.createRoom(original);
    const secondLogin = await service.login("USER@example.com", "correct-password");
    const loggedInAgain = service.authenticate(secondLogin.token);
    expect(service.getRoom(loggedInAgain, room.id).id).toBe(room.id);
    expect(service.updateSessionName(loggedInAgain, "本局别名").displayName).toBe("本局别名");
    service.logout(loggedInAgain);
    expect(() => service.authenticate(secondLogin.token)).toThrow("会话无效或已过期");
    const guest = service.authenticate(service.createSession("游客").token);
    expect(() => service.stats(guest)).toThrow("登录后才能查看个人统计");
  });

  it("aggregates awards, frequencies, prizes, games, and duration across account sessions", async () => {
    repository = new Repository(":memory:");
    const service = new RoomService(repository, randomSource());
    const hostRegistration = await service.register("host@example.com", "correct-password", "统计房主");
    const playerRegistration = await service.register("player@example.com", "correct-password", "统计玩家");
    const host = service.authenticate(hostRegistration.token);
    const player = service.authenticate(playerRegistration.token);
    const room = service.createRoom(host);
    const joined = service.joinRoom(player, room.code);
    const started = service.startRoom(host, room.id, joined.version);
    const profile = { start: { x: 0, y: 0 }, direction: { x: 0, y: 1 }, strength: 0.7, holdDurationMs: 500 };
    const roll = service.roll(host, room.id, "stats-roll", profile, started.version);
    service.finishRoom(host, room.id, "stats-finish", roll.event.roomVersion);

    const freshLogin = service.authenticate((await service.login("host@example.com", "correct-password")).token);
    const stats = service.stats(freshLogin);
    expect(stats.totalRolls).toBe(1);
    expect(stats.gamesPlayed).toBe(1);
    expect(stats.completedGames).toBe(1);
    expect(stats.awards).toContainEqual({ award: "CHAMPION_WITH_GOLDEN_FLOWERS", count: 1, frequency: 1 });
    expect(stats.prizes).toMatchObject({ CHAMPION: 1 });
    expect(stats.playDurationMs).toBeGreaterThanOrEqual(0);
  });
});
