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
  /** Player HP at or below this — crisis visuals and beat pitch (SPECIAL heat unchanged). */
  HP_THRESHOLD: 30,
  /** WebGL / canvas key for the radial red/black overlay. */
  VIGNETTE_TEXTURE_KEY: "emergency_radial_vignette",
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

/** Procedural static bed in `AudioManager` — mixed in only when player HP is low. */
export const BATTLE_NOISE = {
  /**
   * Full HP / max above this → bed silent. Below → wet increases linearly
   * toward max at 0 HP (same curve as “HPが減ってきたら”).
   */
  HP_FRACTION_START: 0.5,
  /** Max gain into master for the looped noise — kept low; was 0.82, halved for subtler bed. */
  MAX_WET: 0.41,
  /** `GainNode` fade when wet returns to 0 (HP up) or on `stopBattleNoise()`. */
  WET_FADE_OUT_S: 0.2,
  /** Ramping in when the bed becomes audible from HP loss. */
  WET_RAMP_IN_S: 0.12,
  /** `setTimeout` after fade before disconnecting the wet bus. */
  TEARDOWN_MS: 400,
  /** Dark + air static layers in `startNoiseBed` (after filters). */
  BED: {
    DARK_BASE: 0.034,
    DARK_LFO_HZ: 0.15,
    DARK_LFO_DEPTH: 0.011,
    AIR_BASE: 0.012,
    AIR_LFO_HZ: 0.09,
    AIR_LFO_DEPTH: 0.0055,
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
 * Result of `resolvePlayerRhythmInput`: a single, consistent mapping from
 * wall-clock to the *closest* valid player-beat window (pIdx 0–3).
 */
export interface PlayerRhythmWindowHit {
  pIdx: number;
  /** |elapsed − (pIdx + seqLen) * rhythmMs| with elapsed = now − start. */
  absOffsetMs: number;
  /** `rhythmStartTime + (pIdx + seqLen) * rhythmMs` for logging / VFX. */
  beatCenterTime: number;
}

/**
 * Picks the player slot (0..seqLen−1) whose **scheduled** beat centre is
 * closest in time, subject to the input window. This replaces a separate
 * `getInputBeat` (nearest global beat) + `|now - centre(tied pIdx)|` path so
 * edge cases cannot disagree.
 *
 * Among candidates inside the window, the **minimum** |offset| wins; ties go
 * to the **lower** pIdx.
 */
export function resolvePlayerRhythmInput(
  nowMs: number,
  rhythmStartTime: number,
  rhythmMs: number,
  seqLen: number,
  inputWindowMs: number,
): PlayerRhythmWindowHit | null {
  if (rhythmMs < 1) return null;
  const elapsed = nowMs - rhythmStartTime;
  let best: PlayerRhythmWindowHit | null = null;
  for (let pIdx = 0; pIdx < seqLen; pIdx++) {
    const centreElapsed = (pIdx + seqLen) * rhythmMs;
    const abs = Math.abs(elapsed - centreElapsed);
    if (abs > inputWindowMs) continue;
    if (
      !best ||
      abs < best.absOffsetMs ||
      (abs === best.absOffsetMs && pIdx < best.pIdx)
    ) {
      const beatCenterTime = rhythmStartTime + centreElapsed;
      best = { pIdx, absOffsetMs: abs, beatCenterTime };
    }
  }
  return best;
}

/**
 * Maps a centre offset to PERFECT/GOOD (use `resolvePlayerRhythmInput`
 * `absOffsetMs` for both window membership and this classification).
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
 */
export function playerSlotBeatCenterTime(
  rhythmStartTime: number,
  pIdx: number,
  rhythmMs: number,
  seqLen: number,
): number {
  return rhythmStartTime + (pIdx + seqLen) * rhythmMs;
}
