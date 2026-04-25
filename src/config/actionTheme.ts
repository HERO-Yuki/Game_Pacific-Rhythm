import { MATERIAL_ICON_GLYPH } from "./materialIconCodepoints";

/**
 * Language-neutral action theming: colour + Material Icons PUA glyph for UI.
 * String keys match `ActionType` enum values in `MainScene`.
 */
export const ACTION_THEME: Readonly<
  Record<string, { readonly color: number; readonly icon: string; readonly hex: string }>
> = {
  ATTACK: { color: 0xff4444, icon: MATERIAL_ICON_GLYPH.attack, hex: "#ff4444" },
  GUARD: { color: 0x44cc44, icon: MATERIAL_ICON_GLYPH.guard, hex: "#44cc44" },
  COOL: { color: 0x44aaff, icon: MATERIAL_ICON_GLYPH.cool, hex: "#44aaff" },
  SPECIAL: { color: 0xaa44ff, icon: MATERIAL_ICON_GLYPH.special, hex: "#aa44ff" },
  /** Enemy-only; player empty slots are styled separately. */
  IDLE: { color: 0x888888, icon: MATERIAL_ICON_GLYPH.idle, hex: "#888888" },
} as const;

export const THEME_TINT_ALPHA = 0.32;
export const THEME_TINT_HEAVY = 0.45;

export function actionTheme(
  a: string,
): { color: number; icon: string; hex: string } {
  return ACTION_THEME[a] ?? ACTION_THEME.IDLE;
}
