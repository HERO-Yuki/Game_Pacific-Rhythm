/**
 * Title-screen BGM tuning values. Kept out of `AudioManager` so the
 * per-beat scheduler does not allocate objects and the mix is one place to dial.
 */
export const TITLE_BGM_BPM = 92;
export const TITLE_BGM_BEAT_S = 60 / TITLE_BGM_BPM;
export const TITLE_BGM_PATTERN_BEATS = 8;
export const TITLE_BGM_LOOKAHEAD_S = 0.2;
export const TITLE_BGM_TICK_MS = 100;
export const TITLE_BGM_FADE_IN_S = 2.0;
export const TITLE_BGM_FADE_OUT_S = 0.55;
/** Delay before stopping oscillators / noise after the output bus reaches silence */
export const TITLE_BGM_SUSTAIN_STOP_MS = 700;
export const TITLE_BGM_NOISE_LOOP_S = 2.2;
export const TITLE_BGM_SCHEDULE_START_S = 0.1;

export interface TitleBgmMelodyNote {
  readonly f: number;
  readonly d: number;
  readonly v: number;
}

export const TITLE_BGM_KICK: Readonly<Partial<Record<number, number>>> = {
  0: 0.13,
  2: 0.05,
  4: 0.092,
};

export const TITLE_BGM_MELODY: Readonly<
  Partial<Record<number, TitleBgmMelodyNote>>
> = {
  0: { f: 293.66, d: 0.48, v: 0.095 },
  2: { f: 349.23, d: 0.28, v: 0.075 },
  3: { f: 196.0, d: 0.3, v: 0.082 },
  5: { f: 440.0, d: 0.42, v: 0.092 },
  6: { f: 311.13, d: 0.34, v: 0.078 },
};

/** E♭ layer with beat-3 G3 (narrow, tense interval) */
export const TITLE_BGM_BEAT3_EB: TitleBgmMelodyNote = {
  f: 155.56,
  d: 0.2,
  v: 0.038,
};

/** Transient static hits — disabled on title; low-HP bed lives on the battle bus. */
export const TITLE_BGM_GRIT: Readonly<Partial<Record<number, number>>> = {};

export const TITLE_BGM_SUB_HZ = [36.2, 36.9, 37.4] as const;
export const TITLE_BGM_FIFTH_HZ = 55.0;

/** In-MainScene procedural BGM: quieter than title; boss waves transpose up. */
export const COMBAT_BGM_BUS_PEAK = 0.5;
export const COMBAT_BGM_FADE_IN_S = 1.0;
export const COMBAT_BGM_FADE_OUT_S = 0.5;
export const COMBAT_BGM_SUSTAIN_STOP_MS = 650;
/** Boss-only: upward transpose for tension (zako / giga stay at 0). */
export const COMBAT_BGM_BOSS_TRANSPOSE_SEMITONES = 3;
/** Re-pitch combat drone layer when `setCombatBgmKaijuRank` changes. */
export const COMBAT_BGM_DRONE_PITCH_RAMP_S = 0.4;
