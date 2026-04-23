import Phaser from "phaser";
import { audio } from "../audio/AudioManager";
import {
  DIFFICULTY_CONFIGS,
  isEndless,
  maxWavesForDifficulty,
  type Difficulty,
} from "../config/difficulty";
import {
  BOSS_EVERY,
  KAIJU_STATS,
  pickKaijuRank,
  type KaijuRank,
} from "../config/enemies";
import {
  adjustAttackDmg,
  adjustCoolDelta,
  adjustHeatGain,
  pickWeather,
  WEATHER_EFFECTS,
  type Weather,
  type WeatherEffect,
} from "../config/weather";
import {
  saveEndlessRecord,
  saveTimedRecord,
  type EndlessRecord,
} from "../utils/records";
import { notifyWavedashLoadComplete } from "../utils/wavedash";

export interface MainSceneInitData {
  difficulty?: Difficulty;
}

/* ===================================================================
 *  Pacific Rhythm — core game scene
 *
 *  BPM-60 rhythm sequencer battle driven by beat-count timing.
 *  Rhythm phase uses update() with elapsed / beatLength instead of
 *  frame-rate-dependent timers, ensuring consistent rhythm across
 *  all hardware. Player input is accepted within a ±200 ms window
 *  centred on each beat.
 *
 *  Flow:
 *    Rhythm     (8 beats @ 60 BPM — kaiju reveal × 4 + player program × 4)
 *    Resolution (8 beats @ 120 BPM — kaiju telegraph + player resolve, × 4 steps)
 *    → loop back to Rhythm (or GAME_OVER)
 *
 *  All visuals use Phaser shapes and text (no image assets).
 * =================================================================== */

// ======================== Enums ========================

export enum ActionType {
  ATTACK = "ATTACK",
  GUARD = "GUARD",
  COOL = "COOL",
  SPECIAL = "SPECIAL",
  IDLE = "IDLE",
}

enum GamePhase {
  RHYTHM_KAIJU,
  RHYTHM_PLAYER,
  RESOLUTION,
  GAME_OVER,
  GAME_CLEAR,
}

// ======================== Constants ========================

const RHYTHM_MS = 1000;
const RESOLVE_MS = 500;
const INPUT_WINDOW_MS = 200;
const SEQ_LEN = 4;
const TOTAL_BEATS = SEQ_LEN * 2;

/**
 * Resolution plays each step across two beats: an even "telegraph"
 * beat where the kaiju shows its intent, then an odd "resolve" beat
 * where the player's response lands. Eight ticks total per turn so
 * the encounter reads as call-and-response.
 *
 * Note: the value of 2 is baked into resolveTick's `tick >> 1` and
 * `tick & 1` math. Changing this number would require reworking the
 * dispatcher — it is not a generic knob.
 */
const RESOLVE_BEATS_PER_STEP = 2;
const RESOLVE_TOTAL_TICKS = SEQ_LEN * RESOLVE_BEATS_PER_STEP;

const HP_INIT = { player: 100 } as const;
const OVERHEAT_THRESHOLD = 100;
const OVERHEAT_STREAK_LIMIT = 3;

/**
 * Heat at or above this value is the "danger zone": the screen shows a
 * pulsing red vignette. Dropping back below triggers a relief flash
 * plus a blue steam burst to reward the clutch cool-down.
 */
const HEAT_DANGER = 80;

/**
 * Hit-stop durations per event kind (milliseconds). Tuned to roughly
 * 150–200 ms — long enough to register an impact without hurting pace.
 */
const HITSTOP_MS = {
  clash: 180,
  special: 180,
  break: 200,
  vulnerable: 160,
} as const;

/**
 * Render depths for overlay layers. Centralised so adding new UI will
 * not silently collide with existing z-order.
 */
const DEPTH = {
  sparks: 40,
  popText: 50,
  rhythmCursor: 10,
  heatVignette: 90,
  gameOver: 100,
} as const;

/**
 * RGB triple for the "escaped the danger zone" camera flash. Phaser's
 * Camera.flash takes 0–255 channel values.
 */
const HEAT_RELIEF_RGB = { r: 136, g: 204, b: 255 } as const;

const DMG = {
  attack: 20,
  clash: 10,
  coolVulnerable: 40,
  special: 40,
  specialVsGuard: 50,
} as const;

const HEAT_DELTA = {
  attack: 10,
  special: 80,
  cool: -40,
} as const;

const PAL = {
  bg: 0x0b0f14,
  slotBg: 0x1a1f2e,
  slotStroke: 0x3d4663,
  highlight: 0xffcc00,
  hpGreen: 0x44cc44,
  heatOrange: 0xff6600,
  heatRed: 0xff0000,
  cursor: 0x00ffcc,
  miss: 0xff4444,
} as const;

/**
 * Per-button palette triples (on / hover / off) keyed by visual
 * theme. `default` drives ATTACK/GUARD/COOL; `special` paints the
 * SPECIAL button a dark red so the most dangerous action is also
 * visually tagged before the player even reads the label.
 */
const BTN_PAL = {
  default: {
    on: 0x2a2f3e,
    hover: 0x3a4f6e,
    off: 0x181c24,
  },
  special: {
    on: 0x6b1818,
    hover: 0x8c2525,
    off: 0x3c0d0d,
  },
} as const;

type BtnPalette = (typeof BTN_PAL)[keyof typeof BTN_PAL];

const ACT_COL: Record<ActionType, number> = {
  [ActionType.ATTACK]: 0xff4444,
  [ActionType.GUARD]: 0x4488ff,
  [ActionType.COOL]: 0x44cccc,
  [ActionType.SPECIAL]: 0xcc44ff,
  [ActionType.IDLE]: 0x666666,
};

/** Neutral grey used to paint a masked kaiju slot of any origin. */
const PAL_SAND_MASK = 0x7a7a86;

/**
 * Text + font size for a masked kaiju reveal slot. `[ ??? ]` is the
 * display brief from the design spec; we drop the label font down
 * so the 7-character string fits comfortably inside the 56 px slot
 * even at the narrowest responsive width.
 */
const KAIJU_NOISE_TEXT = "[ ??? ]";
const KAIJU_NOISE_FONT_PX = 11;
const KAIJU_SLOT_FONT_PX = 13;

/**
 * From this wave onward, every kaiju reveal slot rolls an extra
 * independent chance to be obscured as "[ ??? ]". This layers on
 * top of the sand-weather guaranteed mask — the idea is that once
 * the player knows the core loop, the game starts asking them to
 * trade "safe GUARD" for "risky read" on a per-slot basis.
 */
const KAIJU_BASELINE_NOISE_WAVE = 3;
const KAIJU_BASELINE_NOISE_CHANCE = 0.2;

const ACT_SHORT: Record<ActionType, string> = {
  [ActionType.ATTACK]: "ATK",
  [ActionType.GUARD]: "GRD",
  [ActionType.COOL]: "COL",
  [ActionType.SPECIAL]: "SPL",
  [ActionType.IDLE]: "IDL",
};

/**
 * Keyboard shortcut hint rendered inside each action button.
 * WASD for left-hand players, arrow keys for right-hand players —
 * the game binds both sets to the same actions so either is fine.
 */
const ACT_KEY_HINT: Record<ActionType, string> = {
  [ActionType.ATTACK]: "A / \u2190",
  [ActionType.GUARD]: "S / \u2193",
  [ActionType.COOL]: "D / \u2192",
  [ActionType.SPECIAL]: "W / \u2191",
  [ActionType.IDLE]: "",
};

/**
 * Emoji glyph stamped in front of every action label for language-
 * independent recognition. Picked to read cleanly on both the
 * modern system-ui emoji set and Noto Emoji fallbacks.
 */
const ACT_EMOJI: Record<ActionType, string> = {
  [ActionType.ATTACK]: "\u2694\uFE0F", // crossed swords
  [ActionType.GUARD]: "\uD83D\uDEE1\uFE0F", // shield
  [ActionType.COOL]: "\u2744\uFE0F", // snowflake
  [ActionType.SPECIAL]: "\u26A0\uFE0F", // warning sign
  [ActionType.IDLE]: "",
};

/**
 * Per-action button footprint at design resolution (960x540).
 * Encodes a risk-reward hierarchy in pure pixels:
 *
 *  - ATTACK gets the biggest slab so the bread-and-butter move is
 *    the easiest to mash during a pressured rhythm window.
 *  - GUARD and COOL sit at a middle size — important but used
 *    reactively, not hammered.
 *  - SPECIAL is the smallest target on purpose; paired with its
 *    dark-red colour it becomes almost impossible to mis-tap.
 */
const ACT_BTN_WIDTH: Record<ActionType, number> = {
  [ActionType.ATTACK]: 200,
  [ActionType.GUARD]: 150,
  [ActionType.COOL]: 150,
  [ActionType.SPECIAL]: 100,
  [ActionType.IDLE]: 0,
};

/**
 * Keyboard bindings for the four player actions. Strings here are
 * `Phaser.Input.Keyboard.KeyCodes` names, so each action accepts a
 * WASD key *or* its corresponding arrow key.
 */
const ACTION_KEY_BINDINGS: ReadonlyArray<{
  readonly keys: readonly string[];
  readonly action: ActionType;
}> = [
  { keys: ["A", "LEFT"], action: ActionType.ATTACK },
  { keys: ["S", "DOWN"], action: ActionType.GUARD },
  { keys: ["D", "RIGHT"], action: ActionType.COOL },
  { keys: ["W", "UP"], action: ActionType.SPECIAL },
];

const KAIJU_POOL: ActionType[] = [
  ActionType.ATTACK,
  ActionType.GUARD,
  ActionType.IDLE,
];

/** Stereo pan for sound effects: kaiju on the left, player on the right. */
const PAN_KAIJU = -0.5;
const PAN_PLAYER = 0.5;

const FONT = "system-ui, 'Segoe UI', sans-serif";

/** Named VFX colour palette — avoids magic numbers in executeCombat. */
const VFX = {
  spark: {
    hit: [0xffcc00, 0xff6600] as number[],
    block: [0x88aaff, 0xffffff] as number[],
    crit: [0xff4444, 0xff0000] as number[],
    special: [0xff44ff, 0xffcc00] as number[],
  },
  flash: {
    kaijuHit: 0xff6666,
    kaijuBlock: 0xffffff,
    kaijuSpecial: 0xff44ff,
    playerHit: 0xff0000,
    playerGuard: 0x66aaff,
    playerCool: 0x44cccc,
  },
  pop: {
    damage: "#ff4444",
    special: "#ff44ff",
    cool: "#44ccff",
  },
};

// ======================== UI types ========================

interface SlotUI {
  bg: Phaser.GameObjects.Rectangle;
  border: Phaser.GameObjects.Rectangle;
  label: Phaser.GameObjects.Text;
}

interface BtnUI {
  container: Phaser.GameObjects.Container;
  bg: Phaser.GameObjects.Rectangle;
  action: ActionType;
}

// ================================================================
//  MainScene
// ================================================================

export class MainScene extends Phaser.Scene {
  /* ---------- game state ---------- */
  private playerHP = HP_INIT.player;
  private playerHeat = 0;
  private kaijuHP = KAIJU_STATS.zako.hp;
  /** Max HP for the current kaiju — drives the HP bar fill ratio. */
  private currentKaijuMaxHP = KAIJU_STATS.zako.hp;
  /** 1-based wave index. Increments at the start of every beginWave(). */
  private wave = 0;
  /**
   * Difficulty chosen on the title screen. Drives:
   *   - whether weather rolls or stays clear (EASY skips it)
   *   - the wave cap that flips the game into GAME CLEAR
   *   - which persistence helper runs on end-of-run
   * Defaults to NORMAL so a direct `scene.start("MainScene")` boot
   * (e.g. from dev tools) still gets the intended experience.
   */
  private difficulty: Difficulty = "normal";
  /** Maximum wave for the current difficulty, or Infinity for endless. */
  private maxWave = Infinity;
  /** Wall-clock ms captured at beginWave(1) — used for clear-time records. */
  private runStartTime = 0;
  /** Cleared-boss counter (ENDLESS best-score bookkeeping). */
  private bossesDefeated = 0;
  /** Cleared-giga counter (ENDLESS best-score bookkeeping). */
  private gigasDefeated = 0;
  /**
   * 0-based weather-phase index (every `BOSS_EVERY` waves is one
   * phase). -1 forces a re-roll on the very first wave so
   * `refreshWeatherHUD()` always runs at least once before combat.
   */
  private currentPhaseIndex = -1;
  /** Active weather for the current phase — drives combat multipliers. */
  private currentWeather: Weather = "clear";
  /**
   * Per-slot mask flags for the current wave (length SEQ_LEN). A slot
   * is masked if either (a) sand weather chose it as its guaranteed
   * mask, or (b) once the encounter counter is past
   * `KAIJU_BASELINE_NOISE_WAVE` it independently rolled below the
   * per-slot noise chance. Stable across the Reading phase so the
   * player can commit to a plan; re-rolled every wave.
   */
  private kaijuNoiseMask: boolean[] = [];
  private score = 0;
  private ohStreak = 0;
  private phase = GamePhase.RHYTHM_KAIJU;
  private kaijuSeq: ActionType[] = [];
  private playerSeq: ActionType[] = [];

  /* ---------- beat-count rhythm state ---------- */
  private rhythmStartTime = 0;
  private lastProcessedBeat = -1;
  private rhythmEnded = false;
  private buttonsReady = false;

  /**
   * Latches true on the first resolveStep() that actually enforces
   * overheat, so the 3-beep alarm fires once per turn instead of once
   * per affected step.
   */
  private ohAlarmedThisTurn = false;

  /* ---------- hit-stop (freeze-frame) state ---------- */
  private hitStopActive = false;
  /**
   * Handle returned by window.setTimeout. We use an out-of-band timer
   * because the scene's own Time.Clock is paused during hit-stop; we
   * track the handle so we can cancel it on scene shutdown/restart.
   */
  private hitStopResumeHandle: number | null = null;

  /* ---------- heat-danger UI state ---------- */
  private heatDangerActive = false;
  private heatVignette!: Phaser.GameObjects.Rectangle;
  private heatAlertTween?: Phaser.Tweens.Tween;

  /* ---------- UI refs ---------- */
  /**
   * Combatant bodies — both sides are now textured Images backed by
   * Midjourney flat-vector illustrations, so every VFX helper that
   * touches them works in terms of setTint / Transform and never
   * needs to know about fills.
   */
  private kaijuBody!: Phaser.GameObjects.Image;
  private playerBody!: Phaser.GameObjects.Image;
  /** Zako / Boss label under the kaiju body; text & color update per rank. */
  private kaijuLabel!: Phaser.GameObjects.Text;
  private kaijuHPText!: Phaser.GameObjects.Text;
  private playerHPText!: Phaser.GameObjects.Text;
  private playerHeatText!: Phaser.GameObjects.Text;
  private kaijuHPBar!: Phaser.GameObjects.Rectangle;
  private playerHPBar!: Phaser.GameObjects.Rectangle;
  private playerHeatBar!: Phaser.GameObjects.Rectangle;
  private kSlots: SlotUI[] = [];
  private pSlots: SlotUI[] = [];
  private btns: BtnUI[] = [];
  private phaseLabel!: Phaser.GameObjects.Text;
  private scoreLabel!: Phaser.GameObjects.Text;
  /** Top-left weather indicator — big name + small modifier note. */
  private weatherLabel!: Phaser.GameObjects.Text;
  private weatherDetailLabel!: Phaser.GameObjects.Text;
  private msgLabel!: Phaser.GameObjects.Text;
  private goLayer!: Phaser.GameObjects.Container;
  private goScoreText!: Phaser.GameObjects.Text;
  private barMaxW = 0;

  /* rhythm UI */
  private rhythmCursor!: Phaser.GameObjects.Rectangle;
  private timingBar!: Phaser.GameObjects.Rectangle;
  private beatFlash!: Phaser.GameObjects.Rectangle;
  private slotSz = 56;
  /**
   * Baseline edge length (px) for combatant bodies, captured once in
   * buildCharacters and reused every time a rank swap needs to resize
   * the kaiju without querying the layout again.
   */
  private baseBodySize = 0;

  /**
   * Cached once after buildUI. Each entry stores the game object plus
   * the scale at which its sprite should sit "at rest", so `pulseBeat`
   * can bounce uniformly even when sprites use `setDisplaySize`
   * (which pushes the intrinsic scale far below 1).
   */
  private bounceTargets: ReadonlyArray<{
    readonly obj: Phaser.GameObjects.GameObject & {
      scaleX: number;
      scaleY: number;
    };
    baseScale: number;
  }> = [];

  constructor() {
    super("MainScene");
  }

  /* ============================================================ */
  /*  Lifecycle                                                     */
  /* ============================================================ */

  /**
   * Called by Phaser before create() — perfect home for interpreting
   * the data payload from TitleScene. Falls back to NORMAL when the
   * scene is started without explicit data so the game still boots
   * cleanly from `scene.start("MainScene")`.
   */
  init(data: MainSceneInitData | undefined): void {
    const requested = data?.difficulty;
    this.difficulty =
      requested && requested in DIFFICULTY_CONFIGS ? requested : "normal";
    this.maxWave = maxWavesForDifficulty(this.difficulty);
  }

  create(): void {
    this.resetState();
    this.cameras.main.setBackgroundColor(PAL.bg);

    if (!this.textures.exists("spark")) {
      const g = this.add.graphics();
      g.fillStyle(0xffffff);
      g.fillRect(0, 0, 4, 4);
      g.generateTexture("spark", 4, 4);
      g.destroy();
    }

    this.buildUI();
    this.cacheBounceTargets();
    this.refreshHUD();
    this.setupKeyboardInput();

    this.scale.on("resize", this.onResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off("resize", this.onResize, this);
      // If a hit-stop is in flight, its out-of-band timeout would try
      // to poke a destroyed scene; drop the handle to be safe.
      this.cancelHitStop();
    });

    // Browser autoplay policy: the AudioContext can only start after a
    // user gesture, so the first pointer/key event unlocks audio.
    const unlock = (): void => audio.unlock();
    this.input.once("pointerdown", unlock);
    this.input.keyboard?.once("keydown", unlock);

    notifyWavedashLoadComplete();
    this.beginWave();
  }

  update(): void {
    if (this.isRhythmPhase()) {
      this.updateRhythm();
    }
  }

  private resetState(): void {
    this.playerHP = HP_INIT.player;
    this.playerHeat = 0;
    this.kaijuHP = KAIJU_STATS.zako.hp;
    this.currentKaijuMaxHP = KAIJU_STATS.zako.hp;
    this.wave = 0;
    this.currentPhaseIndex = -1;
    this.currentWeather = "clear";
    this.kaijuNoiseMask = [];
    this.score = 0;
    this.bossesDefeated = 0;
    this.gigasDefeated = 0;
    this.runStartTime = 0;
    this.ohStreak = 0;
    this.phase = GamePhase.RHYTHM_KAIJU;
    this.kaijuSeq = [];
    this.playerSeq = [];
    this.rhythmStartTime = 0;
    this.lastProcessedBeat = -1;
    this.rhythmEnded = false;
    this.buttonsReady = false;
    this.ohAlarmedThisTurn = false;
    this.hitStopActive = false;
    this.heatDangerActive = false;
  }

  private isRhythmPhase(): boolean {
    return (
      this.phase === GamePhase.RHYTHM_KAIJU ||
      this.phase === GamePhase.RHYTHM_PLAYER
    );
  }

  /* ============================================================ */
  /*  UI construction                                               */
  /* ============================================================ */

  private buildUI(): void {
    const W = this.scale.width;
    const H = this.scale.height;

    this.phaseLabel = this.txt(W / 2, 16, "", 18, "#8b949e").setOrigin(0.5, 0);
    this.scoreLabel = this.txt(W - 20, 16, "", 15, "#6e7681").setOrigin(1, 0);
    this.refreshProgressHUD();
    // Weather indicator lives on the otherwise empty top-left shelf.
    // Two stacked lines so the modifier summary is legible at a glance
    // without crowding the headline.
    this.weatherLabel = this.txt(20, 14, "", 13, "#8b949e").setOrigin(0, 0);
    this.weatherDetailLabel = this.txt(20, 30, "", 10, "#6e7681").setOrigin(
      0,
      0,
    );
    this.msgLabel = this.txt(W / 2, H * 0.47, "", 16, "#ffcc00")
      .setOrigin(0.5)
      .setAlpha(0);

    this.buildCharacters(W, H);
    this.buildSequencer(W, H);
    this.buildRhythmIndicators(W, H);
    this.buildButtons(W, H);
    this.buildHeatOverlay(W, H);
    this.buildGameOver(W, H);
  }

  /**
   * Full-screen red tint used as a danger vignette when Heat ≥ 70.
   * Sits below the game-over layer (depth 100) so it never occludes
   * the restart prompt. The relief flash uses Phaser's built-in
   * Camera.flash so it does not need its own overlay.
   */
  private buildHeatOverlay(W: number, H: number): void {
    this.heatVignette = this.add
      .rectangle(0, 0, W, H, PAL.heatRed, 0)
      .setOrigin(0)
      .setDepth(DEPTH.heatVignette)
      .setVisible(false);
  }

  private buildCharacters(W: number, H: number): void {
    const cy = H * 0.22;
    const sz = Math.min(80, W * 0.085);
    this.baseBodySize = sz;
    this.barMaxW = sz * 1.6;
    const barH = 7;
    const barGap = 14;

    const kx = W * 0.25;
    // Start as zako; beginWave() re-applies the correct rank on every
    // encounter so texture/scale stay in sync with the wave counter.
    this.kaijuBody = this.add
      .image(kx, cy, KAIJU_STATS.zako.texture)
      .setDisplaySize(sz, sz);
    this.add
      .rectangle(kx, cy - sz / 2 - barGap, this.barMaxW, barH, 0x222222)
      .setOrigin(0.5);
    this.kaijuHPBar = this.add
      .rectangle(
        kx - this.barMaxW / 2,
        cy - sz / 2 - barGap,
        this.barMaxW,
        barH,
        PAL.hpGreen,
      )
      .setOrigin(0, 0.5);
    this.kaijuHPText = this.txt(
      kx,
      cy - sz / 2 - barGap - barH,
      "",
      13,
      "#44cc44",
    ).setOrigin(0.5, 1);
    this.kaijuLabel = this.txt(
      kx,
      cy + sz / 2 + 8,
      KAIJU_STATS.zako.label,
      11,
      KAIJU_STATS.zako.labelColor,
    ).setOrigin(0.5, 0);

    const px = W * 0.75;
    this.playerBody = this.add
      .image(px, cy, "mech-player")
      .setDisplaySize(sz, sz);
    const hpBarY = cy - sz / 2 - barGap * 2;
    this.add
      .rectangle(px, hpBarY, this.barMaxW, barH, 0x222222)
      .setOrigin(0.5);
    this.playerHPBar = this.add
      .rectangle(
        px - this.barMaxW / 2,
        hpBarY,
        this.barMaxW,
        barH,
        PAL.hpGreen,
      )
      .setOrigin(0, 0.5);
    this.playerHPText = this.txt(
      px,
      hpBarY - barH,
      "",
      13,
      "#44cc44",
    ).setOrigin(0.5, 1);

    const heatBarY = cy - sz / 2 - barGap + 2;
    this.add
      .rectangle(px, heatBarY, this.barMaxW, barH, 0x222222)
      .setOrigin(0.5);
    this.playerHeatBar = this.add
      .rectangle(
        px - this.barMaxW / 2,
        heatBarY,
        this.barMaxW,
        barH,
        PAL.heatOrange,
      )
      .setOrigin(0, 0.5);
    this.playerHeatText = this.txt(px, cy + sz / 2 + 8, "", 12, "#ff6600").setOrigin(
      0.5,
      0,
    );
    this.txt(px, cy + sz / 2 + 24, "PLAYER", 11, "#3366cc").setOrigin(0.5, 0);
  }

  private buildSequencer(W: number, H: number): void {
    const y = H * 0.55;
    this.slotSz = Math.min(56, W * 0.058);
    const gap = 10;
    const groupW = SEQ_LEN * this.slotSz + (SEQ_LEN - 1) * gap;
    const mid = W / 2;
    const sep = 24;

    this.txt(
      mid - sep - groupW / 2,
      y - this.slotSz / 2 - 18,
      "KAIJU",
      11,
      "#cc3333",
    ).setOrigin(0.5, 1);
    this.txt(
      mid + sep + groupW / 2,
      y - this.slotSz / 2 - 18,
      "PLAYER",
      11,
      "#3366cc",
    ).setOrigin(0.5, 1);

    this.kSlots = [];
    this.pSlots = [];

    for (let i = 0; i < SEQ_LEN; i++) {
      const ksx =
        mid - sep - groupW + this.slotSz / 2 + i * (this.slotSz + gap);
      const psx = mid + sep + this.slotSz / 2 + i * (this.slotSz + gap);
      this.txt(ksx, y - this.slotSz / 2 - 4, `${i + 1}`, 9, "#4a5568").setOrigin(
        0.5,
        1,
      );
      this.txt(psx, y - this.slotSz / 2 - 4, `${i + 1}`, 9, "#4a5568").setOrigin(
        0.5,
        1,
      );
      this.kSlots.push(this.makeSlot(ksx, y, this.slotSz));
      this.pSlots.push(this.makeSlot(psx, y, this.slotSz));
    }

    this.txt(mid, y, "VS", 12, "#4a5568").setOrigin(0.5);
  }

  private makeSlot(x: number, y: number, sz: number): SlotUI {
    const bg = this.add.rectangle(x, y, sz, sz, PAL.slotBg);
    const border = this.add.rectangle(x, y, sz, sz);
    border.setFillStyle();
    border.setStrokeStyle(2, PAL.slotStroke);
    const label = this.txt(x, y, "", 13, "#e6edf3").setOrigin(0.5);
    return { bg, border, label };
  }

  private buildRhythmIndicators(W: number, H: number): void {
    const seqY = H * 0.55;
    const sz = this.slotSz;

    this.rhythmCursor = this.add.rectangle(0, seqY, sz + 10, sz + 10);
    this.rhythmCursor.setFillStyle();
    this.rhythmCursor.setStrokeStyle(3, PAL.cursor);
    this.rhythmCursor.setVisible(false).setDepth(DEPTH.rhythmCursor);

    this.timingBar = this.add.rectangle(
      0,
      seqY + sz / 2 - 2,
      sz,
      3,
      PAL.cursor,
      0.8,
    );
    this.timingBar.setOrigin(0, 0.5);
    this.timingBar.setVisible(false).setDepth(DEPTH.rhythmCursor);

    this.beatFlash = this.add.rectangle(
      W / 2,
      seqY - sz / 2 - 26,
      W * 0.6,
      2,
      PAL.cursor,
      0,
    );
    this.beatFlash.setDepth(DEPTH.rhythmCursor);
  }

  private buildButtons(W: number, H: number): void {
    const by = H * 0.8;
    const acts: ActionType[] = [
      ActionType.ATTACK,
      ActionType.GUARD,
      ActionType.COOL,
      ActionType.SPECIAL,
    ];
    // Fixed per-action footprints (design-res pixels) encode a
    // risk/importance hierarchy straight into the tap target: ATTACK
    // is the biggest, SPECIAL the tiniest so panicked thumbs don't
    // mis-fire the overheat-bomb move.
    const bh = 58;
    const gap = 14;
    // Horizontal pad stays small so neighbouring tap zones just touch
    // (no overlap → no ambiguity); vertical pad is generous so thumbs
    // landing slightly above or below the button still register.
    const HIT_PAD_X = 6;
    const HIT_PAD_Y = 20;
    const totalW =
      acts.reduce((sum, a) => sum + ACT_BTN_WIDTH[a], 0) +
      (acts.length - 1) * gap;
    let cursorX = (W - totalW) / 2;

    this.btns = [];
    for (const action of acts) {
      const bw = ACT_BTN_WIDTH[action];
      const bx = cursorX + bw / 2;
      cursorX += bw + gap;

      const pal = this.buttonPalette(action);
      const bg = this.add
        .rectangle(0, 0, bw, bh, pal.on)
        .setStrokeStyle(2, ACT_COL[action]);
      // Emoji + label keeps iconography language-independent while
      // still letting keyboard users memorise the text name.
      const lbl = this.txt(
        0,
        -9,
        `${ACT_EMOJI[action]} ${action}`,
        14,
        "#e6edf3",
      ).setOrigin(0.5);
      const keyHint = this.txt(
        0,
        13,
        ACT_KEY_HINT[action],
        10,
        "#8b949e",
      ).setOrigin(0.5);

      const ctr = this.add
        .container(bx, by, [bg, lbl, keyHint])
        .setSize(bw, bh);
      const hitArea = new Phaser.Geom.Rectangle(
        -bw / 2 - HIT_PAD_X,
        -bh / 2 - HIT_PAD_Y,
        bw + HIT_PAD_X * 2,
        bh + HIT_PAD_Y * 2,
      );
      // Press-in / bounce-back tweens give a physical "heavy switch"
      // feel. The click action fires on pointerdown so the rhythm
      // timing window is honoured even if the player lifts their
      // thumb off the edge of the button.
      ctr
        .setInteractive({
          hitArea,
          hitAreaCallback: Phaser.Geom.Rectangle.Contains,
          useHandCursor: true,
        })
        .on("pointerover", () => {
          if (this.buttonsReady) bg.setFillStyle(pal.hover);
        })
        .on("pointerout", () => {
          bg.setFillStyle(this.buttonsReady ? pal.on : pal.off);
          this.releaseButtonTween(ctr);
        })
        .on("pointerdown", () => {
          this.pressButtonTween(ctr);
          this.onActionClick(action);
        })
        .on("pointerup", () => this.releaseButtonTween(ctr))
        .on("pointerupoutside", () => this.releaseButtonTween(ctr));

      this.btns.push({ container: ctr, bg, action });
    }

    this.txt(
      W / 2,
      by + bh / 2 + 14,
      "Tap or press WASD / arrow keys in rhythm to program your sequence.",
      11,
      "#4a5568",
    ).setOrigin(0.5, 0);
  }

  /**
   * Palette triple used by a button in its on / hover / off states.
   * SPECIAL picks the dark-red theme so the most dangerous action
   * is also visually tagged before the player even reads the label.
   */
  private buttonPalette(action: ActionType): BtnPalette {
    return action === ActionType.SPECIAL ? BTN_PAL.special : BTN_PAL.default;
  }

  /** Press-in tween: snap down to 85% quickly for a weighty feel. */
  private pressButtonTween(ctr: Phaser.GameObjects.Container): void {
    this.tweens.killTweensOf(ctr);
    this.tweens.add({
      targets: ctr,
      scale: 0.85,
      duration: 50,
      ease: "Cubic.easeIn",
    });
  }

  /** Release tween: overshoot back to 1.0 like a sprung heavy switch. */
  private releaseButtonTween(ctr: Phaser.GameObjects.Container): void {
    this.tweens.killTweensOf(ctr);
    this.tweens.add({
      targets: ctr,
      scale: 1,
      duration: 280,
      ease: "Back.easeOut",
    });
  }

  /**
   * Wire WASD + arrow keys to the four action buttons.
   *
   * Routes every binding through `onActionClick`, so rhythm-window
   * enforcement, IDLE-slot checks, and audio feedback stay identical
   * between touch, click, and keyboard paths. Arrow keys are captured
   * so the host page does not scroll while the game has focus.
   */
  private setupKeyboardInput(): void {
    const kb = this.input.keyboard;
    if (!kb) return;

    kb.addCapture("UP,DOWN,LEFT,RIGHT,W,A,S,D");

    for (const { keys, action } of ACTION_KEY_BINDINGS) {
      for (const keyName of keys) {
        const key = kb.addKey(keyName);
        key.on("down", () => {
          this.onActionClick(action);
          this.flashButtonForAction(action);
        });
      }
    }
  }

  /**
   * Briefly highlight the button matching `action` so keyboard-only
   * players get the same "you pressed the right thing" feedback that
   * mouse hover already gives pointer players. Safe to call outside
   * of rhythm phases — it is purely cosmetic.
   */
  private flashButtonForAction(action: ActionType): void {
    const btn = this.btns.find((b) => b.action === action);
    if (!btn) return;
    const pal = this.buttonPalette(action);
    btn.bg.setFillStyle(pal.hover);
    // Run the same press/release tweens the pointer path uses so
    // keyboard input feels identical to touch input.
    this.pressButtonTween(btn.container);
    this.time.delayedCall(90, () => {
      btn.bg.setFillStyle(this.buttonsReady ? pal.on : pal.off);
      this.releaseButtonTween(btn.container);
    });
  }

  private buildGameOver(W: number, H: number): void {
    const dim = this.add
      .rectangle(0, 0, W, H, 0x000000, 0.8)
      .setOrigin(0);
    // Absorb any clicks that fall between the RETRY / BACK TO TITLE
    // buttons so combat buttons behind the overlay can't be mis-fired
    // on the last frame before a RETRY rebuilds the scene.
    dim.setInteractive();
    const title = this.add
      .text(W / 2, H / 2 - 76, "GAME OVER", {
        fontFamily: FONT,
        fontSize: "42px",
        color: "#ff4444",
        fontStyle: "bold",
      })
      .setOrigin(0.5);
    this.goScoreText = this.txt(W / 2, H / 2 - 8, "", 18, "#e6edf3")
      .setOrigin(0.5)
      .setAlign("center");

    // Two-button row: RETRY (same difficulty) on the left,
    // BACK TO TITLE on the right. Sized for comfortable thumb taps.
    const retry = this.makeMenuButton(
      W / 2 - 110,
      H / 2 + 68,
      "RETRY",
      0x2a354e,
      () => this.scene.restart({ difficulty: this.difficulty }),
    );
    const back = this.makeMenuButton(
      W / 2 + 110,
      H / 2 + 68,
      "BACK TO TITLE",
      0x1a1f2e,
      () => this.scene.start("TitleScene"),
    );

    this.goLayer = this.add.container(0, 0, [
      dim,
      title,
      this.goScoreText,
      retry,
      back,
    ]);
    this.goLayer.setVisible(false).setDepth(DEPTH.gameOver);
  }

  /**
   * Compact "menu" button (used by the game-over overlay). Uses the
   * same press/release tween language as the combat buttons so the
   * whole game feels consistent at every layer.
   */
  private makeMenuButton(
    x: number,
    y: number,
    label: string,
    fill: number,
    onClick: () => void,
  ): Phaser.GameObjects.Container {
    const bw = 180;
    const bh = 42;
    const bg = this.add
      .rectangle(0, 0, bw, bh, fill)
      .setStrokeStyle(2, 0x3d4663);
    const lbl = this.txt(0, 0, label, 15, "#e6edf3").setOrigin(0.5);
    const ctr = this.add.container(x, y, [bg, lbl]);
    ctr.setSize(bw, bh);
    ctr.setInteractive(
      new Phaser.Geom.Rectangle(-bw / 2, -bh / 2, bw, bh),
      Phaser.Geom.Rectangle.Contains,
    );
    ctr.on("pointerover", () => bg.setStrokeStyle(2, 0xffcc00));
    ctr.on("pointerout", () => bg.setStrokeStyle(2, 0x3d4663));
    ctr.on("pointerdown", () => {
      this.pressButtonTween(ctr);
    });
    ctr.on("pointerup", () => {
      this.releaseButtonTween(ctr);
      onClick();
    });
    return ctr;
  }

  /**
   * Celebration overlay for a completed EASY / NORMAL run. Big gold
   * headline, clear-time readout, wave/boss/giga summary, and an
   * optional "NEW BEST" badge. Auto-fades into the title transition
   * handled by `returnToTitle()`.
   */
  private showGameClearOverlay(timeMs: number, improved: boolean): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const dim = this.add
      .rectangle(0, 0, W, H, 0x000000, 0.78)
      .setOrigin(0)
      .setDepth(DEPTH.gameOver);
    // Block pass-through clicks while the clear overlay plays so the
    // player can't accidentally poke a stale combat button mid-fade.
    dim.setInteractive();

    const title = this.add
      .text(W / 2, H / 2 - 80, "GAME CLEAR", {
        fontFamily: '"Dela Gothic One", Impact, "Arial Black", sans-serif',
        fontSize: "52px",
        color: "#ffd166",
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.gameOver)
      .setShadow(0, 3, "#ff9a1f", 14, false, true)
      .setScale(0.6);

    const mm = Math.floor(timeMs / 60000);
    const ss = Math.floor((timeMs % 60000) / 1000)
      .toString()
      .padStart(2, "0");
    const sub = this.add
      .text(
        W / 2,
        H / 2 - 12,
        `${this.difficulty.toUpperCase()}  \u00B7  TIME ${mm}:${ss}`,
        {
          fontFamily: FONT,
          fontSize: "20px",
          color: "#e6edf3",
        },
      )
      .setOrigin(0.5)
      .setDepth(DEPTH.gameOver);

    const stats = this.add
      .text(
        W / 2,
        H / 2 + 22,
        `Waves ${this.wave}  \u00B7  Bosses ${this.bossesDefeated}` +
          `  \u00B7  Gigas ${this.gigasDefeated}`,
        {
          fontFamily: FONT,
          fontSize: "15px",
          color: "#8b949e",
        },
      )
      .setOrigin(0.5)
      .setDepth(DEPTH.gameOver);

    if (improved) {
      const best = this.add
        .text(W / 2, H / 2 + 58, "\u2728 NEW BEST TIME", {
          fontFamily: FONT,
          fontSize: "16px",
          color: "#ffd166",
          fontStyle: "bold",
        })
        .setOrigin(0.5)
        .setDepth(DEPTH.gameOver);
      this.tweens.add({
        targets: best,
        alpha: { from: 0.6, to: 1 },
        duration: 520,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }

    const hint = this.add
      .text(W / 2, H - 40, "returning to title\u2026", {
        fontFamily: FONT,
        fontSize: "12px",
        color: "#6e7681",
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.gameOver);

    this.tweens.add({
      targets: title,
      scale: { from: 0.6, to: 1 },
      duration: 480,
      ease: "Back.easeOut",
    });
    [dim, sub, stats, hint].forEach((o) => {
      o.setAlpha(0);
      this.tweens.add({ targets: o, alpha: 1, duration: 480 });
    });
  }

  /**
   * Builds the cached list of objects that bounce on every beat.
   * We snapshot each object's current scale so pulseBeat() can pulse
   * *relative* to that rest-state, which matters for the combatant
   * Images (sized via setDisplaySize → intrinsic scale far below 1).
   */
  private cacheBounceTargets(): void {
    const items = [
      this.kaijuBody,
      this.playerBody,
      this.phaseLabel,
      this.scoreLabel,
      ...this.btns.map((b) => b.container),
    ];
    this.bounceTargets = items.map((obj) => ({
      obj,
      baseScale: obj.scaleX,
    }));
  }

  /**
   * Re-snapshot a tracked object's baseline scale after we mutate it
   * (e.g., kaiju resize between ranks). No-op if the object was never
   * cached as a bounce target.
   */
  private refreshBounceTargetScale(
    obj: Phaser.GameObjects.GameObject & { scaleX: number },
  ): void {
    const entry = this.bounceTargets.find((t) => t.obj === obj);
    if (entry) entry.baseScale = obj.scaleX;
  }

  private txt(
    x: number,
    y: number,
    str: string,
    size: number,
    color: string,
  ): Phaser.GameObjects.Text {
    return this.add.text(x, y, str, {
      fontFamily: FONT,
      fontSize: `${size}px`,
      color,
    });
  }

  /* ============================================================ */
  /*  Beat-count rhythm driver                                      */
  /* ============================================================ */

  private updateRhythm(): void {
    const elapsed = this.time.now - this.rhythmStartTime;

    if (elapsed < 0) return;

    if (!this.buttonsReady) {
      const earlyEnable = SEQ_LEN * RHYTHM_MS - INPUT_WINDOW_MS;
      if (elapsed >= earlyEnable) {
        this.buttonsReady = true;
        this.enableButtons(true);
      }
    }

    const currentBeat = Math.floor(elapsed / RHYTHM_MS);

    while (
      this.lastProcessedBeat < currentBeat &&
      this.lastProcessedBeat < TOTAL_BEATS - 1
    ) {
      this.lastProcessedBeat++;
      this.onRhythmBeat(this.lastProcessedBeat);
    }

    if (!this.rhythmEnded && this.lastProcessedBeat >= TOTAL_BEATS - 1) {
      const lastWindowEnd = (TOTAL_BEATS - 1) * RHYTHM_MS + INPUT_WINDOW_MS;
      if (elapsed > lastWindowEnd) {
        this.rhythmEnded = true;
        this.endRhythmSequence();
      }
    }
  }

  /* ============================================================ */
  /*  Game flow                                                     */
  /* ============================================================ */

  private beginWave(): void {
    this.wave += 1;
    if (this.wave === 1) {
      // Anchor the run clock on the very first wave of the encounter.
      // `resetState()` already zeroes this, but reading `time.now` here
      // keeps the accounting correct after scene restarts where create()
      // and beginWave may land on different frames.
      this.runStartTime = this.time.now;
    }
    const rank = pickKaijuRank(this.wave);
    this.applyKaijuRank(rank);
    this.rollWeatherForWave();
    this.refreshHUD();
    this.refreshProgressHUD();
    const maskedIdx = this.kaijuNoiseMask
      .map((m, i) => (m ? i : -1))
      .filter((i) => i >= 0);
    console.log(
      `[Wave ${this.wave}${
        this.maxWave === Infinity ? "" : `/${this.maxWave}`
      }] ${rank.toUpperCase()} — HP ${this.kaijuHP} — ` +
        `WEATHER ${this.currentWeather.toUpperCase()}` +
        (maskedIdx.length > 0 ? ` (mask ${maskedIdx.join(",")})` : ""),
    );
    this.startRhythmSequence();
  }

  /**
   * Re-roll weather when we cross a phase boundary, then compose the
   * per-slot mask for this wave. Two noise sources are OR-ed together:
   *
   *  1. Sand weather picks one guaranteed slot to fog up.
   *  2. Once `this.wave >= KAIJU_BASELINE_NOISE_WAVE`, each slot
   *     independently rolls a 20% chance to be masked.
   *
   * Rolling once per wave keeps the fog stable while the player is
   * programming their response, and unpredictable between encounters.
   */
  private rollWeatherForWave(): void {
    const phaseIdx = Math.floor((this.wave - 1) / BOSS_EVERY);
    if (phaseIdx !== this.currentPhaseIndex) {
      this.currentPhaseIndex = phaseIdx;
      // EASY disables weather entirely so new players can focus on
      // the core rhythm; the HUD still runs so the placeholder panel
      // shows a consistent "CLEAR" summary.
      this.currentWeather = DIFFICULTY_CONFIGS[this.difficulty].hasWeather
        ? pickWeather(phaseIdx)
        : "clear";
      this.refreshWeatherHUD();
    }
    const eff = this.weatherEffect();
    const sandIdx =
      eff.kaijuNoiseSlots > 0
        ? Phaser.Math.Between(0, SEQ_LEN - 1)
        : -1;
    const baselineActive = this.wave >= KAIJU_BASELINE_NOISE_WAVE;
    const mask: boolean[] = new Array(SEQ_LEN).fill(false);
    for (let i = 0; i < SEQ_LEN; i++) {
      if (i === sandIdx) mask[i] = true;
      if (baselineActive && Math.random() < KAIJU_BASELINE_NOISE_CHANCE) {
        mask[i] = true;
      }
    }
    this.kaijuNoiseMask = mask;
  }

  /** Convenience accessor so consumers never touch the table directly. */
  private weatherEffect(): WeatherEffect {
    return WEATHER_EFFECTS[this.currentWeather];
  }

  /** Paint the top-left weather shelf with the current mood + summary. */
  private refreshWeatherHUD(): void {
    const eff = this.weatherEffect();
    this.weatherLabel.setText(`WEATHER: ${eff.label}`).setColor(eff.color);
    this.weatherDetailLabel.setText(eff.hudDetail);
  }

  /* ---- Combat modifier helpers ---- */
  /*                                                                 */
  /* Thin wrappers around the pure helpers in src/config/weather.ts. */
  /* They read the current weather once so the call sites inside    */
  /* executeCombat stay compact and free of repeated lookups.       */

  private weatherAdjAtkDmg(base: number): number {
    return adjustAttackDmg(base, this.weatherEffect());
  }

  private weatherAdjCoolDelta(base: number): number {
    return adjustCoolDelta(base, this.weatherEffect());
  }

  private weatherAdjHeatGain(base: number): number {
    return adjustHeatGain(base, this.weatherEffect());
  }

  /**
   * Swap the kaiju sprite's texture, size, HP budget, and name label
   * to match the given rank. Kept separate from beginWave so later
   * phases (BOSS warning screens, GIGA kaiju finishers) can compose it.
   */
  private applyKaijuRank(rank: KaijuRank): void {
    const stats = KAIJU_STATS[rank];
    this.currentKaijuMaxHP = stats.hp;
    this.kaijuHP = stats.hp;

    const size = this.baseBodySize * stats.scaleMul;
    this.kaijuBody
      .setTexture(stats.texture)
      .setDisplaySize(size, size)
      .setAlpha(1)
      .clearTint();
    // setDisplaySize changes the intrinsic scale — keep pulseBeat honest.
    this.refreshBounceTargetScale(this.kaijuBody);

    this.kaijuLabel.setText(stats.label).setColor(stats.labelColor);
  }

  /* ---- Rhythm phase (Foreshadow + Programming, 8 beats) ---- */

  /**
   * Kick off a fresh rhythm phase. `leadInMs` controls the gap before
   * the first beat fires — RHYTHM_MS (default) gives the player a
   * full 60-BPM beat of breathing room when a new kaiju appears, while
   * a tighter value is used when looping back after a resolve phase
   * against the same kaiju so the encounter flows without dead time.
   */
  private startRhythmSequence(leadInMs: number = RHYTHM_MS): void {
    this.phase = GamePhase.RHYTHM_KAIJU;
    this.setPhaseDisplay("\u266a READING", "#ffcc00");
    this.clearSlots();
    this.enableButtons(false);
    this.buttonsReady = false;

    this.kaijuSeq = Array.from({ length: SEQ_LEN }, () =>
      Phaser.Math.RND.pick(KAIJU_POOL),
    );
    this.playerSeq = Array.from({ length: SEQ_LEN }, () => ActionType.IDLE);
    this.rhythmEnded = false;

    this.rhythmStartTime = this.time.now + leadInMs;
    this.lastProcessedBeat = -1;

    this.rhythmCursor.setPosition(this.kSlots[0].bg.x, this.kSlots[0].bg.y);

    console.log(
      "[Rhythm] KAIJU:",
      this.kaijuSeq.map((a) => ACT_SHORT[a]).join(" "),
    );
  }

  private onRhythmBeat(beat: number): void {
    this.pulseBeat();

    const prevPIdx = beat - SEQ_LEN - 1;
    if (prevPIdx >= 0 && prevPIdx < SEQ_LEN) {
      this.finalizeSlotInput(prevPIdx);
    }

    if (beat < SEQ_LEN) {
      this.revealKaijuSlot(beat);
      this.rhythmCursor.setVisible(true);
      this.moveCursorTo(this.kSlots[beat]);
    } else {
      const pIdx = beat - SEQ_LEN;

      if (beat === SEQ_LEN) {
        this.phase = GamePhase.RHYTHM_PLAYER;
        this.setPhaseDisplay("\u266a PROGRAM", "#44cc88");
        if (!this.buttonsReady) {
          this.buttonsReady = true;
          this.enableButtons(true);
        }
      }

      this.moveCursorTo(this.pSlots[pIdx]);
      this.startTimingBar(this.pSlots[pIdx]);
      this.pSlots[pIdx].border.setStrokeStyle(3, PAL.cursor);

      if (this.playerSeq[pIdx] !== ActionType.IDLE) {
        this.showSlotInput(pIdx, this.playerSeq[pIdx]);
      }

      console.log(`[Rhythm] Slot ${pIdx} active`);
    }
  }

  private endRhythmSequence(): void {
    this.finalizeSlotInput(SEQ_LEN - 1);
    this.rhythmCursor.setVisible(false);
    this.timingBar.setVisible(false);
    this.enableButtons(false);
    this.buttonsReady = false;

    console.log(
      "[Rhythm] Done:",
      this.playerSeq.map((a) => ACT_SHORT[a]).join(" "),
    );

    // No artificial gap: resolve's own addEvent(delay=RESOLVE_MS) is the
    // only rest between rhythm's last beat and resolve's first tick, so
    // the pulse keeps flowing into the combat phase.
    if (this.phase !== GamePhase.GAME_OVER) this.startResolve();
  }

  /* ---- Rhythm helpers ---- */

  private revealKaijuSlot(i: number): void {
    const action = this.kaijuSeq[i];
    const s = this.kSlots[i];
    const masked = this.kaijuNoiseMask[i] === true;
    // Masked slots get a neutral grey coat + "[ ??? ]" so the player
    // cannot deduce the action from the colour either. The real
    // action will still resolve normally — telegraphKaiju will
    // unmask the slot a beat before it lands so players can learn
    // from the outcome.
    const col = masked ? PAL_SAND_MASK : ACT_COL[action];
    s.bg.setFillStyle(col, 0.5);
    s.border.setStrokeStyle(2, col);
    if (masked) {
      s.label.setFontSize(KAIJU_NOISE_FONT_PX).setText(KAIJU_NOISE_TEXT);
    } else {
      s.label.setFontSize(KAIJU_SLOT_FONT_PX).setText(ACT_SHORT[action]);
    }
    this.tweens.add({
      targets: [s.bg, s.label],
      alpha: { from: 0, to: 1 },
      duration: 180,
    });
  }

  private moveCursorTo(slot: SlotUI): void {
    this.tweens.add({
      targets: this.rhythmCursor,
      x: slot.bg.x,
      y: slot.bg.y,
      duration: 200,
      ease: "Sine.easeOut",
    });
    this.tweens.add({
      targets: this.rhythmCursor,
      scaleX: { from: 1.2, to: 1 },
      scaleY: { from: 1.2, to: 1 },
      duration: 250,
      ease: "Back.easeOut",
    });
  }

  private startTimingBar(slot: SlotUI): void {
    this.tweens.killTweensOf(this.timingBar);
    const x = slot.bg.x - this.slotSz / 2;
    const y = slot.bg.y + this.slotSz / 2 - 2;
    this.timingBar.setPosition(x, y);
    this.timingBar.setScale(0, 1);
    this.timingBar.setVisible(true).setAlpha(0.8);
    this.tweens.add({
      targets: this.timingBar,
      scaleX: 1,
      duration: RHYTHM_MS,
      ease: "Linear",
    });
  }

  private finalizeSlotInput(idx: number): void {
    if (idx < 0 || idx >= SEQ_LEN) return;

    if (this.playerSeq[idx] === ActionType.IDLE) {
      const s = this.pSlots[idx];
      s.label.setText("MISS").setColor("#ff4444");
      s.bg.setFillStyle(PAL.miss, 0.25);

      this.time.delayedCall(350, () => {
        s.label.setText(ACT_SHORT[ActionType.IDLE]).setColor("#666666");
        s.bg.setFillStyle(ACT_COL[ActionType.IDLE], 0.25);
      });

      console.log(`[Rhythm] Slot ${idx}: MISS`);
    }

    this.timingBar.setVisible(false);
  }

  /* ---- Input with timing window ---- */

  private getInputBeat(elapsed: number): number {
    const beatFloat = elapsed / RHYTHM_MS;
    const nearestBeat = Math.round(beatFloat);

    if (nearestBeat < SEQ_LEN || nearestBeat >= TOTAL_BEATS) return -1;

    const beatCentre = nearestBeat * RHYTHM_MS;
    const offset = Math.abs(elapsed - beatCentre);
    if (offset > INPUT_WINDOW_MS) return -1;

    return nearestBeat - SEQ_LEN;
  }

  private onActionClick(action: ActionType): void {
    if (!this.isRhythmPhase()) return;

    const elapsed = this.time.now - this.rhythmStartTime;
    const pIdx = this.getInputBeat(elapsed);
    if (pIdx < 0) return;
    if (this.playerSeq[pIdx] !== ActionType.IDLE) return;

    this.playerSeq[pIdx] = action;
    audio.playClick({ pan: PAN_PLAYER });

    const beatCentre = (pIdx + SEQ_LEN) * RHYTHM_MS;
    const offset = Math.abs(elapsed - beatCentre);
    const quality =
      offset <= 50 ? "PERFECT" : offset <= 120 ? "GOOD" : "OK";

    if (this.lastProcessedBeat >= pIdx + SEQ_LEN) {
      this.showSlotInput(pIdx, action);
    }

    console.log(
      `[Rhythm] Slot ${pIdx}: ${action} (${quality}, ${offset.toFixed(0)}ms)`,
    );
  }

  private showSlotInput(pIdx: number, action: ActionType): void {
    const s = this.pSlots[pIdx];
    s.bg.setFillStyle(ACT_COL[action], 0.5);
    // Border snaps to pure white for the punch-in frame, then eases
    // back to the action-tinted stroke so the slot reads as "locked".
    s.border.setStrokeStyle(3, 0xffffff);
    this.time.delayedCall(160, () => {
      s.border.setStrokeStyle(2, ACT_COL[action]);
    });
    s.label.setText(ACT_SHORT[action]).setColor("#e6edf3");

    // Additive white rectangle sitting on top of the slot for a
    // single-frame bloom. BlendModes.ADD means we brighten whatever
    // is underneath without needing to track per-slot colours.
    const flash = this.add
      .rectangle(s.bg.x, s.bg.y, s.bg.width, s.bg.height, 0xffffff, 0.9)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(DEPTH.sparks);
    this.tweens.add({
      targets: flash,
      alpha: 0,
      scaleX: 1.18,
      scaleY: 1.18,
      duration: 220,
      ease: "Cubic.easeOut",
      onComplete: () => flash.destroy(),
    });

    this.tweens.add({
      targets: s.bg,
      scaleX: { from: 0.8, to: 1 },
      scaleY: { from: 0.8, to: 1 },
      duration: 120,
      ease: "Back.easeOut",
    });
  }

  private pulseBeat(): void {
    audio.playBeat();
    this.beatFlash.setAlpha(0.7);
    this.tweens.add({
      targets: this.beatFlash,
      alpha: 0,
      duration: 250,
      ease: "Sine.easeOut",
    });

    for (const { obj, baseScale } of this.bounceTargets) {
      this.tweens.add({
        targets: obj,
        scaleX: baseScale * 1.05,
        scaleY: baseScale * 1.05,
        duration: 80,
        yoyo: true,
        ease: "Sine.easeOut",
      });
    }
  }

  /* ---- Phase C: Resolution ---- */

  private startResolve(): void {
    this.phase = GamePhase.RESOLUTION;
    this.setPhaseDisplay("\u2694 RESOLUTION", "#ff6644");
    console.log(
      "[Resolve] K:",
      this.kaijuSeq.join(" "),
      "| P:",
      this.playerSeq.join(" "),
    );

    // Reset the per-turn alarm latch; resolvePlayerStep() will arm it
    // the moment an overheat is actually enforced.
    this.ohAlarmedThisTurn = false;

    let tick = 0;
    this.time.addEvent({
      delay: RESOLVE_MS,
      repeat: RESOLVE_TOTAL_TICKS - 1,
      callback: () => {
        if (this.phase !== GamePhase.RESOLUTION) return;
        this.resolveTick(tick);
        tick++;
      },
    });
  }

  /**
   * One resolution beat. Even ticks (0, 2, 4, 6) run the kaiju's
   * telegraph — its action plays from the left channel and a windup
   * animation fires. Odd ticks (1, 3, 5, 7) are the resolve step
   * where the player's response actually lands damage.
   */
  private resolveTick(tick: number): void {
    const stepIdx = tick >> 1;
    const isTelegraph = (tick & 1) === 0;

    this.pulseBeat();

    if (isTelegraph) {
      this.highlightStep(stepIdx, "kaiju");
      this.telegraphKaiju(stepIdx);
    } else {
      this.highlightStep(stepIdx, "player");
      this.resolvePlayerStep(stepIdx);
    }
  }

  /**
   * Kaiju "windup" played on the telegraph beat of each resolve step.
   * Only the kaiju makes noise here — the player's response lives in
   * resolvePlayerStep so the encounter reads as call-and-response.
   */
  private telegraphKaiju(i: number): void {
    const kAct = this.kaijuSeq[i];
    const kR = this.kaijuBody;

    // If this slot was masked (by sand or by the baseline fog), the
    // action is about to land anyway — reveal it so players can
    // learn from the outcome instead of staring at the "?" forever.
    if (this.kaijuNoiseMask[i] === true) {
      const s = this.kSlots[i];
      s.bg.setFillStyle(ACT_COL[kAct], 0.5);
      s.border.setStrokeStyle(2, ACT_COL[kAct]);
      s.label.setFontSize(KAIJU_SLOT_FONT_PX).setText(ACT_SHORT[kAct]);
    }

    switch (kAct) {
      case ActionType.ATTACK:
        audio.playAttack({ pan: PAN_KAIJU });
        // Lean toward the player (x+) to telegraph the incoming hit.
        this.tweens.add({
          targets: kR,
          x: { from: kR.x, to: kR.x + 24 },
          duration: 140,
          yoyo: true,
          ease: "Back.easeOut",
        });
        this.flash(kR, VFX.flash.kaijuHit);
        break;

      case ActionType.GUARD:
        audio.playGuard({ pan: PAN_KAIJU });
        // Angle wobble keeps clear of pulseBeat's scale tween.
        this.tweens.add({
          targets: kR,
          angle: { from: 0, to: -8 },
          duration: 120,
          yoyo: true,
          ease: "Sine.easeOut",
        });
        this.flash(kR, VFX.flash.kaijuBlock);
        break;

      case ActionType.SPECIAL:
        // Kaiju charges up before unleashing — bosses only (Phase 6).
        audio.playSpecial({ pan: PAN_KAIJU });
        this.emitSparks(kR.x, kR.y, VFX.spark.special);
        this.flash(kR, VFX.flash.kaijuSpecial);
        this.popText(kR, "!!", VFX.pop.special);
        break;

      case ActionType.IDLE:
      case ActionType.COOL:
        // No windup for non-actions.
        break;
    }
  }

  /**
   * Resolve the player's programmed response against the kaiju action
   * that was telegraphed a beat earlier. Also runs overheat bookkeeping
   * and the end-of-phase hand-off to the next wave / game-over.
   */
  private resolvePlayerStep(i: number): void {
    let pAct = this.playerSeq[i];
    const kAct = this.kaijuSeq[i];

    if (this.playerHeat >= OVERHEAT_THRESHOLD) {
      this.ohStreak++;
      console.log(`[Step ${i}] OVERHEAT streak=${this.ohStreak}`);
      pAct = ActionType.IDLE;
      const s = this.pSlots[i];
      s.label.setText("OH!");
      s.bg.setFillStyle(PAL.heatRed, 0.7);
      if (!this.ohAlarmedThisTurn) {
        this.ohAlarmedThisTurn = true;
        audio.playOverheat({ pan: PAN_PLAYER });
      }
      if (this.ohStreak >= OVERHEAT_STREAK_LIMIT) {
        this.endGame("MELTDOWN");
        return;
      }
    } else {
      this.ohStreak = 0;
    }

    this.executeCombat(pAct, kAct, i);
    this.playerHeat = Math.max(0, this.playerHeat);
    this.refreshHUD();

    if (this.kaijuHP <= 0) {
      this.onWaveWin();
      return;
    }
    if (this.playerHP <= 0) {
      this.endGame("DESTROYED");
      return;
    }

    if (i >= SEQ_LEN - 1) {
      // Loop straight back into the next rhythm against the same kaiju
      // with only one 120-BPM beat of space so the pulse is unbroken.
      // The post-defeat pause lives in onWaveWin, not here.
      this.startRhythmSequence(RESOLVE_MS);
    }
  }

  /* ============================================================ */
  /*  Combat                                                        */
  /* ============================================================ */

  /**
   * Apply damage, Heat, VFX, and player-side / reaction audio for one
   * resolve step. The kaiju's own action sound (a swing, a guard, a
   * SPECIAL charge) has already played during telegraphKaiju one beat
   * earlier, so this method only emits post-impact sounds (damage,
   * player action, guards that are reactions to the player's attack).
   */
  private executeCombat(
    pAct: ActionType,
    kAct: ActionType,
    step: number,
  ): void {
    let msg: string;
    const kR = this.kaijuBody;
    const pR = this.playerBody;
    // Capture the pre-combat kaiju HP so we can distinguish a kill
    // (transition across zero) from a non-fatal hit at the end of
    // the method. Used to drive the gold EXCELLENT!! praise pop.
    const prevKaijuHP = this.kaijuHP;

    switch (pAct) {
      case ActionType.ATTACK:
        this.playerHeat += this.weatherAdjHeatGain(HEAT_DELTA.attack);
        audio.playAttack({ pan: PAN_PLAYER });
        if (kAct === ActionType.ATTACK) {
          const clashDmg = this.weatherAdjAtkDmg(DMG.clash);
          this.kaijuHP -= clashDmg;
          this.playerHP -= clashDmg;
          msg = `CLASH! Both -${clashDmg}`;
          this.popText(kR, `-${clashDmg}`, VFX.pop.damage);
          this.popText(pR, `-${clashDmg}`, VFX.pop.damage);
          this.emitSparks((kR.x + pR.x) / 2, kR.y, VFX.spark.hit);
          this.flash(kR, VFX.flash.kaijuHit);
          this.flash(pR, VFX.flash.playerHit);
          this.shake(120, 200);
          audio.playDamage({ pan: PAN_KAIJU, volume: 0.8 });
          audio.playDamage({ pan: PAN_PLAYER, volume: 0.8 });
          this.applyHitStop(HITSTOP_MS.clash);
        } else if (kAct === ActionType.GUARD) {
          msg = "BLOCKED!";
          this.emitSparks(kR.x, kR.y, VFX.spark.block);
          this.flash(kR, VFX.flash.kaijuBlock);
          this.shake(30, 80);
        } else {
          const hitDmg = this.weatherAdjAtkDmg(DMG.attack);
          this.kaijuHP -= hitDmg;
          msg = `HIT! KAIJU -${hitDmg}`;
          this.popText(kR, `-${hitDmg}`, VFX.pop.damage);
          this.emitSparks(kR.x, kR.y, VFX.spark.hit);
          this.flash(kR, VFX.flash.kaijuHit);
          this.shake(60, 140);
          audio.playDamage({ pan: PAN_KAIJU });
        }
        break;

      case ActionType.GUARD:
        if (kAct === ActionType.ATTACK) {
          msg = "GUARDED!";
          this.emitSparks(pR.x, pR.y, VFX.spark.block);
          this.flash(pR, VFX.flash.playerGuard);
          this.shake(30, 80);
          audio.playGuard({ pan: PAN_PLAYER });
        } else {
          msg = "\u2014";
        }
        break;

      case ActionType.COOL:
        this.playerHeat += this.weatherAdjCoolDelta(HEAT_DELTA.cool);
        audio.playCool({ pan: PAN_PLAYER });
        if (kAct === ActionType.ATTACK) {
          const vulnDmg = this.weatherAdjAtkDmg(DMG.coolVulnerable);
          this.playerHP -= vulnDmg;
          msg = `VULNERABLE! PLAYER -${vulnDmg}`;
          this.popText(pR, `-${vulnDmg}`, VFX.pop.damage);
          this.emitSparks(pR.x, pR.y, VFX.spark.crit);
          this.flash(pR, VFX.flash.playerHit);
          this.shake(180, 250);
          audio.playDamage({ pan: PAN_PLAYER });
          this.applyHitStop(HITSTOP_MS.vulnerable);
        } else {
          msg = "COOLING\u2026";
          this.popText(pR, "COOL", VFX.pop.cool);
          this.flash(pR, VFX.flash.playerCool);
        }
        break;

      case ActionType.SPECIAL: {
        this.playerHeat += this.weatherAdjHeatGain(HEAT_DELTA.special);
        audio.playSpecial({ pan: PAN_PLAYER });
        // Hit-stop is slightly longer on a GUARD break because the
        // payoff of punching through a defence is bigger.
        const hitStopMs =
          kAct === ActionType.GUARD ? HITSTOP_MS.break : HITSTOP_MS.special;
        if (kAct === ActionType.GUARD) {
          this.kaijuHP -= DMG.specialVsGuard;
          msg = `BREAK! KAIJU -${DMG.specialVsGuard}`;
          this.popText(kR, `-${DMG.specialVsGuard}`, VFX.pop.special);
        } else {
          this.kaijuHP -= DMG.special;
          msg = `SPECIAL! KAIJU -${DMG.special}`;
          this.popText(kR, `-${DMG.special}`, VFX.pop.special);
        }
        this.emitSparks(kR.x, kR.y, VFX.spark.special);
        this.flash(kR, VFX.flash.kaijuSpecial);
        this.shake(200, 300);
        audio.playDamage({ pan: PAN_KAIJU });
        this.applyHitStop(hitStopMs);
        break;
      }

      default:
        if (kAct === ActionType.ATTACK) {
          const hitDmg = this.weatherAdjAtkDmg(DMG.attack);
          this.playerHP -= hitDmg;
          msg = `HIT! PLAYER -${hitDmg}`;
          this.popText(pR, `-${hitDmg}`, VFX.pop.damage);
          this.emitSparks(pR.x, pR.y, VFX.spark.hit);
          this.flash(pR, VFX.flash.playerHit);
          this.shake(60, 140);
          audio.playDamage({ pan: PAN_PLAYER });
        } else {
          msg = "\u2014";
        }
        break;
    }

    console.log(`[Step ${step}] P:${pAct} vs K:${kAct} \u2192 ${msg}`);
    this.showMessage(msg);

    // Praise pops: kills always win over guard-breaks — the kill is
    // the bigger narrative beat. Only non-fatal SPECIAL-through-GUARD
    // hits trigger the CRITICAL callout.
    const killed = prevKaijuHP > 0 && this.kaijuHP <= 0;
    if (killed) {
      this.showPraise("EXCELLENT!!");
    } else if (pAct === ActionType.SPECIAL && kAct === ActionType.GUARD) {
      this.showPraise("CRITICAL!!");
    }
  }

  /* ============================================================ */
  /*  Win / Lose                                                    */
  /* ============================================================ */

  private onWaveWin(): void {
    // Stay in RESOLUTION during the blink animation to prevent
    // updateRhythm from running with stale timing state.
    this.score++;
    // Bookkeep rank kills so ENDLESS best-record writes have accurate
    // numbers, and so we can show "N bosses / N gigas" on clear.
    const rank = pickKaijuRank(this.wave);
    if (rank === "boss") this.bossesDefeated += 1;
    else if (rank === "giga") this.gigasDefeated += 1;
    console.log(
      `[Wave ${this.wave}] ${rank.toUpperCase()} defeated — Score: ${this.score}`,
    );

    // Finite-length runs: the final wave clear triggers GAME CLEAR
    // instead of spinning up another encounter. ENDLESS returns
    // `Infinity`, so this branch is only reachable for EASY / NORMAL.
    if (this.wave >= this.maxWave) {
      this.tweens.add({
        targets: this.kaijuBody,
        alpha: 0,
        duration: 80,
        yoyo: true,
        repeat: 6,
        onComplete: () =>
          this.time.delayedCall(400, () => this.triggerGameClear()),
      });
      return;
    }

    this.tweens.add({
      targets: this.kaijuBody,
      alpha: 0,
      duration: 80,
      yoyo: true,
      repeat: 6,
      onComplete: () => this.time.delayedCall(400, () => this.beginWave()),
    });
  }

  private endGame(reason: string): void {
    this.phase = GamePhase.GAME_OVER;
    this.rhythmCursor.setVisible(false);
    this.timingBar.setVisible(false);
    this.buttonsReady = false;
    // Release any active freeze / danger pulse so the game-over layer
    // animates in cleanly instead of staying frozen or tinted red.
    this.cancelHitStop();
    this.clearHeatAlert();
    this.heatDangerActive = false;
    this.setPhaseDisplay("GAME OVER", "#ff4444");
    console.log(`[GameOver] ${reason} | Score: ${this.score}`);

    // Only ENDLESS writes records on game-over; EASY / NORMAL only
    // count as "best" when a run is completed (handled in
    // triggerGameClear). Keep best-tracking side-effects here so
    // every "run ends" path goes through endGame.
    let bestLine = "";
    if (isEndless(this.difficulty)) {
      // `this.score` already counts waves fully cleared (incremented
      // inside onWaveWin, before any defeat branch). Using it keeps
      // the record free of half-finished waves.
      const run: EndlessRecord = {
        waves: this.score,
        bosses: this.bossesDefeated,
        gigas: this.gigasDefeated,
      };
      const improved = saveEndlessRecord(run);
      bestLine =
        `\nWaves ${run.waves}  \u00B7  Bosses ${run.bosses}  \u00B7  Gigas ${run.gigas}` +
        (improved ? "    \u2728 NEW BEST" : "");
    }

    this.goScoreText.setText(
      `Score: ${this.score}  \u2014 ${reason}${bestLine}`,
    );
    this.goLayer.setVisible(true).setAlpha(0);
    this.tweens.add({ targets: this.goLayer, alpha: 1, duration: 600 });
  }

  /**
   * Finite-length win flow for EASY / NORMAL. We never reach here for
   * ENDLESS (its `maxWave` is `Infinity`). Persists the clear time,
   * shows a brief celebration overlay, then returns to the title so
   * the player can pick a new difficulty without a click.
   */
  private triggerGameClear(): void {
    this.phase = GamePhase.GAME_CLEAR;
    this.rhythmCursor.setVisible(false);
    this.timingBar.setVisible(false);
    this.buttonsReady = false;
    this.cancelHitStop();
    this.clearHeatAlert();
    this.heatDangerActive = false;

    const timeMs = Math.max(0, this.time.now - this.runStartTime);
    const improved =
      this.difficulty === "easy" || this.difficulty === "normal"
        ? saveTimedRecord(this.difficulty, timeMs)
        : false;

    this.setPhaseDisplay("GAME CLEAR", "#ffd166");
    console.log(
      `[GameClear] ${this.difficulty.toUpperCase()} ${timeMs}ms — ` +
        `W${this.wave} B${this.bossesDefeated} G${this.gigasDefeated}` +
        (improved ? " (NEW BEST)" : ""),
    );

    this.showGameClearOverlay(timeMs, improved);

    // Brief celebration, then bounce back to the title so the player
    // can reselect difficulty without an extra click.
    const RETURN_DELAY = 3200;
    this.time.delayedCall(RETURN_DELAY, () => this.returnToTitle());
  }

  private returnToTitle(): void {
    this.cameras.main.fadeOut(300, 0, 0, 0);
    this.cameras.main.once(
      Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE,
      () => this.scene.start("TitleScene"),
    );
  }

  /* ============================================================ */
  /*  HUD helpers                                                   */
  /* ============================================================ */

  /**
   * Paints the top-right wave counter. Finite runs show the goal
   * (`WAVE 3/15`) so the player always knows how close they are to
   * clearing; ENDLESS just shows the raw count since there is no cap.
   */
  private refreshProgressHUD(): void {
    const cap = this.maxWave;
    if (cap === Infinity) {
      this.scoreLabel.setText(`WAVE ${Math.max(1, this.wave)}`);
    } else {
      const shown = Math.min(Math.max(1, this.wave), cap);
      this.scoreLabel.setText(`WAVE ${shown}/${cap}`);
    }
  }

  private refreshHUD(): void {
    const kh = Math.max(0, this.kaijuHP);
    const ph = Math.max(0, this.playerHP);
    const ht = Math.max(0, this.playerHeat);

    this.kaijuHPText.setText(`HP ${kh}`);
    this.kaijuHPBar.displayWidth =
      this.barMaxW * (kh / this.currentKaijuMaxHP);

    this.playerHPText.setText(`HP ${ph}`);
    this.playerHPBar.displayWidth = this.barMaxW * (ph / HP_INIT.player);

    this.playerHeatText.setText(`HEAT ${ht}`);
    this.playerHeatBar.displayWidth =
      this.barMaxW * Math.min(1, ht / OVERHEAT_THRESHOLD);

    if (ht >= OVERHEAT_THRESHOLD) {
      this.playerHeatBar.setFillStyle(PAL.heatRed);
      this.playerHeatText.setColor("#ff0000");
    } else if (ht >= HEAT_DANGER) {
      this.playerHeatBar.setFillStyle(0xff4400);
      this.playerHeatText.setColor("#ff4400");
    } else {
      this.playerHeatBar.setFillStyle(PAL.heatOrange);
      this.playerHeatText.setColor("#ff6600");
    }

    this.updateHeatDangerUI(ht);
  }

  /**
   * Arms or disarms the danger-zone vignette based on the current heat
   * value, and fires a one-shot relief flash on the falling edge. Acts
   * only on state transitions so each event fires once per crossing.
   *
   * During GAME_OVER we suppress both directions: a meltdown should
   * not show a "you're safe!" flash, and endGame() already tears down
   * the alert directly.
   */
  private updateHeatDangerUI(heat: number): void {
    // Suppress both directions once the run is over in either state:
    // a meltdown should not show a "you're safe!" flash, and the
    // end-of-run handlers already tear down the alert directly.
    if (
      this.phase === GamePhase.GAME_OVER ||
      this.phase === GamePhase.GAME_CLEAR
    ) {
      return;
    }

    const nowDanger = heat >= HEAT_DANGER;
    if (nowDanger === this.heatDangerActive) return;

    this.heatDangerActive = nowDanger;
    if (nowDanger) {
      this.activateHeatAlert();
    } else {
      this.clearHeatAlert();
      this.playHeatReliefFlash();
    }
  }

  private setPhaseDisplay(text: string, color: string): void {
    this.phaseLabel.setText(text).setColor(color);
    this.tweens.add({
      targets: this.phaseLabel,
      scaleX: { from: 1.2, to: 1 },
      scaleY: { from: 1.2, to: 1 },
      duration: 200,
      ease: "Sine.easeOut",
    });
  }

  private clearSlots(): void {
    const all = this.kSlots.concat(this.pSlots);
    for (const s of all) {
      s.bg.setFillStyle(PAL.slotBg).setAlpha(1).setScale(1);
      s.border.setFillStyle();
      s.border.setStrokeStyle(2, PAL.slotStroke);
      s.border.setScale(1);
      // Reset the label font: revealKaijuSlot may have shrunk it for
      // a masked "[ ??? ]" render that is now being cleared.
      s.label
        .setFontSize(KAIJU_SLOT_FONT_PX)
        .setText("")
        .setAlpha(1)
        .setColor("#e6edf3");
    }
  }

  /**
   * Spotlight a resolution step. Dim every non-active slot, and put a
   * gold stroke on whichever side is acting this beat — the kaiju on
   * its telegraph beat, the player on the resolve beat. The inactive
   * side keeps its default stroke so the two columns stay legible.
   */
  private highlightStep(idx: number, active: "kaiju" | "player"): void {
    for (let i = 0; i < SEQ_LEN; i++) {
      const a = i === idx ? 1 : 0.3;
      this.kSlots[i].bg.setAlpha(a);
      this.kSlots[i].label.setAlpha(a);
      this.pSlots[i].bg.setAlpha(a);
      this.pSlots[i].label.setAlpha(a);
      this.kSlots[i].border.setStrokeStyle(2, PAL.slotStroke);
      this.pSlots[i].border.setStrokeStyle(2, PAL.slotStroke);
    }
    if (active === "kaiju") {
      this.kSlots[idx].border.setStrokeStyle(3, PAL.highlight);
    } else {
      this.pSlots[idx].border.setStrokeStyle(3, PAL.highlight);
    }
  }

  private enableButtons(on: boolean): void {
    for (const b of this.btns) {
      const pal = this.buttonPalette(b.action);
      if (on) {
        b.container.setInteractive({ useHandCursor: true });
        b.bg.setFillStyle(pal.on).setAlpha(1);
      } else {
        b.container.disableInteractive();
        b.bg.setFillStyle(pal.off).setAlpha(0.5);
      }
    }
  }

  private showMessage(msg: string): void {
    this.msgLabel.setText(msg).setAlpha(1);
    this.tweens.add({
      targets: this.msgLabel,
      alpha: 0,
      delay: 300,
      duration: 500,
    });
  }

  /* ============================================================ */
  /*  Effects                                                       */
  /* ============================================================ */

  /**
   * Freeze-frame for "big impact" events: pause the scene's Time.Clock
   * (next resolveStep and delayedCalls) and all active tweens, then
   * resume after `duration` ms via an out-of-band window.setTimeout
   * (Phaser timers would be paused by the very flag we just set).
   *
   * Camera shake intentionally keeps running — its `preRender` uses
   * frame delta, so the screen rattles on the frozen frame which is
   * the classic fighting-game hit-stop feel.
   */
  private applyHitStop(duration: number): void {
    if (this.hitStopActive) return;
    if (this.phase !== GamePhase.RESOLUTION) return;

    this.hitStopActive = true;
    this.time.paused = true;
    this.tweens.pauseAll();

    this.hitStopResumeHandle = window.setTimeout(() => {
      this.hitStopResumeHandle = null;
      // The scene may have been shut down or restarted while frozen.
      if (!this.scene.isActive()) return;
      this.time.paused = false;
      this.tweens.resumeAll();
      this.hitStopActive = false;
    }, duration);
  }

  private cancelHitStop(): void {
    if (this.hitStopResumeHandle !== null) {
      window.clearTimeout(this.hitStopResumeHandle);
      this.hitStopResumeHandle = null;
    }
    if (this.hitStopActive) {
      this.time.paused = false;
      this.tweens.resumeAll();
      this.hitStopActive = false;
    }
  }

  /** Start the danger-zone pulse on the red vignette. Idempotent. */
  private activateHeatAlert(): void {
    this.heatAlertTween?.stop();
    this.heatVignette.setVisible(true).setAlpha(0.15);
    this.heatAlertTween = this.tweens.add({
      targets: this.heatVignette,
      alpha: { from: 0.15, to: 0.38 },
      duration: 520,
      ease: "Sine.easeInOut",
      yoyo: true,
      repeat: -1,
    });
  }

  /** Remove the red vignette and stop its pulse. */
  private clearHeatAlert(): void {
    this.heatAlertTween?.stop();
    this.heatAlertTween = undefined;
    this.heatVignette.setVisible(false).setAlpha(0);
  }

  /**
   * Bright blue-white camera flash + upward steam burst to celebrate
   * leaving the danger zone. The camera.flash sits above every layer,
   * and the particles trail up from the player body so the catharsis
   * "belongs" to the mech that just vented its heat.
   */
  private playHeatReliefFlash(): void {
    const { r, g, b } = HEAT_RELIEF_RGB;
    this.cameras.main.flash(420, r, g, b);

    const pR = this.playerBody;
    const emitter = this.add.particles(pR.x, pR.y, "spark", {
      // Narrow upward cone for a "steam vent" silhouette rather than
      // a spherical puff. Phaser angles go clockwise from east, so
      // 240°–300° covers the upper 60° sweep.
      speed: { min: 140, max: 260 },
      angle: { min: 240, max: 300 },
      gravityY: -120,
      scale: { start: 1.6, end: 0 },
      alpha: { start: 0.9, end: 0 },
      tint: [0x88ccff, 0xaaddff, 0xffffff],
      lifespan: 720,
      quantity: 30,
      emitting: false,
      blendMode: Phaser.BlendModes.ADD,
    });
    emitter.setDepth(DEPTH.sparks);
    emitter.explode(30);
    this.time.delayedCall(900, () => emitter.destroy());
  }

  private shake(intensity: number, duration = 140): void {
    this.cameras.main.shake(duration, intensity / 10000);
  }

  /**
   * Short color pulse on a combatant body. Tint-multiplies the sprite
   * for 120 ms then clears it, so we never leak a "stuck" color.
   */
  private flash(target: Phaser.GameObjects.Image, color: number): void {
    target.setTint(color);
    this.time.delayedCall(120, () => target.clearTint());
  }

  private popText(
    target: Phaser.GameObjects.Image,
    text: string,
    color: string,
  ): void {
    const startY = target.y - target.displayHeight / 2;
    const t = this.add
      .text(target.x, startY, text, {
        fontFamily: FONT,
        fontSize: "22px",
        color,
        fontStyle: "bold",
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.popText);

    this.tweens.add({
      targets: t,
      y: startY - 44,
      alpha: { from: 1, to: 0 },
      duration: 900,
      ease: "Sine.easeOut",
      onComplete: () => t.destroy(),
    });
  }

  /**
   * Giant gold praise-pop at screen centre for the game's two most
   * satisfying moments: piercing a GUARD with SPECIAL (CRITICAL!!) and
   * finishing a kaiju (EXCELLENT!!). The text scales up with a back-
   * easing overshoot, drifts up, and fades — no stroke clash with the
   * red danger vignette because the dark outline stays 3 px thick.
   */
  private showPraise(text: string): void {
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;
    const t = this.add
      .text(cx, cy, text, {
        fontFamily: FONT,
        fontSize: "48px",
        color: "#ffd24a",
        fontStyle: "bold",
        stroke: "#3b1d00",
        strokeThickness: 6,
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.popText)
      .setScale(0.4);

    this.tweens.add({
      targets: t,
      scale: { from: 0.4, to: 1.3 },
      duration: 260,
      ease: "Back.easeOut",
    });
    this.tweens.add({
      targets: t,
      y: cy - 70,
      alpha: { from: 1, to: 0 },
      duration: 900,
      ease: "Sine.easeOut",
      onComplete: () => t.destroy(),
    });
  }

  private emitSparks(
    x: number,
    y: number,
    tint: number | number[] = 0xffcc00,
  ): void {
    const emitter = this.add.particles(x, y, "spark", {
      speed: { min: 60, max: 220 },
      angle: { min: 0, max: 360 },
      scale: { start: 1.8, end: 0 },
      tint,
      lifespan: 420,
      quantity: 14,
      emitting: false,
    });
    emitter.setDepth(DEPTH.sparks);
    emitter.explode(14);
    this.time.delayedCall(600, () => emitter.destroy());
  }

  /* ============================================================ */
  /*  Resize                                                        */
  /* ============================================================ */

  /**
   * Resize hook. Under Scale.FIT the `size` reported here is the fixed logical
   * game size, so today this is effectively a no-op — the camera viewport and
   * heat vignette are already built to those dimensions. The subscription is
   * kept as an extension point for future orientation-aware layouts or a mode
   * swap to Scale.RESIZE, where these calls become meaningful.
   */
  private onResize(size: Phaser.Structs.Size): void {
    this.cameras.main.setViewport(0, 0, size.width, size.height);
    this.heatVignette?.setSize(size.width, size.height);
  }
}
