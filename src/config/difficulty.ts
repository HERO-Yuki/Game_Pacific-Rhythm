/**
 * Difficulty configuration.
 *
 * A "phase" here means one boss cadence block, i.e. `BOSS_EVERY`
 * consecutive waves (zako → zako → boss by default). Difficulty
 * controls two axes:
 *
 *   1. Length        — how many phases you need to clear to win
 *                      (infinity for endless runs).
 *   2. Weather gate  — whether the weather system rolls at all.
 *                      Easy hides weather so new players can focus
 *                      on the core rhythm loop; normal/endless use
 *                      the full config in `src/config/weather.ts`.
 *
 * Balance numbers live here so designers can tune run length
 * without touching MainScene.
 */
import { BOSS_EVERY } from "./enemies";

export type Difficulty = "easy" | "normal" | "endless";

export interface DifficultyConfig {
  readonly id: Difficulty;
  /** Player-facing name rendered on the title-screen buttons. */
  readonly label: string;
  /**
   * Number of phases that must be cleared to trigger GAME CLEAR.
   * `Infinity` for endless runs — the game never reaches a clear
   * state on its own; the player plays until they die or quit.
   */
  readonly phases: number;
  /** `true` if the weather system should roll; otherwise always clear. */
  readonly hasWeather: boolean;
  /** One-line tagline shown beneath the button on the title screen. */
  readonly tagline: string;
  /**
   * Beat interval in milliseconds for both the rhythm and resolution phases.
   * Lower value = faster tempo. 1000 ms = 60 BPM (the intended "normal" feel).
   * EASY uses a longer interval to give learners extra time to read and react.
   */
  readonly beatMs: number;
}

export const DIFFICULTY_CONFIGS: Readonly<Record<Difficulty, DifficultyConfig>> =
  {
    easy: {
      id: "easy",
      label: "EASY",
      phases: 5,
      hasWeather: false,
      tagline: "5 phases · no weather · learn the rhythm",
      // 48 BPM — 25% slower than normal; gives learners more
      // reading time without breaking the rhythmic feel.
      beatMs: 1250,
    },
    normal: {
      id: "normal",
      label: "NORMAL",
      phases: 7,
      hasWeather: true,
      tagline: "7 phases · weather on · the intended ride",
      beatMs: 1000, // 60 BPM — intended tempo
    },
    endless: {
      id: "endless",
      label: "ENDLESS",
      phases: Infinity,
      hasWeather: true,
      tagline: "no end · weather on · chase the best score",
      // 起動直後（wave1・phase0）の基準; 以降は `beatMsForEndlessWave` で上書き
      beatMs: 1000, // 60 BPM
    },
  } as const;

/**
 * Ordered list used by the title screen to render buttons and by
 * the keyboard navigation to know "what's next" / "what's previous".
 */
export const DIFFICULTY_ORDER: readonly Difficulty[] = [
  "easy",
  "normal",
  "endless",
] as const;

/**
 * Number of waves that must be cleared to trigger GAME CLEAR.
 * `Infinity` for endless runs.
 */
export function maxWavesForDifficulty(diff: Difficulty): number {
  const phases = DIFFICULTY_CONFIGS[diff].phases;
  return phases === Infinity ? Infinity : phases * BOSS_EVERY;
}

export function isEndless(diff: Difficulty): boolean {
  return DIFFICULTY_CONFIGS[diff].phases === Infinity;
}

/** エンドレス開始 BPM（`beatMs` 1000 ms と同じ 60）。 */
export const ENDLESS_BPM_BASE = 60;

/** フェーズ（`BOSS_EVERY` 波ブロック）ごとに上げる BPM 幅。 */
export const ENDLESS_BPM_RISE_PER_PHASE = 2;

/**
 * 極端に速くなりすぎるのを防ぐ上限。ゲーム性に合わせて調整可。
 * `phaseIndex` が大きいほど `ENDLESS_BPM_MAX` に張り付く。
 */
export const ENDLESS_BPM_MAX = 200;

/**
 * エンドレス専用: 1-based `wave` に対応する 1 拍の長さ (ms)。
 * フェーズ番号は `Math.floor((wave - 1) / BOSS_EVERY)`（天候と同じ区切り）。
 */
export function beatMsForEndlessWave(wave: number): number {
  if (wave < 1) {
    return DIFFICULTY_CONFIGS.endless.beatMs;
  }
  const phaseIdx = Math.max(0, Math.floor((wave - 1) / BOSS_EVERY));
  const bpm = Math.min(
    ENDLESS_BPM_BASE + ENDLESS_BPM_RISE_PER_PHASE * phaseIdx,
    ENDLESS_BPM_MAX,
  );
  return Math.max(1, Math.round(60000 / bpm));
}
