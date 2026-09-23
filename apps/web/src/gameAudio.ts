export type SoundCue = "toss" | "impact" | "reward";

type AudioClip = Pick<HTMLAudioElement, "currentTime" | "ended" | "load" | "paused" | "play" | "preload" | "volume">;
const poolSize: Record<SoundCue, number> = { toss: 1, impact: 12, reward: 1 };
const baseVolume: Record<SoundCue, number> = { toss: .34, impact: .3, reward: .28 };

export class GameAudio {
  private readonly pools = new Map<SoundCue, AudioClip[]>();
  private readonly nextIndex = new Map<SoundCue, number>();
  private enabled = true;

  constructor(
    private readonly baseUrl: string,
    private readonly createClip: (url: string) => AudioClip = url => new Audio(url),
  ) {}

  setEnabled(enabled: boolean) { this.enabled = enabled; }

  preload() {
    for (const cue of ["toss", "impact", "reward"] as const) {
      if (this.pools.has(cue)) continue;
      const url = `${this.baseUrl.replace(/\/?$/, "/")}sounds/${cue}.wav`;
      const clips = Array.from({ length: poolSize[cue] }, () => {
        const clip = this.createClip(url);
        clip.preload = "auto";
        clip.load();
        return clip;
      });
      this.pools.set(cue, clips);
    }
  }

  play(cue: SoundCue, intensity = 1) {
    if (!this.enabled) return;
    this.preload();
    const pool = this.pools.get(cue)!;
    const index = this.nextIndex.get(cue) ?? 0;
    const clip = pool[index % pool.length]!;
    this.nextIndex.set(cue, (index + 1) % pool.length);
    clip.volume = Math.min(1, baseVolume[cue] * Math.max(.25, Math.min(1.5, intensity)));
    clip.currentTime = 0;
    void clip.play().catch(() => { /* Browser audio starts after a user gesture. */ });
  }
}
