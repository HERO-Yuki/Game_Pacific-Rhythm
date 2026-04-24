/**
 * Language-neutral action theming: colour + icon for UI (buttons, sequencer).
 * String keys match `ActionType` enum values in `MainScene`.
 */
export const ACTION_THEME: Readonly<
  Record<string, { readonly color: number; readonly icon: string; readonly hex: string }>
> = {
  ATTACK: { color: 0xff4444, icon: "⚔️", hex: "#ff4444" },
  GUARD: { color: 0x44cc44, icon: "🛡️", hex: "#44cc44" },
  COOL: { color: 0x44aaff, icon: "❄️", hex: "#44aaff" },
  SPECIAL: { color: 0xaa44ff, icon: "⚠️", hex: "#aa44ff" },
  /** Enemy-only; player empty slots are styled separately. */
  IDLE: { color: 0x888888, icon: "・", hex: "#888888" },
} as const;

export const THEME_TINT_ALPHA = 0.32;
export const THEME_TINT_HEAVY = 0.45;

export function actionTheme(
  a: string,
): { color: number; icon: string; hex: string } {
  return ACTION_THEME[a] ?? ACTION_THEME.IDLE;
}
