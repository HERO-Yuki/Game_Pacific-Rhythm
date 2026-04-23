/**
 * Enemy (kaiju) balance configuration.
 *
 * Extracted out of MainScene so non-coders can tune HP, scale, and
 * wave cadence without wading through scene logic. MainScene imports
 * these values and never hard-codes them — edit here, reload, done.
 *
 * See also: docs/midjourney-kaiju-prompts.md for the art direction
 * behind each rank's sprite.
 */

export type KaijuRank = "zako" | "boss" | "giga";

export interface KaijuRankStats {
  /** Texture key loaded by `PreloaderScene`. */
  readonly texture: string;
  /** Starting & max HP for the rank — also the HP-bar denominator. */
  readonly hp: number;
  /**
   * Multiplier applied on top of the layout's base body size so higher
   * ranks feel physically bigger on screen (zako = 1.0 keeps parity
   * with the mech).
   */
  readonly scaleMul: number;
  /** Text shown beneath the body. */
  readonly label: string;
  /** CSS-style colour for the label — pick something distinct per rank. */
  readonly labelColor: string;
}

export const KAIJU_STATS: Readonly<Record<KaijuRank, KaijuRankStats>> = {
  zako: {
    texture: "kaiju-zako",
    hp: 100,
    scaleMul: 1.0,
    label: "KAIJU",
    labelColor: "#cc3333",
  },
  boss: {
    texture: "kaiju-boss",
    hp: 180,
    scaleMul: 1.4,
    label: "BOSS",
    labelColor: "#ff4444",
  },
  giga: {
    texture: "kaiju-giga",
    hp: 280,
    scaleMul: 1.65,
    label: "GIGA",
    labelColor: "#ff2a8a",
  },
} as const;

/**
 * Wave cadence for rank rotation.
 *  - Every `GIGA_EVERY` waves → giga (9, 18, 27, …) — wins over boss
 *  - Else every `BOSS_EVERY` waves → boss (3, 6, 12, 15, …)
 *  - Else → zako
 *
 * `GIGA_EVERY` should stay a multiple of `BOSS_EVERY` so the rhythm
 * of "two zako, one boss, repeat, then a giga" reads cleanly.
 */
export const BOSS_EVERY = 3;
export const GIGA_EVERY = 9;

/**
 * Pure mapping from a 1-based wave index to its kaiju rank.
 * Priority: giga > boss > zako. Extracted so future previews
 * (WARNING screens, minimap, etc.) can reuse the exact same rule.
 */
export function pickKaijuRank(wave: number): KaijuRank {
  if (wave % GIGA_EVERY === 0) return "giga";
  if (wave % BOSS_EVERY === 0) return "boss";
  return "zako";
}
