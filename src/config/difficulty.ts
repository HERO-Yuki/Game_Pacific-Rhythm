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
}

export const DIFFICULTY_CONFIGS: Readonly<Record<Difficulty, DifficultyConfig>> =
  {
    easy: {
      id: "easy",
      label: "EASY",
      phases: 5,
      hasWeather: false,
      tagline: "5 phases · no weather · learn the rhythm",
    },
    normal: {
      id: "normal",
      label: "NORMAL",
      phases: 7,
      hasWeather: true,
      tagline: "7 phases · weather on · the intended ride",
    },
    endless: {
      id: "endless",
      label: "ENDLESS",
      phases: Infinity,
      hasWeather: true,
      tagline: "no end · weather on · chase the best score",
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
