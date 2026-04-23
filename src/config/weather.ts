/**
 * Weather system configuration.
 *
 * Weather is a *phase-scoped* modifier: every `WAVES_PER_PHASE` waves
 * (which aligns with the boss cadence in `enemies.ts`) the game rolls
 * a new weather that stays locked for the duration of the phase.
 * This gives the player a consistent ruleset to plan against across
 * the two zako waves and their closing boss / giga fight.
 *
 * Mirrors the shape of `enemies.ts` — pure data + one picker function
 * — so `MainScene` only has to look up `WEATHER_EFFECTS[current]` and
 * multiply its combat constants.
 */

export type Weather = "clear" | "snow" | "sand" | "drought";

export interface WeatherEffect {
  /** Uppercase short name shown on the HUD. */
  readonly label: string;
  /** CSS-style colour for the HUD label (matches the mood). */
  readonly color: string;
  /** Single-line description of what the weather does. */
  readonly hudDetail: string;

  /**
   * Damage multiplier applied to every ATTACK-flavoured damage event
   * (player HIT, CLASH, and the kaiju ATTACK landing on a cooling
   * mech). SPECIAL damage deliberately bypasses this so the big
   * finisher always feels impactful.
   */
  readonly attackDmgMul: number;
  /**
   * Multiplier on COOL's negative heat delta. Values above 1.0
   * amplify cooling (e.g. 1.5 turns -40 Heat into -60 Heat).
   */
  readonly coolBonusMul: number;
  /**
   * Multiplier on every Heat *gain* (ATTACK wind-up heat and SPECIAL
   * heat). Drought pushes the mech toward overheating faster.
   */
  readonly heatGainMul: number;
  /**
   * Number of kaiju reveal slots (out of SEQ_LEN) that get masked as
   * "?" during the Reading phase. The underlying action is still
   * resolved normally — only the preview is fogged up.
   */
  readonly kaijuNoiseSlots: number;
}

export const WEATHER_EFFECTS: Readonly<Record<Weather, WeatherEffect>> = {
  clear: {
    label: "CLEAR",
    color: "#8b949e",
    hudDetail: "no modifiers",
    attackDmgMul: 1.0,
    coolBonusMul: 1.0,
    heatGainMul: 1.0,
    kaijuNoiseSlots: 0,
  },
  snow: {
    label: "SNOW",
    color: "#88ccff",
    hudDetail: "ATK -25% / COOL +50%",
    attackDmgMul: 0.75,
    coolBonusMul: 1.5,
    heatGainMul: 1.0,
    kaijuNoiseSlots: 0,
  },
  sand: {
    label: "SAND",
    color: "#d9a66a",
    hudDetail: "1 kaiju slot hidden (?)",
    attackDmgMul: 1.0,
    coolBonusMul: 1.0,
    heatGainMul: 1.0,
    kaijuNoiseSlots: 1,
  },
  drought: {
    label: "DROUGHT",
    color: "#ff8855",
    hudDetail: "HEAT +50%",
    attackDmgMul: 1.0,
    coolBonusMul: 1.0,
    heatGainMul: 1.5,
    kaijuNoiseSlots: 0,
  },
} as const;

/** Rotation pool used once the tutorial-friendly Phase 1 is over. */
const WEATHER_POOL: readonly Weather[] = [
  "clear",
  "snow",
  "sand",
  "drought",
];

/**
 * Pick the weather for a given 0-based phase index.
 *  - Phase 0 is always `clear` so first-time players learn the core
 *    loop without extra rules piled on.
 *  - Phase 1+ draws uniformly from the full pool, including `clear`,
 *    so roughly 1 in 4 phases is a "breather".
 *
 * `rng` is optional; default is `Math.random`. Unit tests or scripted
 * demos can pass a seeded RNG for determinism.
 */
export function pickWeather(
  phaseIndex: number,
  rng: () => number = Math.random,
): Weather {
  if (phaseIndex <= 0) return "clear";
  return WEATHER_POOL[Math.floor(rng() * WEATHER_POOL.length)];
}
