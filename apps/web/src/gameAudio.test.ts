import { describe, expect, it, vi } from "vitest";
import { GameAudio } from "./gameAudio";

function fixture() {
  const clips: Array<{ url: string; currentTime: number; ended: boolean; paused: boolean; preload: string; volume: number; load: ReturnType<typeof vi.fn>; play: ReturnType<typeof vi.fn> }> = [];
  const audio = new GameAudio("/bobing/", url => {
    const clip = { url, currentTime: 0, ended: false, paused: true, preload: "" as HTMLAudioElement["preload"], volume: 0, load: vi.fn(), play: vi.fn().mockResolvedValue(undefined) };
    clips.push(clip);
    return clip;
  });
  return { audio, clips };
}

describe("GameAudio", () => {
  it("loads actual local sound files and plays the requested cue", () => {
    const { audio, clips } = fixture();
    audio.preload();
    expect(clips.map(clip => clip.url)).toContain("/bobing/sounds/impact.wav");
    expect(clips.every(clip => clip.load.mock.calls.length === 1)).toBe(true);
    audio.play("toss");
    expect(clips.find(clip => clip.url.endsWith("toss.wav"))!.play).toHaveBeenCalledOnce();
  });

  it("respects mute and plays every impact and respects mute", () => {
    const { audio, clips } = fixture();
    audio.play("impact", .8);
    audio.play("impact", .8);
    expect(clips.reduce((count, clip) => count + clip.play.mock.calls.length, 0)).toBe(2);
    audio.play("impact", 1.2);
    expect(clips.reduce((count, clip) => count + clip.play.mock.calls.length, 0)).toBe(3);
    audio.setEnabled(false);
    audio.play("reward");
    expect(clips.find(clip => clip.url.endsWith("reward.wav"))!.play).not.toHaveBeenCalled();
  });
});
