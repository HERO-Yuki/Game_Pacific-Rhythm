/**
 * Player rhythm "juice" timing and low-HP emergency-mode tuning.
 * Keeps magic numbers and pure helpers out of `MainScene`.
 */

export type RhythmInputTiming = "PERFECT" | "GOOD";

export const RHYTHM = {
  /** Half-width of the valid input window (ms) around each beat centre. */
  INPUT_WINDOW_MS: 200,
  /** |now − centre| at or below this count as PERFECT. */
  PERFECT_OFFSET_MS: 100,
} as const;

export const EMERGENCY = {
  /** Player HP at or below this — crisis visuals + half SPECIAL heat. */
  HP_THRESHOLD: 30,
  /** SPECIAL base heat in emergency (base game uses `HEAT_DELTA.special` without this). */
  HEAT_SPECIAL: 40,
  /** WebGL / canvas key for the radial red/black overlay. */
  VIGNETTE_TEXTURE_KEY: "emergency_radial_vignette",
  BANNER_TEXT: "EMERGENCY: COOLING SYSTEM BYPASS ACTIVE",
  /** y = H * BANNER_Y_RATIO */
  BANNER_Y_RATIO: 0.08,
  VIG_PULSE: {
    /** Half-period of the alpha yoyo (ms); full cycle ≈ 1 s. */
    duration: 500,
    alpha: { from: 0.48, to: 0.94 },
  },
  /** Full-screen red multiply flicker. */
  RED_GLITCH: {
    intervalMs: 70,
    alpha: { min: 0.04, max: 0.14 },
  },
} as const;

export const HEAT = {
  /** Immediate relief when a PERFECT timing input is registered. */
  PERFECT_RELIEF: 5,
} as const;

export const PULSE = {
  /** `playBeat` pitch multiplier when emergency mode is active. */
  EMERGENCY_BEAT_PITCH_MUL: 1.14,
  /** Quiet `playOverheat` layered every N thumps while in emergency. */
  EMERGENCY_OVERHEAT_INTERVAL: 3,
  EMERGENCY_OVERHEAT_VOLUME: 0.055,
} as const;

/**
 * After `getInputBeat` has accepted a slot, map centre offset to PERFECT/GOOD.
 */
export function classifyRhythmInputOffset(
  absOffsetFromCentreMs: number,
): RhythmInputTiming {
  return absOffsetFromCentreMs <= RHYTHM.PERFECT_OFFSET_MS
    ? "PERFECT"
    : "GOOD";
}

/**
 * Wall-clock instant of the centre of the player slot beat `pIdx` (0–3).
 * Equivalently: next beat "trigger" in ms since `time.now` reference not used;
 * compare with `scene.time.now` for offset.
 */
export function playerSlotBeatCenterTime(
  rhythmStartTime: number,
  pIdx: number,
  rhythmMs: number,
  seqLen: number,
): number {
  return rhythmStartTime + (pIdx + seqLen) * rhythmMs;
}
