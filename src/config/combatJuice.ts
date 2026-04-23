/**
 * Combat “juice”: PERFECT コンボ、撃破カタルシス、オーバーヒート演出の
 * 数値と純粋なダメ補正ヘルパ。`MainScene` は座標 / Phaser には触れない。
 */

export const COMBO = {
  /** 1 連あたりの ATK / SPECIAL 倍率上乗せ（+10% / stack） */
  DMG_PER_STACK: 0.1,
} as const;

export const WAVE_CATHARSIS = {
  /** 撃破直後: 全 `time` / `tween` 停止 (ms) — 実時間 `setTimeout` と併用。 */
  FREEZE_MS: 800,
  /** 大絶賛テキストを見せる時間 (ms) の目安; その後 `onComplete` */
  PRIZE_HOLD_MS: 2200,
  /** 1 PERFECT あたりのスコア加算 (撃破画面の +XXX) */
  BONUS_PER_PERFECT: 100,
} as const;

export const OVERHEAT_SFX = {
  /** 同一ターン最初の「強制沈黙」歩。 */
  FIRST_STEP_VOLUME: 0.9,
  /** 同ターン 2 歩目以降の上書きブザー。 */
  SUBSEQUENT_STEP_VOLUME: 0.42,
} as const;

export function comboDamageMultiplier(
  comboCount: number,
  dmgPerStack: number = COMBO.DMG_PER_STACK,
): number {
  return 1 + Math.max(0, comboCount) * dmgPerStack;
}

/**
 * 基礎ダメ (天候補正後 or SPECIAL 表の生値) にコンボ倍率を掛け、
 * 整数切り下げ。最低 `minDmg`。
 */
export function flooredWithCombo(
  baseDmg: number,
  comboMul: number,
  minDmg: number = 1,
): number {
  return Math.max(minDmg, Math.floor(baseDmg * comboMul));
}
