/**
 * Google "Material Icons" (classic) — PUA codepoints for Canvas / Phaser `Text`.
 * Ligature names do not work reliably with `CanvasRenderingContext2D.fillText`;
 * use these single-character strings instead.
 *
 * Names reference
 * https://github.com/google/material-design-icons/blob/master/font/MaterialIcons-Regular.codepoints
 */

/** One character per icon for `fontFamily: "Material Icons"`. */
export const MATERIAL_ICON_GLYPH = {
  /** sports_martial_arts — closest classic icon to a melee strike. */
  attack: "\u{eae9}",
  /** shield */
  guard: "\u{e9e0}",
  /** ac_unit */
  cool: "\u{eb3b}",
  /** priority_high */
  special: "\u{e645}",
  /** fiber_manual_record — small dot for empty / idle. */
  idle: "\u{e061}",
  /** dangerous — no `skull` in classic set; reads as a threat / KO tally. */
  scoreKills: "\u{e99a}",
  /** music_note */
  phaseReading: "\u{e405}",
  /** dashboard_customize */
  phaseProgram: "\u{e99b}",
  /** gavel — resolution / adjudication beat. */
  phaseResolve: "\u{e90e}",
  /** star — rating row on GAME CLEAR (avoids Unicode star + wrong font). */
  star: "\u{e838}",
  /** wb_sunny — clear weather, no extra modifiers. */
  weatherClear: "\u{e430}",
  /** snowing — snow phase (ATK nerf, extra COOL). */
  weatherSnow: "\u{e80f}",
  /** terrain — sand: hidden slot / ground-hazard mood. */
  weatherSand: "\u{e564}",
  /** local_fire_department — drought: extra heat build-up. */
  weatherDrought: "\u{ef55}",
} as const;

/** Phaser `Text` style: must pair with {@link MATERIAL_ICON_GLYPH} characters. */
export function materialIconGlyphStyle(
  sizePx: number,
  color: string,
  strokeThickness = 2,
): Phaser.Types.GameObjects.Text.TextStyle {
  return {
    fontFamily: '"Material Icons", sans-serif',
    fontSize: `${sizePx}px`,
    color,
    stroke: "#000000",
    strokeThickness,
    fontStyle: "normal",
  };
}
