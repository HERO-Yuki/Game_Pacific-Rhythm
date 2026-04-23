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

// Title BGM scheduling constants
const BGM_BPM = 80;
const BGM_BEAT = 60 / BGM_BPM; // 0.75 s per beat
const BGM_PATTERN = 8;          // beats per loop
const BGM_LOOKAHEAD = 0.2;      // seconds to schedule ahead
const BGM_TICK_MS = 100;        // scheduler setInterval period (ms)

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
  private bgmDroneNodes: OscillatorNode[] = [];

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

  // ------------------------------------------------------------------
  //  Title BGM — public API
  // ------------------------------------------------------------------

  /** Returns true when the AudioContext is live and running. */
  public isContextRunning(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  /**
   * Starts the title-screen ambient BGM — a sparse, tense procedural loop
   * evoking a military operations-room briefing. The loop is scheduled with
   * a look-ahead technique so timing stays tight regardless of setInterval
   * jitter. Safe to call multiple times; repeated calls while active are
   * no-ops.
   */
  public startTitleBgm(): void {
    const ctx = this.ensureContext();
    if (!ctx || !this.masterGain || this.bgmActive) return;
    this.bgmActive = true;

    // Dedicated bus for the BGM layer — lets us fade it in/out independently
    // of SFX without touching the master gain.
    const bgmGain = ctx.createGain();
    bgmGain.gain.setValueAtTime(0, ctx.currentTime);
    bgmGain.gain.linearRampToValueAtTime(1, ctx.currentTime + 2.0);
    bgmGain.connect(this.masterGain);
    this.bgmGain = bgmGain;

    this.bgmStartDrones(ctx, bgmGain);

    this.bgmBeatIndex = 0;
    this.bgmPatternCount = 0;
    this.bgmNextBeatTime = ctx.currentTime + 0.1;
    this.bgmTimer = setInterval(() => this.bgmScheduleAhead(), BGM_TICK_MS);
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
    if (ctx && gain) {
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.55);

      // Stop drone oscillators after the fade completes.
      const drones = this.bgmDroneNodes.splice(0);
      setTimeout(() => {
        drones.forEach((n) => {
          try {
            n.stop();
          } catch (_) {
            /* already stopped */
          }
        });
        try {
          gain.disconnect();
        } catch (_) {
          /* already disconnected */
        }
      }, 700);
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
   * Continuous sub-bass drone: two slightly detuned D1 sines (beating
   * warmth) plus an A1 fifth for low-mid richness. A slow LFO tremolo
   * makes the drone breathe rather than sit static.
   */
  private bgmStartDrones(ctx: AudioContext, sink: GainNode): void {
    for (const freq of [36.71, 36.85]) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;

      const droneGain = ctx.createGain();
      droneGain.gain.value = 0.065;

      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.18;
      const lfoG = ctx.createGain();
      lfoG.gain.value = 0.022;
      lfo.connect(lfoG);
      lfoG.connect(droneGain.gain);

      osc.connect(droneGain).connect(sink);
      osc.start();
      lfo.start();
      this.bgmDroneNodes.push(osc, lfo);
    }

    // A1 perfect fifth (55 Hz) — fills the low-mid register softly.
    const fifth = ctx.createOscillator();
    fifth.type = "sine";
    fifth.frequency.value = 55.0;
    const fifthGain = ctx.createGain();
    fifthGain.gain.value = 0.04;
    fifth.connect(fifthGain).connect(sink);
    fifth.start();
    this.bgmDroneNodes.push(fifth);
  }

  /** Look-ahead scheduler: called every BGM_TICK_MS by setInterval. */
  private bgmScheduleAhead(): void {
    if (!this.bgmActive || !this.ctx || !this.bgmGain) return;
    const until = this.ctx.currentTime + BGM_LOOKAHEAD;
    while (this.bgmNextBeatTime < until) {
      this.bgmScheduleBeat(
        this.ctx,
        this.bgmGain,
        this.bgmBeatIndex,
        this.bgmNextBeatTime,
      );
      this.bgmNextBeatTime += BGM_BEAT;
      this.bgmBeatIndex++;
      if (this.bgmBeatIndex >= BGM_PATTERN) {
        this.bgmBeatIndex = 0;
        this.bgmPatternCount++;
      }
    }
  }

  /**
   * Dispatches all sounds for a single beat position.
   *
   * Pattern at 80 BPM, D minor / Phrygian feel:
   *   Beat 0 — strong kick + D4 melody note
   *   Beat 2 — soft kick + F4
   *   Beat 3 — G4 (ascending colour)
   *   Beat 4 — medium kick
   *   Beat 5 — A4 (fifth, slight tension)
   *   Beat 6 — E♭4 (♭2 Phrygian step — unresolved tension)
   *   Every other pattern, beat 0 — sonar radar ping
   *   Every beat — barely-audible hi-hat tick (military-clock texture)
   */
  private bgmScheduleBeat(
    ctx: AudioContext,
    sink: GainNode,
    beat: number,
    t: number,
  ): void {
    // Bass kick
    if (beat === 0) {
      this.bgmKick(ctx, sink, t, 0.11);
    } else if (beat === 4) {
      this.bgmKick(ctx, sink, t, 0.08);
    } else if (beat === 2) {
      this.bgmKick(ctx, sink, t, 0.042);
    }

    // Sparse melodic stabs (triangle wave, soft)
    // D4=293.7, Eb4=311.1, F4=349.2, G4=392.0, A4=440.0
    type NoteSpec = { f: number; d: number; v: number };
    const MELODY: Readonly<Partial<Record<number, NoteSpec>>> = {
      0: { f: 293.66, d: 0.52, v: 0.09 },
      2: { f: 349.23, d: 0.30, v: 0.07 },
      3: { f: 392.0, d: 0.26, v: 0.06 },
      5: { f: 440.0, d: 0.44, v: 0.08 },
      6: { f: 311.13, d: 0.32, v: 0.065 },
    };
    const note = MELODY[beat];
    if (note) this.bgmNote(ctx, sink, t, note.f, note.d, note.v);

    // Sonar ping — fires on beat 0 of every other pattern iteration.
    if (beat === 0 && this.bgmPatternCount % 2 === 1) {
      this.bgmPing(ctx, sink, t);
    }

    // Military-clock tick on every beat
    this.bgmTick(ctx, sink, t);
  }

  private bgmKick(
    ctx: AudioContext,
    sink: GainNode,
    t: number,
    vol: number,
  ): void {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(86, t);
    osc.frequency.exponentialRampToValueAtTime(36, t + 0.22);

    const env = ctx.createGain();
    env.gain.setValueAtTime(EPSILON, t);
    env.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    env.gain.exponentialRampToValueAtTime(EPSILON, t + 0.34);

    osc.connect(env).connect(sink);
    osc.start(t);
    osc.stop(t + 0.38);
  }

  private bgmNote(
    ctx: AudioContext,
    sink: GainNode,
    t: number,
    freq: number,
    dur: number,
    vol: number,
  ): void {
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = freq;

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2200;
    lp.Q.value = 0.4;

    const env = ctx.createGain();
    env.gain.setValueAtTime(EPSILON, t);
    env.gain.exponentialRampToValueAtTime(vol, t + 0.018);
    env.gain.exponentialRampToValueAtTime(EPSILON, t + dur);

    osc.connect(lp).connect(env).connect(sink);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** Sonar-style descending sine ping, panned slightly left. */
  private bgmPing(ctx: AudioContext, sink: GainNode, t: number): void {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(1760, t);
    osc.frequency.exponentialRampToValueAtTime(1180, t + 1.6);

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

  /** Barely-audible filtered noise transient — military-clock texture. */
  private bgmTick(ctx: AudioContext, sink: GainNode, t: number): void {
    const noise = this.makeNoiseSource(ctx);
    if (!noise) return;

    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 5500;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.016, t);
    env.gain.exponentialRampToValueAtTime(EPSILON, t + 0.028);

    noise.connect(hp).connect(env).connect(sink);
    noise.start(t);
    noise.stop(t + 0.04);
  }
}

// ---------------------------------------------------------------------
//  Module-private helpers
// ---------------------------------------------------------------------

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
