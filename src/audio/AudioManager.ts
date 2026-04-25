/* ===================================================================
 *  AudioManager — Pacific Rhythm
 *
 *  Procedural synthesizer built on top of the Web Audio API. Every
 *  sound effect is generated from oscillators and noise buffers at
 *  runtime, so the game ships without any audio assets and fits the
 *  "Machines!" theme with heavy, metallic textures.
 *
 *  Stereo panning is used where it strengthens the battle feel: the
 *  kaiju attacks from the left (pan -0.5) and the player's mech
 *  responds from the right (pan +0.5). Browser autoplay policies
 *  require a user gesture to start audio, so the first pointer event
 *  in MainScene calls unlock() to resume the underlying AudioContext.
 *
 *  A future pass may load real samples; preload() is intentionally
 *  left as a stub so the integration points in MainScene do not have
 *  to change when that happens.
 * =================================================================== */

import {
  TITLE_BGM_BEAT_S,
  TITLE_BGM_BEAT3_EB,
  TITLE_BGM_FADE_IN_S,
  TITLE_BGM_FADE_OUT_S,
  TITLE_BGM_FIFTH_HZ,
  TITLE_BGM_GRIT,
  TITLE_BGM_KICK,
  TITLE_BGM_LOOKAHEAD_S,
  TITLE_BGM_MELODY,
  TITLE_BGM_NOISE_LOOP_S,
  TITLE_BGM_PATTERN_BEATS,
  TITLE_BGM_SCHEDULE_START_S,
  TITLE_BGM_SUB_HZ,
  TITLE_BGM_SUSTAIN_STOP_MS,
  TITLE_BGM_TICK_MS,
  COMBAT_BGM_BOSS_TRANSPOSE_SEMITONES,
  COMBAT_BGM_BUS_PEAK,
  COMBAT_BGM_DRONE_PITCH_RAMP_S,
  COMBAT_BGM_FADE_IN_S,
  COMBAT_BGM_FADE_OUT_S,
  COMBAT_BGM_SUSTAIN_STOP_MS,
} from "./titleBgmConfig";
import type { KaijuRank } from "../config/enemies";
import { BATTLE_NOISE } from "../config/rhythmAndEmergency";

export interface PlayOptions {
  /** Stereo pan from -1 (left) to +1 (right). Omit for centred. */
  pan?: number;
  /** Per-call volume multiplier (0..1). Defaults to 1. */
  volume?: number;
  /**
   * `playBeat()` only: multiplies the thump’s start / end pitch for a
   * brighter metronome (e.g. emergency mode tension).
   */
  pitchMul?: number;
}

type WebkitWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

/**
 * exponentialRampToValueAtTime cannot target zero, so every envelope
 * ramps to this tiny positive value as a practical floor.
 */
const EPSILON = 0.0001;

export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private masterVolume = 0.32;
  private enabled = true;

  // ----- Title BGM state -----
  private bgmGain: GainNode | null = null;
  private bgmActive = false;
  private bgmBeatIndex = 0;
  private bgmPatternCount = 0;
  private bgmNextBeatTime = 0;
  private bgmTimer: ReturnType<typeof setInterval> | null = null;
  /** Sustains: drones, noise bed, modulators (anything we must stop on fade-out). */
  private bgmSustainNodes: (OscillatorNode | AudioBufferSourceNode)[] = [];
  /** Longer looped white-noise buffer (shared by battle static bed). */
  private loopNoiseBuffer: AudioBuffer | null = null;

  /** Looped static + LFOs for low-HP tension (independent of title BGM). */
  private battleNoiseWet: GainNode | null = null;
  private battleNoiseSustain: (OscillatorNode | AudioBufferSourceNode)[] = [];

  // ----- In-combat procedural BGM (same engine as title; rank-based transpose) -----
  private combatBgmActive = false;
  private combatBgmGain: GainNode | null = null;
  private combatBgmTimer: ReturnType<typeof setInterval> | null = null;
  private combatBgmBeatIndex = 0;
  private combatBgmPatternCount = 0;
  private combatBgmNextBeatTime = 0;
  private combatBgmSustain: (OscillatorNode | AudioBufferSourceNode)[] = [];
  /** 2^(semitones/12) for scheduled kicks/melody/ping. */
  private combatBgmPitchMul = 1;
  /**
   * Carrier only (sub sines + fifth) — for ramping the drone layer when
   * `KaijuRank` switches to / from boss.
   */
  private combatBgmDroneCarriers: { osc: OscillatorNode; baseHz: number }[] = [];

  // ------------------------------------------------------------------
  //  Public API
  // ------------------------------------------------------------------

  /**
   * Resume or create the underlying AudioContext. Must be called from a
   * user gesture (click/tap/key) to satisfy browser autoplay rules.
   */
  public unlock(): void {
    const ctx = this.ensureContext();
    if (ctx && ctx.state === "suspended") {
      void ctx.resume().catch(() => {
        /* autoplay still blocked — next gesture will try again */
      });
    }
  }

  public setEnabled(on: boolean): void {
    this.enabled = on;
  }

  public setMasterVolume(v: number): void {
    this.masterVolume = clamp01(v);
    if (this.masterGain) {
      this.masterGain.gain.value = this.masterVolume;
    }
  }

  /**
   * Reserved for a future audio-file pipeline. Once real samples are
   * available, decode and cache them here so playX() can fall back to
   * buffered playback. Intentionally inert for now.
   */
  public async preload(_url: string): Promise<void> {
    // const ctx = this.ensureContext();
    // if (!ctx) return;
    // const res = await fetch(_url);
    // const raw = await res.arrayBuffer();
    // const buffer = await ctx.decodeAudioData(raw);
    // this.sampleCache.set(_url, buffer);
    return Promise.resolve();
  }

  // ---------- Procedural SFX ----------

  /** Slow heartbeat thump for the rhythm pulse. */
  public playBeat(opts: PlayOptions = {}): void {
    const s = this.beginSfx(opts);
    if (!s) return;
    const { ctx, sink, now } = s;
    const m = Math.max(0.7, Math.min(1.45, opts.pitchMul ?? 1));

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(95 * m, now);
    osc.frequency.exponentialRampToValueAtTime(42 * m, now + 0.16);

    const env = ctx.createGain();
    scheduleAR(env.gain, now, 0.75, 0.006, 0.274);

    osc.connect(env).connect(sink);
    osc.start(now);
    osc.stop(now + 0.32);
  }

  /** Short metallic switch click for UI button presses. */
  public playClick(opts: PlayOptions = {}): void {
    const s = this.beginSfx({ ...opts, volume: opts.volume ?? 0.55 });
    if (!s) return;
    const { ctx, sink, now } = s;

    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(1800, now);
    osc.frequency.exponentialRampToValueAtTime(900, now + 0.03);

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 500;

    // Linear attack keeps the transient crispy for a short click.
    const env = ctx.createGain();
    env.gain.setValueAtTime(EPSILON, now);
    env.gain.linearRampToValueAtTime(0.28, now + 0.002);
    env.gain.exponentialRampToValueAtTime(EPSILON, now + 0.05);

    osc.connect(hp).connect(env).connect(sink);
    osc.start(now);
    osc.stop(now + 0.07);
  }

  /** Heavy piston impact layered with a short noise click. */
  public playAttack(opts: PlayOptions = {}): void {
    const s = this.beginSfx(opts);
    if (!s) return;
    const { ctx, sink, now } = s;

    // Low thump — pitch drop for weighty impact.
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(160, now);
    osc.frequency.exponentialRampToValueAtTime(48, now + 0.1);

    const oscEnv = ctx.createGain();
    scheduleAR(oscEnv.gain, now, 0.85, 0.005, 0.245);

    osc.connect(oscEnv).connect(sink);
    osc.start(now);
    osc.stop(now + 0.28);

    // Transient clack so the hit reads even on tiny speakers.
    const noise = this.makeNoiseSource(ctx);
    if (noise) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1400;

      // No attack phase here — we want an instant click decaying fast.
      const nEnv = ctx.createGain();
      nEnv.gain.setValueAtTime(0.55, now);
      nEnv.gain.exponentialRampToValueAtTime(EPSILON, now + 0.08);

      noise.connect(lp).connect(nEnv).connect(sink);
      noise.start(now);
      noise.stop(now + 0.1);
    }
  }

  /** Bright, slightly inharmonic metallic ping for a GUARD deflect. */
  public playGuard(opts: PlayOptions = {}): void {
    const s = this.beginSfx(opts);
    if (!s) return;
    const { ctx, sink, now } = s;

    // Two detuned partials at a non-integer ratio feel metallic.
    const partials: ReadonlyArray<{ f: number; g: number }> = [
      { f: 2100, g: 0.22 },
      { f: 3150, g: 0.18 },
    ];

    for (const { f, g } of partials) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(f, now);
      osc.frequency.exponentialRampToValueAtTime(f * 0.82, now + 0.22);

      const env = ctx.createGain();
      scheduleAR(env.gain, now, g, 0.003, 0.237);

      osc.connect(env).connect(sink);
      osc.start(now);
      osc.stop(now + 0.26);
    }
  }

  /** Steam hiss: noise through a sweeping bandpass. */
  public playCool(opts: PlayOptions = {}): void {
    const s = this.beginSfx(opts);
    if (!s) return;
    const { ctx, sink, now } = s;

    const noise = this.makeNoiseSource(ctx);
    if (!noise) return;

    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.Q.value = 1.6;
    bp.frequency.setValueAtTime(4200, now);
    bp.frequency.exponentialRampToValueAtTime(1300, now + 0.55);

    // Attack → hold → release gives the hiss a sustained body.
    const env = ctx.createGain();
    env.gain.setValueAtTime(EPSILON, now);
    env.gain.exponentialRampToValueAtTime(0.38, now + 0.04);
    env.gain.setValueAtTime(0.38, now + 0.25);
    env.gain.exponentialRampToValueAtTime(EPSILON, now + 0.65);

    noise.connect(bp).connect(env).connect(sink);
    noise.start(now);
    noise.stop(now + 0.7);
  }

  /** Rising sawtooth charge with a high-frequency discharge crackle. */
  public playSpecial(opts: PlayOptions = {}): void {
    const s = this.beginSfx(opts);
    if (!s) return;
    const { ctx, sink, now } = s;

    // Charge: sawtooth sweep opening a lowpass into a bright release.
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(1400, now + 0.35);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(600, now);
    lp.frequency.linearRampToValueAtTime(4000, now + 0.35);

    const env = ctx.createGain();
    scheduleAR(env.gain, now, 0.35, 0.35, 0.35);

    osc.connect(lp).connect(env).connect(sink);
    osc.start(now);
    osc.stop(now + 0.72);

    // Discharge: bright noise burst aligned with the peak.
    const noise = this.makeNoiseSource(ctx);
    if (noise) {
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 2000;

      const nEnv = ctx.createGain();
      scheduleAR(nEnv.gain, now + 0.28, 0.5, 0.07, 0.3);

      noise.connect(hp).connect(nEnv).connect(sink);
      noise.start(now + 0.28);
      noise.stop(now + 0.7);
    }
  }

  /** Dissonant alarm triplet for overheat warnings. */
  public playOverheat(opts: PlayOptions = {}): void {
    const s = this.beginSfx(opts);
    if (!s) return;
    const { ctx, sink, now } = s;

    const BEEP_COUNT = 3;
    const BEEP_LEN = 0.11;
    const GAP = 0.07;
    // Minor-second pair (880, 932) produces a tense, industrial clash.
    const freqs: readonly number[] = [880, 932];

    for (let i = 0; i < BEEP_COUNT; i++) {
      const start = now + i * (BEEP_LEN + GAP);
      for (const f of freqs) {
        const osc = ctx.createOscillator();
        osc.type = "square";
        osc.frequency.value = f;

        // Near-square envelope to keep the alarm character.
        const env = ctx.createGain();
        env.gain.setValueAtTime(EPSILON, start);
        env.gain.exponentialRampToValueAtTime(0.18, start + 0.005);
        env.gain.setValueAtTime(0.18, start + BEEP_LEN - 0.012);
        env.gain.exponentialRampToValueAtTime(EPSILON, start + BEEP_LEN);

        osc.connect(env).connect(sink);
        osc.start(start);
        osc.stop(start + BEEP_LEN + 0.02);
      }
    }
  }

  /** Deep thump + filtered noise crash for HP loss. */
  public playDamage(opts: PlayOptions = {}): void {
    const s = this.beginSfx(opts);
    if (!s) return;
    const { ctx, sink, now } = s;

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(200, now);
    osc.frequency.exponentialRampToValueAtTime(42, now + 0.14);

    const oEnv = ctx.createGain();
    scheduleAR(oEnv.gain, now, 0.8, 0.006, 0.294);

    osc.connect(oEnv).connect(sink);
    osc.start(now);
    osc.stop(now + 0.32);

    const noise = this.makeNoiseSource(ctx);
    if (noise) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(1800, now);
      lp.frequency.exponentialRampToValueAtTime(400, now + 0.3);

      const nEnv = ctx.createGain();
      scheduleAR(nEnv.gain, now, 0.55, 0.008, 0.342);

      noise.connect(lp).connect(nEnv).connect(sink);
      noise.start(now);
      noise.stop(now + 0.4);
    }
  }

  /**
   * EASY / NORMAL game-clear fanfare: ascending C-major arpeggio and a
   * short noise shimmer. Distinct from battle SFX, meant to read as
   * “mission complete”.
   */
  public playGameClear(opts: PlayOptions = {}): void {
    const s = this.beginSfx({
      ...opts,
      volume: (opts.volume ?? 1) * 0.7,
    });
    if (!s) return;
    const { ctx, sink, now } = s;

    // C4 E4 G4 C5 — quick brassy triangles.
    const notes: readonly number[] = [261.63, 329.63, 392.0, 523.25];
    const step = 0.082;
    for (let i = 0; i < notes.length; i++) {
      const f = notes[i];
      const t0 = now + i * step;
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = f;

      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 3000;
      const env = ctx.createGain();
      const peak = 0.2 + i * 0.04;
      scheduleAR(env.gain, t0, peak, 0.01, 0.2 - i * 0.015);

      osc.connect(lp).connect(env).connect(sink);
      osc.start(t0);
      osc.stop(t0 + 0.4);
    }

    // Fifth echo on a slightly delayed sine — “hall” afterglow.
    const tEcho = now + 0.38;
    const echo = ctx.createOscillator();
    echo.type = "sine";
    echo.frequency.value = 392.0;
    const eEnv = ctx.createGain();
    scheduleAR(eEnv.gain, tEcho, 0.1, 0.04, 0.5);
    echo.connect(eEnv).connect(sink);
    echo.start(tEcho);
    echo.stop(tEcho + 0.6);

    const noise = this.makeNoiseSource(ctx);
    if (noise) {
      const t1 = now + 0.36;
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 4800;
      bp.Q.value = 0.85;
      const nEnv = ctx.createGain();
      scheduleAR(nEnv.gain, t1, 0.11, 0.05, 0.22);
      noise.connect(bp).connect(nEnv).connect(sink);
      noise.start(t1);
      noise.stop(t1 + 0.35);
    }
  }

  // ------------------------------------------------------------------
  //  Title BGM — public API
  // ------------------------------------------------------------------

  /** Returns true when the AudioContext is live and running. */
  public isContextRunning(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  /**
   * Drives the battle-only static bed: inaudible at high HP, ramps in as
   * `hp / maxHp` falls below `BATTLE_NOISE.HP_FRACTION_START`.
   */
  public setBattleNoiseFromPlayerHp(hp: number, maxHp: number): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain) return;
    const r = maxHp > 0 ? Math.max(0, hp) / maxHp : 0;
    let w = 0;
    if (r < BATTLE_NOISE.HP_FRACTION_START) {
      w =
        (BATTLE_NOISE.HP_FRACTION_START - r) / BATTLE_NOISE.HP_FRACTION_START;
    }
    if (w < 0.001) {
      if (this.battleNoiseWet) {
        const t0 = ctx.currentTime;
        const g = this.battleNoiseWet;
        g.gain.cancelScheduledValues(t0);
        g.gain.setValueAtTime(g.gain.value, t0);
        g.gain.linearRampToValueAtTime(0, t0 + BATTLE_NOISE.WET_FADE_OUT_S);
      }
      return;
    }
    this.ensureBattleNoiseEngine(ctx);
    if (!this.battleNoiseWet) return;
    const t = ctx.currentTime;
    const target = w * BATTLE_NOISE.MAX_WET;
    const g = this.battleNoiseWet;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(target, t + BATTLE_NOISE.WET_RAMP_IN_S);
  }

  /** Tears down the low-HP bed (call when leaving the combat scene). */
  public stopBattleNoise(): void {
    const ctx = this.ctx;
    const wet = this.battleNoiseWet;
    this.battleNoiseWet = null;
    if (!ctx || !wet) {
      this.teardownBattleNoiseSustain();
      return;
    }
    const now = ctx.currentTime;
    wet.gain.cancelScheduledValues(now);
    wet.gain.setValueAtTime(wet.gain.value, now);
    wet.gain.linearRampToValueAtTime(0, now + BATTLE_NOISE.WET_FADE_OUT_S);
    setTimeout(() => {
      this.teardownBattleNoiseSustain();
      try {
        wet.disconnect();
      } catch {
        /* already disconnected */
      }
    }, BATTLE_NOISE.TEARDOWN_MS);
  }

  private ensureBattleNoiseEngine(ctx: AudioContext): void {
    if (this.battleNoiseWet) return;
    if (!this.masterGain) return;
    const wet = ctx.createGain();
    wet.gain.setValueAtTime(0, ctx.currentTime);
    wet.connect(this.masterGain);
    this.battleNoiseWet = wet;
    this.startNoiseBed(ctx, wet, this.battleNoiseSustain);
  }

  private teardownBattleNoiseSustain(): void {
    for (const n of this.battleNoiseSustain) {
      stopSourceSafe(n);
    }
    this.battleNoiseSustain.length = 0;
  }

  /**
   * Title BGM: drones + patterned kicks/melody (no continuous noise bed; grit
   * is optional via `TITLE_BGM_GRIT`). The loop is scheduled with look-ahead.
   */
  public startTitleBgm(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain || this.bgmActive) return;
    this.bgmActive = true;

    // Dedicated bus for the BGM layer — lets us fade it in/out independently
    // of SFX without touching the master gain.
    const bgmGain = ctx.createGain();
    bgmGain.gain.setValueAtTime(0, ctx.currentTime);
    bgmGain.gain.linearRampToValueAtTime(1, ctx.currentTime + TITLE_BGM_FADE_IN_S);
    bgmGain.connect(this.masterGain);
    this.bgmGain = bgmGain;

    this.bgmStartDrones(ctx, bgmGain, this.bgmSustainNodes, 1, null);

    this.bgmBeatIndex = 0;
    this.bgmPatternCount = 0;
    this.bgmNextBeatTime = ctx.currentTime + TITLE_BGM_SCHEDULE_START_S;
    this.bgmTimer = setInterval(() => this.bgmScheduleAhead(), TITLE_BGM_TICK_MS);
  }

  /**
   * Same loop as the title, lower bus gain — runs for the whole MainScene
   * encounter. Boss waves call {@link setCombatBgmKaijuRank} to transpose up.
   */
  public startCombatBgm(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain || this.combatBgmActive) return;
    this.combatBgmActive = true;
    this.combatBgmPitchMul = 1;
    this.combatBgmDroneCarriers = [];

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(
      COMBAT_BGM_BUS_PEAK,
      ctx.currentTime + COMBAT_BGM_FADE_IN_S,
    );
    g.connect(this.masterGain);
    this.combatBgmGain = g;

    this.combatBgmSustain = [];
    this.bgmStartDrones(ctx, g, this.combatBgmSustain, 1, this.combatBgmDroneCarriers);

    this.combatBgmBeatIndex = 0;
    this.combatBgmPatternCount = 0;
    this.combatBgmNextBeatTime = ctx.currentTime + TITLE_BGM_SCHEDULE_START_S;
    this.combatBgmTimer = setInterval(
      () => this.combatBgmScheduleAhead(),
      TITLE_BGM_TICK_MS,
    );
  }

  /** Fades and stops the in-combat procedural loop. */
  public stopCombatBgm(): void {
    if (!this.combatBgmActive) return;
    this.combatBgmActive = false;

    if (this.combatBgmTimer !== null) {
      clearInterval(this.combatBgmTimer);
      this.combatBgmTimer = null;
    }

    const ctx = this.ctx;
    const gain = this.combatBgmGain;
    const sustains = this.combatBgmSustain.splice(0);
    this.combatBgmDroneCarriers = [];
    if (ctx && gain) {
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + COMBAT_BGM_FADE_OUT_S);
      setTimeout(() => {
        stopSustainsList(sustains);
        try {
          gain.disconnect();
        } catch {
          /* */
        }
      }, COMBAT_BGM_SUSTAIN_STOP_MS);
    } else {
      stopSustainsList(sustains);
    }
    this.combatBgmGain = null;
  }

  /**
   * Only `boss` is transposed (see `COMBAT_BGM_BOSS_TRANSPOSE_SEMITONES`);
   * zako and giga stay at the base key.
   */
  public setCombatBgmKaijuRank(rank: KaijuRank): void {
    if (!this.combatBgmActive) return;
    const semis =
      rank === "boss" ? COMBAT_BGM_BOSS_TRANSPOSE_SEMITONES : 0;
    this.applyCombatBgmSemitoneOffset(semis);
  }

  /** Fades out and stops the title-screen BGM. */
  public stopTitleBgm(): void {
    if (!this.bgmActive) return;
    this.bgmActive = false;

    if (this.bgmTimer !== null) {
      clearInterval(this.bgmTimer);
      this.bgmTimer = null;
    }

    const ctx = this.ctx;
    const gain = this.bgmGain;
    const sustains = this.bgmSustainNodes.splice(0);
    if (ctx && gain) {
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + TITLE_BGM_FADE_OUT_S);
      setTimeout(() => {
        stopSustainsList(sustains);
        try {
          gain.disconnect();
        } catch (_) {
          /* already disconnected */
        }
      }, TITLE_BGM_SUSTAIN_STOP_MS);
    } else {
      stopSustainsList(sustains);
    }

    this.bgmGain = null;
  }

  // ------------------------------------------------------------------
  //  Internals
  // ------------------------------------------------------------------

  /**
   * Shared boilerplate for every playX(): ensure the context exists,
   * build a per-call sink, and grab the current scheduling time.
   * Returns null when audio is unavailable so synth methods can early
   * out without extra nesting.
   */
  private beginSfx(
    opts: PlayOptions,
  ): { ctx: AudioContext; sink: GainNode; now: number } | null {
    const ctx = this.ensureContext();
    if (!ctx) return null;
    const sink = this.makeSink(ctx, opts);
    if (!sink) return null;
    return { ctx, sink, now: ctx.currentTime };
  }

  private ensureContext(): AudioContext | null {
    if (!this.enabled) return null;
    if (typeof window === "undefined") return null;
    if (this.ctx) return this.ctx;

    try {
      const Ctor =
        window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
      if (!Ctor) return null;

      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = this.masterVolume;
      master.connect(ctx.destination);

      this.ctx = ctx;
      this.masterGain = master;
      this.noiseBuffer = this.createNoiseBuffer(ctx, 1.0);
      return ctx;
    } catch (err) {
      console.warn("[Audio] Failed to create AudioContext", err);
      this.enabled = false;
      return null;
    }
  }

  /**
   * Per-call output chain: Gain → (StereoPanner?) → masterGain.
   * Returns the Gain node that synths should feed into.
   */
  private makeSink(ctx: AudioContext, opts: PlayOptions): GainNode | null {
    const master = this.masterGain;
    if (!master) return null;

    const out = ctx.createGain();
    out.gain.value = clamp01(opts.volume ?? 1);

    let tail: AudioNode = out;
    if (opts.pan !== undefined && typeof ctx.createStereoPanner === "function") {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, opts.pan));
      out.connect(pan);
      tail = pan;
    }
    tail.connect(master);
    return out;
  }

  private makeNoiseSource(ctx: AudioContext): AudioBufferSourceNode | null {
    if (!this.noiseBuffer) return null;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    return src;
  }

  /** Generates a reusable mono white-noise buffer. */
  private createNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }

  // ------------------------------------------------------------------
  //  Title BGM — internals
  // ------------------------------------------------------------------

  /**
   * Sine LFO → `AudioParam` of `gainNode.gain` (tremolo / surf on static layers).
   */
  private bgmLfoTremoloOnGain(
    ctx: AudioContext,
    gainNode: GainNode,
    baseGain: number,
    lfoHz: number,
    depth: number,
    sustainList: (OscillatorNode | AudioBufferSourceNode)[],
  ): void {
    const t = ctx.currentTime;
    gainNode.gain.setValueAtTime(baseGain, t);
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = lfoHz;
    const d = ctx.createGain();
    d.gain.value = depth;
    lfo.connect(d);
    d.connect(gainNode.gain);
    lfo.start();
    sustainList.push(lfo);
  }

  private applyCombatBgmSemitoneOffset(semitoneOffset: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const mul = Math.pow(2, semitoneOffset / 12);
    this.combatBgmPitchMul = mul;
    const t0 = ctx.currentTime;
    for (const d of this.combatBgmDroneCarriers) {
      const f = Math.max(12, d.baseHz * mul);
      const p = d.osc.frequency;
      p.cancelScheduledValues(t0);
      p.setValueAtTime(p.value, t0);
      p.linearRampToValueAtTime(f, t0 + COMBAT_BGM_DRONE_PITCH_RAMP_S);
    }
  }

  /**
   * Continuous sub-bass: three detuned sines + fifth. `outCarriers` receives
   * the four main oscillators so combat can re-pitch the drone layer for boss
   * transpose; title passes `null`.
   */
  private bgmStartDrones(
    ctx: AudioContext,
    sink: GainNode,
    sustainList: (OscillatorNode | AudioBufferSourceNode)[],
    pitchMul: number,
    outCarriers: { osc: OscillatorNode; baseHz: number }[] | null,
  ): void {
    for (const base of TITLE_BGM_SUB_HZ) {
      const hz = base * pitchMul;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = hz;

      const droneGain = ctx.createGain();
      droneGain.gain.value = 0.058;

      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.22;
      const lfoG = ctx.createGain();
      lfoG.gain.value = 0.028;
      lfo.connect(lfoG);
      lfoG.connect(droneGain.gain);

      osc.connect(droneGain).connect(sink);
      osc.start();
      lfo.start();
      sustainList.push(osc, lfo);
      if (outCarriers) {
        outCarriers.push({ osc, baseHz: base });
      }
    }

    const baseFifth = TITLE_BGM_FIFTH_HZ;
    const fifth = ctx.createOscillator();
    fifth.type = "sine";
    fifth.frequency.value = baseFifth * pitchMul;
    const fifthGain = ctx.createGain();
    fifthGain.gain.value = 0.044;
    fifth.connect(fifthGain).connect(sink);
    fifth.start();
    sustainList.push(fifth);
    if (outCarriers) {
      outCarriers.push({ osc: fifth, baseHz: baseFifth });
    }
  }

  /**
   * Layered static: dark rumble + mid "radio" hiss (battle low-HP bed only).
   */
  private startNoiseBed(
    ctx: AudioContext,
    sink: GainNode,
    sustainList: (OscillatorNode | AudioBufferSourceNode)[],
  ): void {
    if (!this.noiseBuffer) return;

    if (!this.loopNoiseBuffer) {
      this.loopNoiseBuffer = this.createNoiseBuffer(ctx, TITLE_BGM_NOISE_LOOP_S);
    }
    const bedBuf = this.loopNoiseBuffer;

    const n = ctx.createBufferSource();
    n.buffer = bedBuf;
    n.loop = true;

    const hpD = ctx.createBiquadFilter();
    hpD.type = "highpass";
    hpD.frequency.value = 95;
    const lpD = ctx.createBiquadFilter();
    lpD.type = "lowpass";
    lpD.frequency.value = 480;

    const bed = BATTLE_NOISE.BED;
    const gDark = ctx.createGain();
    this.bgmLfoTremoloOnGain(
      ctx,
      gDark,
      bed.DARK_BASE,
      bed.DARK_LFO_HZ,
      bed.DARK_LFO_DEPTH,
      sustainList,
    );

    const hpA = ctx.createBiquadFilter();
    hpA.type = "highpass";
    hpA.frequency.value = 2000;
    const bpA = ctx.createBiquadFilter();
    bpA.type = "bandpass";
    bpA.frequency.value = 4200;
    bpA.Q.value = 0.45;
    const gAir = ctx.createGain();
    this.bgmLfoTremoloOnGain(
      ctx,
      gAir,
      bed.AIR_BASE,
      bed.AIR_LFO_HZ,
      bed.AIR_LFO_DEPTH,
      sustainList,
    );

    n.connect(hpD).connect(lpD).connect(gDark).connect(sink);
    n.connect(hpA).connect(bpA).connect(gAir).connect(sink);

    n.start();
    sustainList.push(n);
  }

  /** Look-ahead scheduler: called on each `TITLE_BGM_TICK_MS` tick. */
  private bgmScheduleAhead(): void {
    if (!this.bgmActive || !this.ctx || !this.bgmGain) return;
    const until = this.ctx.currentTime + TITLE_BGM_LOOKAHEAD_S;
    while (this.bgmNextBeatTime < until) {
      this.bgmScheduleBeat(
        this.ctx,
        this.bgmGain,
        this.bgmBeatIndex,
        this.bgmNextBeatTime,
        this.bgmPatternCount,
        1,
      );
      this.bgmNextBeatTime += TITLE_BGM_BEAT_S;
      this.bgmBeatIndex++;
      if (this.bgmBeatIndex >= TITLE_BGM_PATTERN_BEATS) {
        this.bgmBeatIndex = 0;
        this.bgmPatternCount++;
      }
    }
  }

  private combatBgmScheduleAhead(): void {
    if (!this.combatBgmActive || !this.ctx || !this.combatBgmGain) return;
    const until = this.ctx.currentTime + TITLE_BGM_LOOKAHEAD_S;
    while (this.combatBgmNextBeatTime < until) {
      this.bgmScheduleBeat(
        this.ctx,
        this.combatBgmGain,
        this.combatBgmBeatIndex,
        this.combatBgmNextBeatTime,
        this.combatBgmPatternCount,
        this.combatBgmPitchMul,
      );
      this.combatBgmNextBeatTime += TITLE_BGM_BEAT_S;
      this.combatBgmBeatIndex++;
      if (this.combatBgmBeatIndex >= TITLE_BGM_PATTERN_BEATS) {
        this.combatBgmBeatIndex = 0;
        this.combatBgmPatternCount++;
      }
    }
  }

  /**
   * Dispatches all sounds for a single beat position.
   * ~92 BPM; optional `TITLE_BGM_GRIT` (unused by default). Low-HP static is on the battle bus.
   */
  private bgmScheduleBeat(
    ctx: AudioContext,
    sink: GainNode,
    beat: number,
    t: number,
    patternCount: number,
    pitchMul: number,
  ): void {
    const kick = TITLE_BGM_KICK[beat];
    if (kick !== undefined) {
      this.bgmKick(ctx, sink, t, kick, pitchMul);
    }

    const note = TITLE_BGM_MELODY[beat];
    if (note) {
      this.bgmNote(
        ctx,
        sink,
        t,
        note.f * pitchMul,
        note.d,
        note.v,
        pitchMul,
      );
    }
    if (beat === 3) {
      const e = TITLE_BGM_BEAT3_EB;
      this.bgmNote(ctx, sink, t, e.f * pitchMul, e.d, e.v, pitchMul);
    }

    if (beat === 0 && patternCount % 2 === 1) {
      this.bgmPing(ctx, sink, t, pitchMul);
    }

    const grit = TITLE_BGM_GRIT[beat];
    if (grit !== undefined) {
      this.bgmGrit(ctx, sink, t, grit);
    }

    this.bgmTick(ctx, sink, t);
  }

  private bgmKick(
    ctx: AudioContext,
    sink: GainNode,
    t: number,
    vol: number,
    pitchMul: number,
  ): void {
    const m = Math.max(0.5, pitchMul);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(92 * m, t);
    osc.frequency.exponentialRampToValueAtTime(34 * m, t + 0.2);

    const env = ctx.createGain();
    env.gain.setValueAtTime(EPSILON, t);
    env.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    env.gain.exponentialRampToValueAtTime(EPSILON, t + 0.3);

    osc.connect(env).connect(sink);
    osc.start(t);
    osc.stop(t + 0.36);
  }

  private bgmNote(
    ctx: AudioContext,
    sink: GainNode,
    t: number,
    freq: number,
    dur: number,
    vol: number,
    pitchMul: number,
  ): void {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = Math.min(7200, 1500 * Math.max(1, pitchMul));
    lp.Q.value = 0.55;

    const env = ctx.createGain();
    env.gain.setValueAtTime(EPSILON, t);
    env.gain.exponentialRampToValueAtTime(vol, t + 0.018);
    env.gain.exponentialRampToValueAtTime(EPSILON, t + dur);

    osc.connect(lp).connect(env).connect(sink);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** Sonar-style descending sine ping, panned slightly left. */
  private bgmPing(
    ctx: AudioContext,
    sink: GainNode,
    t: number,
    pitchMul: number,
  ): void {
    const m = Math.max(0.5, pitchMul);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1760 * m, t);
    osc.frequency.exponentialRampToValueAtTime(1180 * m, t + 1.6);

    const env = ctx.createGain();
    env.gain.setValueAtTime(EPSILON, t);
    env.gain.exponentialRampToValueAtTime(0.052, t + 0.012);
    env.gain.exponentialRampToValueAtTime(EPSILON, t + 1.8);

    if (typeof ctx.createStereoPanner === "function") {
      const pan = ctx.createStereoPanner();
      pan.pan.value = -0.4;
      osc.connect(env).connect(pan).connect(sink);
    } else {
      osc.connect(env).connect(sink);
    }

    osc.start(t);
    osc.stop(t + 1.85);
  }

  /** Ticking hat — a touch more sizzle for cockpit tension. */
  private bgmTick(ctx: AudioContext, sink: GainNode, t: number): void {
    const noise = this.makeNoiseSource(ctx);
    if (!noise) return;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 4800;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.022, t);
    env.gain.exponentialRampToValueAtTime(EPSILON, t + 0.032);

    noise.connect(hp).connect(env).connect(sink);
    noise.start(t);
    noise.stop(t + 0.045);
  }

  /** Short mid-band static burst (machinery / RF stress). */
  private bgmGrit(
    ctx: AudioContext,
    sink: GainNode,
    t: number,
    peak: number,
  ): void {
    const noise = this.makeNoiseSource(ctx);
    if (!noise) return;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1800;
    bp.Q.value = 0.55;
    const env = ctx.createGain();
    env.gain.setValueAtTime(EPSILON, t);
    env.gain.exponentialRampToValueAtTime(peak, t + 0.004);
    env.gain.exponentialRampToValueAtTime(EPSILON, t + 0.055);
    noise.connect(bp).connect(env).connect(sink);
    noise.start(t);
    noise.stop(t + 0.08);
  }
}

// ---------------------------------------------------------------------
//  Module-private helpers
// ---------------------------------------------------------------------

function stopSourceSafe(node: AudioScheduledSourceNode): void {
  try {
    node.stop();
  } catch {
    /* already stopped */
  }
}

function stopSustainsList(
  nodes: (OscillatorNode | AudioBufferSourceNode)[],
): void {
  for (const n of nodes) {
    stopSourceSafe(n);
  }
}

/**
 * Schedules a simple attack–release (AR) envelope.
 * `attack` and `release` are durations in seconds relative to `start`,
 * so the envelope reaches `peak` at `start + attack` and decays to
 * EPSILON at `start + attack + release`.
 */
function scheduleAR(
  param: AudioParam,
  start: number,
  peak: number,
  attack: number,
  release: number,
): void {
  const safePeak = Math.max(peak, EPSILON * 2);
  param.setValueAtTime(EPSILON, start);
  param.exponentialRampToValueAtTime(safePeak, start + attack);
  param.exponentialRampToValueAtTime(EPSILON, start + attack + release);
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/** Shared game-wide instance. Scenes should import this directly. */
export const audio = new AudioManager();
