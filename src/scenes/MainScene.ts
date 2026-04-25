import Phaser from "phaser";
import { audio } from "../audio/AudioManager";
import {
  beatMsForEndlessWave,
  DIFFICULTY_CONFIGS,
  isEndless,
  maxWavesForDifficulty,
  phaseIndexForWave,
  type Difficulty,
} from "../config/difficulty";
import {
  classifyRhythmInputOffset,
  EMERGENCY,
  HEAT as HEAT_BONUS,
  PULSE,
  RHYTHM,
  type RhythmInputTiming,
  resolvePlayerRhythmInput,
} from "../config/rhythmAndEmergency";
import { EmergencyModeOverlay } from "../game/EmergencyModeOverlay";
import { PlayerRhythmInputVfx } from "../game/PlayerRhythmInputVfx";
import { KAIJU_STATS, pickKaijuRank, type KaijuRank } from "../config/enemies";
import {
  adjustAttackDmg,
  adjustHeatGain,
  getWeatherIconGlyph,
  pickWeather,
  WEATHER_EFFECTS,
  type Weather,
  type WeatherEffect,
} from "../config/weather";
import {
  COMBO,
  WAVE_CATHARSIS,
  OVERHEAT_SFX,
  comboDamageMultiplier,
  flooredWithCombo,
} from "../config/combatJuice";
import {
  actionTheme,
  THEME_TINT_ALPHA,
  THEME_TINT_HEAVY,
} from "../config/actionTheme";
import {
  PHASE_FLOW,
  phaseFlowKaijuBeat,
  phaseFlowPlayerInput,
  phaseFlowPlayerResolve,
  phaseFlowTelegraph,
} from "../config/phaseFlowCopy";
import {
  MATERIAL_ICON_GLYPH,
  materialIconGlyphStyle,
} from "../config/materialIconCodepoints";
import { loadMaterialIconsFont } from "../utils/loadMaterialIconsFont";
import { notifyWavedashLoadComplete } from "../utils/wavedash";
import { wallet, WalletManager } from "../web3/WalletManager";

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
 *    Rhythm     (8 beats — kaiju reveal × 4 + player program × 4, spacing = rhythmMs)
 *    Resolution (8 ticks — same spacing as resolveMs, equals rhythmMs here: telegraph + resolve × 4)
 *    → loop back to Rhythm (or GAME_OVER)
 *
 *  All visuals use Phaser shapes and text (no image assets).
 *
 *  Rhythm / emergency balance lives in `../config/rhythmAndEmergency`
 *  so `MainScene` can stay a coordinator rather than a constants dump.
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
  /**
   * `create()` → `resetState()` until `startRhythmSequence()` on wave 1.
   * Keeps `updateRhythm()` idle while the first-wave READY overlay runs.
   */
  INTRO_READY,
  RHYTHM_KAIJU,
  RHYTHM_PLAYER,
  RESOLUTION,
  GAME_OVER,
  GAME_CLEAR,
}

// ======================== Constants ========================

/** Fallback tempo used when difficulty config is not yet available. */
const RHYTHM_MS_DEFAULT = 1000;

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

/**
 * Resolution step row: inactive rows dim; active row shows kaiju- or player-led scale/border.
 */
const RESOLVE_SLOT_UI = {
  dimRowAlpha: 0.3,
  leadScale: 1.2,
  followScale: 0.9,
  followAlpha: 0.5,
  leadBorderW: 4,
  followBorderW: 2,
  followBorderAlpha: 0.65,
} as const;

/** USER CONSOLE rim: idle (rhythm) vs livelier pulse during PROGRAM. */
const PLAYER_CONSOLE_RIM = {
  idle: { lo: 0.35, hi: 0.72, durationMs: 1650 },
  program: { lo: 0.42, hi: 0.92, durationMs: 900 },
} as const;

const HP_INIT = { player: 100 } as const;
const OVERHEAT_THRESHOLD = 100;
const OVERHEAT_STREAK_LIMIT = 3;

/** After GAME_CLEAR: auto hand-off if the player does not skip (ms). */
const GAME_CLEAR_AUTO_TITLE_MS = 3000;
/** Fade before `TitleScene` or `restart` from result overlays. */
const RESULT_FADE_OUT_MS = 400;
const RESULT_RESTART_FADE_MS = 320;

/**
 * `window.setTimeout` 戻り値。`time.timeScale === 0` では Phaser の
 * `this.time` / `delayedCall` が進まないため、K.O. フリーズ・リザルト遷移・
 * ヒットストップ解除など「実時間で必ず発火」させたい箇所でのみ使う。
 */
type WallClockHandle = ReturnType<typeof setTimeout> | null;

/**
 * Heat at or above this value is the "danger zone": the screen shows a
 * pulsing red vignette. Dropping back below triggers a relief flash
 * plus a blue steam burst to reward the clutch cool-down.
 */
const HEAT_DANGER = 80;

/**
 * Hit-stop durations per event kind (milliseconds).
 * CLASH / BREAK are kept short so tween freeze time does not fight the
 * resolution metronome or read as rhythm lag.
 */
const HITSTOP_MS = {
  clash: 85,
  special: 180,
  break: 90,
  vulnerable: 160,
} as const;

/**
 * Micro squash-stretch on kaiju / player each beat so they read as
 * moving with the metronome. Kept subtle so rank resize + pulseBeat
 * never fight obvious silhouette reads.
 */
const RHYTHM_BODY_SQUASH = {
  /** Horizontal stretch multiplier (applied on top of `baseScale`). */
  stretchX: 1.05,
  /** Vertical squash multiplier (slightly < 1). */
  squashY: 0.93,
  /** One leg of the tween (ms); yoyo doubles the return trip. */
  halfMs: 100,
  /** Player follows the kaiju by a few ms for a tiny call-and-response. */
  playerDelayMs: 28,
} as const;

/**
 * Render depths for overlay layers. Centralised so adding new UI will
 * not silently collide with existing z-order.
 */
const DEPTH = {
  /** Behind sequencer slots: gold ring on PERFECT timing. */
  rhythmInputBack: 6,
  sparks: 40,
  /** PERFECT/GOOD callouts above slots, below most overlays. */
  rhythmInputPraise: 44,
  popText: 50,
  rhythmCursor: 10,
  /** Red stress flash in emergency; under radial vignette. */
  emergencyRed: 84,
  /** Radial “black edges / red core” in emergency. */
  emergencyVig: 85,
  heatVignette: 90,
  /** Boss / Giga pre-fight WARNING — above combat UI, below game-over. */
  rankWarning: 99,
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
  /** Snow: stronger cooling than the base -40; see `executeCombat` COOL branch. */
  coolSnow: -50,
} as const;

const PAL = {
  bg: 0x0b0f14,
  /** Slightly deeper than legacy slot for contrast against HUD back. */
  slotBg: 0x121722,
  slotStroke: 0x4a5a78,
  highlight: 0xffcc00,
  hpGreen: 0x44cc44,
  heatOrange: 0xff6600,
  heatRed: 0xff0000,
  cursor: 0x00ffcc,
  miss: 0xff4444,
} as const;

const ACT_COL: Record<ActionType, number> = {
  [ActionType.ATTACK]: actionTheme("ATTACK").color,
  [ActionType.GUARD]: actionTheme("GUARD").color,
  [ActionType.COOL]: actionTheme("COOL").color,
  [ActionType.SPECIAL]: actionTheme("SPECIAL").color,
  [ActionType.IDLE]: actionTheme("IDLE").color,
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
/** Sand + ベースライン雑音の合算でも、同時に [ ??? ] になる枠はこれ以上にしない。 */
const KAIJU_MASK_MAX_CONCURRENT = 2;

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
 * All four action buttons use the same width. Height holds a Material
 * icon (left) and a two-line label block (name + key hints) on the right.
 */
const ACTION_BUTTON_H = 58;
const ACTION_BUTTON_ROW_GAP = 14;
const ACTION_BUTTON_MIN_W = 120;
const ACTION_BUTTON_MAX_W = 210;
/** Relative to the row-fitted width, shrink each button to remove empty space. */
const ACTION_BUTTON_WIDTH_SHRINK = 2 / 3;
/** Do not go narrower than this after {@link ACTION_BUTTON_WIDTH_SHRINK} (touch target + "SPECIAL"). */
const ACTION_BUTTON_MIN_W_AFTER_SHRINK = 100;
/** Inner margin from the button edge; icon column on the left. */
const ACTION_BUTTON_INNER_PAD = 8;
/** Half-width of the icon column — must fit inside {@link ACTION_BUTTON_H}. */
const ACTION_BUTTON_ICON_R = 20;
const ACTION_BTN_ICON_GAP = 8;
/** {@link buildButtons} action name and key line scale vs the pre-1.5× base. */
const ACTION_BUTTON_TEXT_SCALE = 1.5;

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
/** HUD 可読性: 8px 縁 + 4px ドロップ影（全コンバット UI テキストに統一） */
const HUD_STROKE_THICK = 8;
const HUD_SHADOW = {
  offsetX: 0,
  offsetY: 4,
  color: "#000000",
  blur: 4,
  fill: true,
} as const;
/** 座布団: 黒の半透明。コクピットのコンソール感 */
const ZABUTON_ALPHA = 0.62;
const ZABUTON_RADIUS = 8;

/** Weather HUD: Material icon (px) + gap before the text column. */
const WEATHER_HUD_ICON_PX = 24;
const WEATHER_HUD_TEXT_X = WEATHER_HUD_ICON_PX + 8;
/** Thin frame so the weather strip reads a touch clearer than a flat zab. */
const WEATHER_HUD_STROKE = 0x7d8ba3;
const WEATHER_HUD_STROKE_W = 1.5;
const WEATHER_HUD_STROKE_A = 0.72;
const ZABUTON_PAD = 8;
/** Sub-line under the main phase label (`phaseFlowHint`). */
const PHASE_FLOW_HINT_FONT_PX = 11;
const PHASE_FLOW_HINT_STROKE = "#080c12";
const PHASE_FLOW_HINT_WORD_WRAP_FRAC = 0.92;
/** スコア撃破行: 最優先で目立つ金 */
const SCORE_GOLD = "#ffcc33";
const STEP_INACTIVE = "#4a5a6a";

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
  /** All slot visuals; scaled during RESOLUTION for active row. */
  root: Phaser.GameObjects.Container;
  underlay: Phaser.GameObjects.Rectangle;
  /** Theme-tinted fill (per-action; alpha 0 = empty / idle). */
  themeTint: Phaser.GameObjects.Rectangle;
  border: Phaser.GameObjects.Rectangle;
  /** Large action glyph (sequencer + programmed slots). */
  icon: Phaser.GameObjects.Text;
  /** Secondary text (e.g. masked "[ ??? ]" or "OH!"). */
  label: Phaser.GameObjects.Text;
  labelZab: Phaser.GameObjects.Graphics;
}

interface BtnUI {
  container: Phaser.GameObjects.Container;
  bg: Phaser.GameObjects.Rectangle;
  action: ActionType;
}

/** シーケンサー上 1–4 番。数字のみ（ストローク＋低アルファ / アクティブで強調）。 */
interface StepIndexUI {
  container: Phaser.GameObjects.Container;
  main: Phaser.GameObjects.Text;
  col: "k" | "p";
}

/**
 * Two-line label (name + key hint) for {@link MainScene.buildButtons} at width `bw`.
 * Icon Y is still derived separately from the Material glyph size.
 */
function computeActionButtonTextLayout(bw: number): {
  namePx: number;
  nameStroke: number;
  keyPx: number;
  keyStroke: number;
  nameLineY: number;
  keyLineY: number;
} {
  const s = ACTION_BUTTON_TEXT_SCALE;
  const namePx = Phaser.Math.Clamp(
    Math.round(bw * 0.14 * s),
    Math.round(14 * s),
    Math.round(18 * s),
  );
  const nameStroke = Math.max(5, Math.min(9, Math.round(namePx * 0.38)));
  const keyPx = Phaser.Math.Clamp(
    Math.round(bw * 0.085 * s),
    Math.round(10 * s),
    Math.round(12 * s),
  );
  const keyStroke = Math.max(4, Math.min(6, Math.round(keyPx * 0.42)));
  const lineCenterGap = Phaser.Math.Clamp(
    Math.round((namePx + keyPx) * 0.55 + 4),
    24,
    40,
  );
  const half = lineCenterGap * 0.5;
  return {
    namePx,
    nameStroke,
    keyPx,
    keyStroke,
    nameLineY: -half,
    keyLineY: half,
  };
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
  /** Wall-clock ms captured at beginWave(1) — used for game-clear time display. */
  private runStartTime = 0;
  /** Cleared-boss counter (ENDLESS; shown on game-over). */
  private bossesDefeated = 0;
  /** Cleared-giga counter (ENDLESS; shown on game-over). */
  private gigasDefeated = 0;
  /**
   * Consecutive PERFECT slot inputs; GOOD / MISS / 被弾で 0。
   * 解決フェーズの ATK/SPL 威力に `comboDamageMultiplier(comboCount)`。
   */
  private comboCount = 0;
  /** 現在ウェーブのジャスト入力回数（撃破ボーナス表示用）。 */
  private wavePerfectCount = 0;
  /** `onWaveWin` の 800ms 実時間フリーズ用。 */
  private waveCatharsisRealHandle: WallClockHandle = null;
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
  /** Set in applyKaijuRank — BOSS 撃破条件に使用 */
  private currentKaijuRank: KaijuRank = "zako";
  private score = 0;
  private ohStreak = 0;
  private phase = GamePhase.INTRO_READY;
  /**
   * Repeating `time.addEvent` for resolution ticks. Must be removed when
   * the round ends early (K.O. mid-resolve, final-wave clear) or stray
   * `resolveTick` / `pulseBeat` calls continue behind overlays.
   */
  private resolutionBeatTimer: Phaser.Time.TimerEvent | null = null;
  private kaijuSeq: ActionType[] = [];
  private playerSeq: ActionType[] = [];

  /* ---------- tempo (difficulty-dependent) ---------- */
  /**
   * Beat interval in ms for both the rhythm and resolution phases.
   * Sourced from DIFFICULTY_CONFIGS[difficulty].beatMs in init().
   * Stored as an instance field so every timing calculation reads the
   * same value without touching module-level constants.
   */
  private rhythmMs = RHYTHM_MS_DEFAULT;
  /** Resolution phase uses the same interval for rhythmic continuity. */
  private resolveMs = RHYTHM_MS_DEFAULT;

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
  private hitStopResumeHandle: WallClockHandle = null;

  /* ---------- heat-danger UI state ---------- */
  private heatDangerActive = false;
  private heatVignette!: Phaser.GameObjects.Rectangle;
  private heatAlertTween?: Phaser.Tweens.Tween;
  /** Container wrapping the heat gauge bar; shaken when heat ≥ HEAT_DANGER. */
  private heatGaugeContainer!: Phaser.GameObjects.Container;
  /** Rest position of the heat gauge container — restored after shake ends. */
  private heatGaugeRestX = 0;
  private heatGaugeRestY = 0;
  private heatShakeTween?: Phaser.Tweens.Tween;
  /** Dark panel behind kaiju HP track (with visible border). */
  private kaijuHpBackPanel!: Phaser.GameObjects.Graphics;
  /** Dark panel behind player HP track. */
  private playerHpBackPanel!: Phaser.GameObjects.Graphics;
  /** Dark panel behind heat bar. */
  private heatBarBackPanel!: Phaser.GameObjects.Graphics;
  /** PROGRAM phase: slow alpha pulse on next empty player slot. */
  private nextInputSlotTween?: Phaser.Tweens.Tween;
  private nextInputSlotIndex = -1;

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
  private kaijuLabelZab!: Phaser.GameObjects.Graphics;
  private kaijuHPText!: Phaser.GameObjects.Text;
  private kaijuHpZab!: Phaser.GameObjects.Graphics;
  private playerLabelZab!: Phaser.GameObjects.Graphics;
  private playerNameText!: Phaser.GameObjects.Text;
  private playerHPText!: Phaser.GameObjects.Text;
  private playerHpZab!: Phaser.GameObjects.Graphics;
  private playerHeatText!: Phaser.GameObjects.Text;
  private heatLabelZab!: Phaser.GameObjects.Graphics;
  private kaijuHPBar!: Phaser.GameObjects.Rectangle;
  private playerHPBar!: Phaser.GameObjects.Rectangle;
  private playerHeatBar!: Phaser.GameObjects.Rectangle;
  private kSlots: SlotUI[] = [];
  private pSlots: SlotUI[] = [];
  /**
   * When the player commits an action, stores PERFECT/GOOD for
   * `showSlotInput` and input-bloom strength (independent of kaiju masking).
   */
  private rhythmInputQuality: Array<RhythmInputTiming | null> = [
    null,
    null,
    null,
    null,
  ];
  /** Full-screen low-HP layer; `isEmergencyMode` reflects its active state. */
  private emergencyOverlay: EmergencyModeOverlay | null = null;
  /** PERFECT/GOOD rings and sparks, extracted for clarity and future tests. */
  private rhythmInputVfx!: PlayerRhythmInputVfx;
  private beatPulseIndex = 0;
  private btns: BtnUI[] = [];
  /**
   * Shown above the action row when a BOSS is clamped at 1 HP until
   * SPECIAL lands; pairs with {@link specialFinisherGlow}.
   */
  private bossFinisherHint!: Phaser.GameObjects.Text;
  /** ADD-blend halo behind SPECIAL; pulses while a finisher is required. */
  private specialFinisherGlow!: Phaser.GameObjects.Rectangle;
  private phaseIcon!: Phaser.GameObjects.Text;
  private phaseLabel!: Phaser.GameObjects.Text;
  /** One line under the main phase label: flow hint (K→P) and step readouts. */
  private phaseFlowHint!: Phaser.GameObjects.Text;
  private phaseZab!: Phaser.GameObjects.Graphics;
  private phaseHudContainer!: Phaser.GameObjects.Container;
  /** Score row: Material `skull` + kill count + WAVE line; panel autoscales. */
  private scoreHudPanel!: Phaser.GameObjects.Container;
  private scoreHudBg!: Phaser.GameObjects.Graphics;
  private scoreKillsRow!: Phaser.GameObjects.Container;
  private scoreKillsGlyph!: Phaser.GameObjects.Text;
  private scoreKillsNumber!: Phaser.GameObjects.Text;
  private scoreWaveText!: Phaser.GameObjects.Text;
  /** シーケンサー上 1–4 番 (K 列 / P 列) */
  private stepIndexK: StepIndexUI[] = [];
  private stepIndexP: StepIndexUI[] = [];
  /** Cyan stroke around the player sequencer + subtle alpha pulse. */
  private playerConsoleRim?: Phaser.GameObjects.Rectangle;
  private playerConsoleRimTween?: Phaser.Tweens.Tween;
  private playerRimLively = false;
  /** Top-left weather indicator — big name + small modifier note. */
  private weatherIcon!: Phaser.GameObjects.Text;
  private weatherLabel!: Phaser.GameObjects.Text;
  private weatherDetailLabel!: Phaser.GameObjects.Text;
  private weatherZab!: Phaser.GameObjects.Graphics;
  private msgLabel!: Phaser.GameObjects.Text;
  private msgZab!: Phaser.GameObjects.Graphics;
  private msgHudContainer!: Phaser.GameObjects.Container;
  /** 下部操作ガイド 1 行 — リサイズ時に座布団再計算 */
  private controlGuideText!: Phaser.GameObjects.Text;
  private controlGuideZab!: Phaser.GameObjects.Graphics;
  private controlGuideContainer!: Phaser.GameObjects.Container;
  private seqKaijuZab!: Phaser.GameObjects.Graphics;
  private seqVsZab!: Phaser.GameObjects.Graphics;
  private goLayer!: Phaser.GameObjects.Container;
  private goScoreText!: Phaser.GameObjects.Text;
  /**
   * ENDLESS game-over only: subheading + huge numeric score; absent on
   * EASY / NORMAL (those modes use a single `goScoreText` line).
   */
  private goEndlessScoreLabel?: Phaser.GameObjects.Text;
  private goEndlessScoreHero?: Phaser.GameObjects.Text;
  /* Game-over Web3 integration refs — only visible on the GO overlay. */
  private goWalletBtn?: Phaser.GameObjects.Container;
  private goWalletBtnLabel?: Phaser.GameObjects.Text;
  private goSubmitBtn?: Phaser.GameObjects.Container;
  private goWeb3Status?: Phaser.GameObjects.Text;
  /**
   * Latches `true` when a signature has been collected for the
   * current run, so the player cannot spam the signing popup if
   * they tap "Submit" multiple times in rapid succession.
   */
  private scoreSubmitted = false;
  /**
   * Set while a connect / sign RPC is in-flight so a second click
   * cannot queue a duplicate MetaMask popup (which some wallets
   * report as `-32002 "request already pending"`).
   */
  private walletBusy = false;
  /** GAME_CLEAR からの自動タイトル（`WallClockHandle`）。 */
  private gameClearAutoTitleHandle: WallClockHandle = null;
  /** フェード後の `start` / `restart`（`WallClockHandle`）。 */
  private postFadeSceneHandle: WallClockHandle = null;
  /**
   * True while a fade+handoff to title or a fade+restart is running so
   * double taps / double keys cannot start two scene transitions.
   */
  private resultScreenNavInProgress = false;
  /**
   * GAME_CLEAR: any key skips to title — unregistered on hand-off or shutdown
   * so the handler never leaks to the next run.
   */
  private readonly onGameClearKeyForTitleSkip = (): void => {
    if (this.phase !== GamePhase.GAME_CLEAR) return;
    if (this.resultScreenNavInProgress) return;
    this.trySkipGameClearToTitle();
  };
  /**
   * One-shot audio unlock: stored so we can `off` it on {@link Phaser.Scenes.Events.SHUTDOWN}
   * and never leak listeners into `TitleScene`.
   */
  private readonly unlockAudioOnFirstGesture = (): void => {
    audio.unlock();
  };
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
    this.syncBeatDuration(1);
  }

  /**
   * Sets `rhythmMs` and `resolveMs`. ENDLESS derives beat length from
   * `beatMsForEndlessWave`; other modes use static `beatMs` from config.
   *
   * @param endlessWave — Pass `1` from `init()` only: `this.wave` is not
   *   reset until `create()` → `resetState()`.
   */
  private syncBeatDuration(endlessWave?: number): void {
    if (isEndless(this.difficulty)) {
      const w = endlessWave ?? (this.wave < 1 ? 1 : this.wave);
      this.rhythmMs = beatMsForEndlessWave(w);
    } else {
      this.rhythmMs = DIFFICULTY_CONFIGS[this.difficulty].beatMs;
    }
    this.resolveMs = this.rhythmMs;
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
    this.rhythmInputVfx = new PlayerRhythmInputVfx(this, {
      rhythmInputBack: DEPTH.rhythmInputBack,
      rhythmInputPraise: DEPTH.rhythmInputPraise,
      sparks: DEPTH.sparks,
    });
    this.cacheBounceTargets();
    this.refreshHUD();
    this.setupKeyboardInput();

    this.scale.on("resize", this.onResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.scale.off("resize", this.onResize, this);
      // If a hit-stop is in flight, its out-of-band timeout would try
      // to poke a destroyed scene; drop the handle to be safe.
      this.cancelHitStop();
      this.resumeGlobalTimeScale();
      this.stopResolutionSchedule();
      this.clearWaveCatharsisHandle();
      this.endEmergencyMode();
      this.stopNextInputSlotHint();
      this.playerConsoleRimTween?.stop();
      this.playerConsoleRimTween = undefined;
      this.teardownEncounterAudio();
      this.clearResultHandoffWallClockHandles();
      this.input.keyboard?.off("keydown", this.onGameClearKeyForTitleSkip);
      this.input.off("pointerdown", this.unlockAudioOnFirstGesture);
      this.input.keyboard?.off("keydown", this.unlockAudioOnFirstGesture);
      this.teardownActionKeyboard();
      this.input.enabled = true;
    });

    // Browser autoplay policy: the AudioContext can only start after a
    // user gesture, so the first pointer/key event unlocks audio.
    this.input.once("pointerdown", this.unlockAudioOnFirstGesture);
    this.input.keyboard?.once("keydown", this.unlockAudioOnFirstGesture);

    notifyWavedashLoadComplete();
    this.scheduleMaterialIconRasterRefresh();
    audio.startCombatBgm();
    this.showReadyThenBeginWave();
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
    this.currentKaijuRank = "zako";
    this.score = 0;
    this.bossesDefeated = 0;
    this.gigasDefeated = 0;
    this.comboCount = 0;
    this.wavePerfectCount = 0;
    this.clearWaveCatharsisHandle();
    this.runStartTime = 0;
    this.ohStreak = 0;
    this.phase = GamePhase.INTRO_READY;
    this.kaijuSeq = [];
    this.playerSeq = [];
    this.rhythmInputQuality = [null, null, null, null];
    this.rhythmStartTime = 0;
    this.lastProcessedBeat = -1;
    this.rhythmEnded = false;
    this.buttonsReady = false;
    this.ohAlarmedThisTurn = false;
    this.beatPulseIndex = 0;
    this.stopResolutionSchedule();
    this.endEmergencyMode();
    this.hitStopActive = false;
    this.heatDangerActive = false;
    this.scoreSubmitted = false;
    this.walletBusy = false;
  }

  /** True while the beat-count rhythm driver should advance the turn. */
  private isRhythmPhase(): boolean {
    return (
      this.phase === GamePhase.RHYTHM_KAIJU ||
      this.phase === GamePhase.RHYTHM_PLAYER
    );
  }

  private isRunTerminalPhase(): boolean {
    return (
      this.phase === GamePhase.GAME_OVER ||
      this.phase === GamePhase.GAME_CLEAR
    );
  }

  private get isEmergencyMode(): boolean {
    return this.emergencyOverlay?.isActive() === true;
  }

  /**
   * 桜井式: 全 HUD ラインに太縁 (8) + 影。`setStyle` マージ用にスプレッド展開可。
   */
  private hudLineTextStyle(
    sizePx: number,
    color: string,
    weight: string,
  ): Phaser.Types.GameObjects.Text.TextStyle {
    return {
      font: `${weight} ${sizePx}px system-ui, "Segoe UI", sans-serif`,
      color,
      stroke: "#000000",
      strokeThickness: HUD_STROKE_THICK,
      shadow: { ...HUD_SHADOW },
    };
  }

  private layoutZabutonBehindText(
    text: Phaser.GameObjects.Text,
    g: Phaser.GameObjects.Graphics,
    pad: number,
    alpha: number = ZABUTON_ALPHA,
  ): void {
    if (!text || !g) return;
    const ox = text.originX;
    const oy = text.originY;
    const w = text.width + pad * 2;
    const h = text.height + pad * 2;
    const x = -text.width * ox - pad;
    const y = -text.height * oy - pad;
    g.clear();
    g.fillStyle(0x000000, alpha);
    g.fillRoundedRect(x, y, w, h, ZABUTON_RADIUS);
  }

  /** Rounded zabuton behind a known inner width/height (centred on origin). */
  private layoutZabutonSizedRect(
    g: Phaser.GameObjects.Graphics,
    innerW: number,
    innerH: number,
    pad: number,
    alpha: number = ZABUTON_ALPHA,
  ): void {
    const w = innerW + pad * 2;
    const h = innerH + pad * 2;
    const x = -w / 2;
    const y = -h / 2;
    g.clear();
    g.fillStyle(0x000000, alpha);
    g.fillRoundedRect(x, y, w, h, ZABUTON_RADIUS);
  }

  private layoutWeatherZabBlock(): void {
    const pad = ZABUTON_PAD;
    const textW = Math.max(this.weatherLabel.width, this.weatherDetailLabel.width);
    const w = WEATHER_HUD_TEXT_X + textW + pad * 2;
    const h =
      Math.max(WEATHER_HUD_ICON_PX + 2, this.weatherLabel.height) +
      4 +
      this.weatherDetailLabel.height +
      pad * 2;
    const x = -2;
    const y = -2;
    this.weatherZab.clear();
    this.weatherZab.fillStyle(0x000000, ZABUTON_ALPHA);
    this.weatherZab.fillRoundedRect(x, y, w, h, ZABUTON_RADIUS);
    this.weatherZab.lineStyle(
      WEATHER_HUD_STROKE_W,
      WEATHER_HUD_STROKE,
      WEATHER_HUD_STROKE_A,
    );
    this.weatherZab.strokeRoundedRect(x, y, w, h, ZABUTON_RADIUS);
  }

  private layoutControlGuideZab(): void {
    this.layoutZabutonBehindText(
      this.controlGuideText,
      this.controlGuideZab,
      ZABUTON_PAD,
    );
    this.controlGuideZab.setDepth(0);
    this.controlGuideText.setDepth(1);
  }

  /* ============================================================ */
  /*  UI construction                                               */
  /* ============================================================ */

  private buildUI(): void {
    const W = this.scale.width;
    const H = this.scale.height;

    this.buildControlDeckBack(W, H);

    this.phaseZab = this.add.graphics();
    this.phaseIcon = this.add
      .text(0, 0, "", { ...materialIconGlyphStyle(22, "#8b949e", 2) })
      .setOrigin(0.5, 0.5)
      .setVisible(false);
    this.phaseLabel = this.add
      .text(0, 0, " ", { ...this.hudLineTextStyle(18, "#8b949e", "800") })
      .setOrigin(0.5, 0.5);
    this.phaseHudContainer = this.add
      .container(W / 2, 20, [this.phaseZab, this.phaseIcon, this.phaseLabel])
      .setName("phaseHud");
    this.layoutZabutonBehindText(this.phaseLabel, this.phaseZab, ZABUTON_PAD);
    this.phaseZab.setDepth(1);
    this.phaseIcon.setDepth(2);
    this.phaseLabel.setDepth(3);
    this.phaseLabel.setText("");

    this.phaseFlowHint = this.add
      .text(W / 2, 50, "", {
        font: `600 ${PHASE_FLOW_HINT_FONT_PX}px ${FONT}`,
        color: "#9fb0c2",
        stroke: PHASE_FLOW_HINT_STROKE,
        strokeThickness: 3,
        align: "center",
        wordWrap: {
          width: W * PHASE_FLOW_HINT_WORD_WRAP_FRAC,
          useAdvancedWrap: true,
        },
      })
      .setOrigin(0.5, 0.5)
      .setVisible(false)
      .setDepth(3)
      .setName("phaseFlowHint");

    this.buildScoreHud();
    this.refreshProgressHUD();

    this.weatherZab = this.add.graphics();
    this.weatherIcon = this.add
      .text(0, 0, getWeatherIconGlyph(this.currentWeather), {
        ...materialIconGlyphStyle(WEATHER_HUD_ICON_PX, "#8b949e", 2),
      })
      .setOrigin(0, 0);
    this.weatherLabel = this.add
      .text(WEATHER_HUD_TEXT_X, 0, " ", { ...this.hudLineTextStyle(13, "#8b949e", "800") })
      .setOrigin(0, 0);
    this.weatherDetailLabel = this.add
      .text(WEATHER_HUD_TEXT_X, 20, " ", { ...this.hudLineTextStyle(10, "#6e7681", "700") })
      .setOrigin(0, 0);
    this.add.container(18, 18, [
      this.weatherZab,
      this.weatherIcon,
      this.weatherLabel,
      this.weatherDetailLabel,
    ]);
    this.refreshWeatherHUD();

    this.msgZab = this.add.graphics();
    this.msgLabel = this.add
      .text(0, 0, "", { ...this.hudLineTextStyle(16, "#ffcc00", "900") })
      .setOrigin(0.5, 0.5);
    this.msgHudContainer = this.add
      .container(W / 2, H * 0.53, [this.msgZab, this.msgLabel])
      .setAlpha(0);
    this.layoutZabutonBehindText(this.msgLabel, this.msgZab, ZABUTON_PAD);
    this.msgLabel.setText("");

    this.buildCharacters(W, H);
    this.buildSequencer(W, H);
    this.buildRhythmIndicators(W, H);
    this.buildButtons(W, H);
    this.buildHeatOverlay(W, H);
    this.buildGameOver(W, H);
    this.buildCockpitChrome(W, H);
    this.buildMonitorOverlay(W, H);
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
    // Upper half: combat area sits in the top ~50 % of the screen.
    const cy = H * 0.27;
    const sz = Math.min(80, W * 0.085);
    this.baseBodySize = sz;
    this.barMaxW = sz * 1.6;
    const barH = 7;
    const barGap = 14;

    // ---- Kaiju (left side) ----
    const kx = W * 0.25;
    this.kaijuBody = this.add
      .image(kx, cy, KAIJU_STATS.zako.texture)
      .setDisplaySize(sz, sz);
    const kaijuBarY = cy - sz / 2 - barGap;
    this.kaijuHpBackPanel = this.add.graphics();
    this.drawHpHeatGaugePanel(
      this.kaijuHpBackPanel,
      kx,
      kaijuBarY,
      this.barMaxW + 14,
      barH + 10,
    );
    this.kaijuHPBar = this.add
      .rectangle(
        kx - this.barMaxW / 2,
        kaijuBarY,
        this.barMaxW,
        barH,
        PAL.hpGreen,
      )
      .setOrigin(0, 0.5);
    this.kaijuHpZab = this.add.graphics();
    this.kaijuHPText = this.add
      .text(0, 0, " ", { ...this.hudLineTextStyle(13, "#44cc44", "800") })
      .setOrigin(0.5, 1);
    this.add.container(kx, kaijuBarY - barH, [this.kaijuHpZab, this.kaijuHPText]);
    this.kaijuLabelZab = this.add.graphics();
    this.kaijuLabel = this.add
      .text(0, 0, KAIJU_STATS.zako.label, {
        font: `800 11px system-ui, "Segoe UI", sans-serif`,
        color: KAIJU_STATS.zako.labelColor,
        stroke: "#000000",
        strokeThickness: HUD_STROKE_THICK,
        shadow: { ...HUD_SHADOW },
      })
      .setOrigin(0.5, 0);
    this.add.container(kx, cy + sz / 2 + 8, [this.kaijuLabelZab, this.kaijuLabel]);
    this.layoutZabutonBehindText(
      this.kaijuLabel,
      this.kaijuLabelZab,
      ZABUTON_PAD,
    );

    // ---- Player (right side) ----
    const px = W * 0.75;
    this.playerBody = this.add
      .image(px, cy, "mech-player")
      .setDisplaySize(sz, sz);

    // HP bar (above the body)
    const hpBarY = cy - sz / 2 - barGap * 2;
    this.playerHpBackPanel = this.add.graphics();
    this.drawHpHeatGaugePanel(
      this.playerHpBackPanel,
      px,
      hpBarY,
      this.barMaxW + 14,
      barH + 10,
    );
    this.playerHPBar = this.add
      .rectangle(
        px - this.barMaxW / 2,
        hpBarY,
        this.barMaxW,
        barH,
        PAL.hpGreen,
      )
      .setOrigin(0, 0.5);
    this.playerHpZab = this.add.graphics();
    this.playerHPText = this.add
      .text(0, 0, " ", { ...this.hudLineTextStyle(13, "#44cc44", "800") })
      .setOrigin(0.5, 1);
    this.add.container(px, hpBarY - barH, [this.playerHpZab, this.playerHPText]);

    // Heat gauge — wrapped in a container so the whole gauge can be
    // shaken as a unit when heat enters the danger zone.
    const heatBarY = cy - sz / 2 - barGap + 2;
    this.heatBarBackPanel = this.add.graphics();
    this.drawHpHeatGaugePanel(
      this.heatBarBackPanel,
      0,
      0,
      this.barMaxW + 16,
      barH + 10,
    );
    const heatBg = this.add
      .rectangle(-this.barMaxW / 2, 0, this.barMaxW, barH + 2, 0x1a1a1a)
      .setOrigin(0, 0.5);
    this.playerHeatBar = this.add
      .rectangle(-this.barMaxW / 2, 0, this.barMaxW, barH, 0x00ffff)
      .setOrigin(0, 0.5);
    // "HEAT" descriptor label inside the container
    this.heatLabelZab = this.add.graphics();
    this.playerHeatText = this.add
      .text(this.barMaxW / 2, -barH - 1, `HEAT 0/${OVERHEAT_THRESHOLD}`, {
        ...this.hudLineTextStyle(12, "#88dddd", "800"),
      })
      .setOrigin(0.5, 1);

    this.heatGaugeContainer = this.add.container(px, heatBarY, [
      this.heatBarBackPanel,
      heatBg,
      this.playerHeatBar,
      this.heatLabelZab,
      this.playerHeatText,
    ]);
    this.heatGaugeRestX = px;
    this.heatGaugeRestY = heatBarY;

    this.playerLabelZab = this.add.graphics();
    this.playerNameText = this.add
      .text(0, 0, "PLAYER", { ...this.hudLineTextStyle(11, "#3366cc", "800") })
      .setOrigin(0.5, 0);
    this.add.container(px, cy + sz / 2 + 8, [this.playerLabelZab, this.playerNameText]);
    this.layoutZabutonBehindText(
      this.playerNameText,
      this.playerLabelZab,
      ZABUTON_PAD,
    );
  }

  private buildSequencer(W: number, H: number): void {
    const y = H * 0.65;
    this.slotSz = Math.min(56, W * 0.058);
    const gap = 10;
    const groupW = SEQ_LEN * this.slotSz + (SEQ_LEN - 1) * gap;
    const mid = W / 2;
    const sep = 24;

    this.seqKaijuZab = this.add.graphics();
    const tK = this.add
      .text(0, 0, "KAIJU", { ...this.hudLineTextStyle(11, "#ee6666", "800") })
      .setOrigin(0.5, 1);
    this.add.container(mid - sep - groupW / 2, y - this.slotSz / 2 - 18, [
      this.seqKaijuZab,
      tK,
    ]);
    this.layoutZabutonBehindText(tK, this.seqKaijuZab, ZABUTON_PAD);
    tK.setDepth(1);

    const playerColCx = mid + sep + groupW / 2;
    const topSlotY = y - this.slotSz / 2;
    this.add
      .text(
        playerColCx,
        topSlotY - 8,
        "USER CONSOLE",
        {
          font: `800 ${Math.max(10, Math.min(12, W * 0.012))}px system-ui, "Segoe UI", sans-serif`,
          color: "#66ddee",
          stroke: "#050a10",
          strokeThickness: 4,
        },
      )
      .setOrigin(0.5, 1)
      .setDepth(6);
    this.playerConsoleRim = this.add
      .rectangle(
        playerColCx,
        y,
        groupW + 24,
        this.slotSz + 22,
        0x000000,
        0,
      )
      .setStrokeStyle(1.5, 0x55ddee, 0.5)
      .setDepth(4);
    this.startPlayerConsoleRimPulse();

    this.kSlots = [];
    this.pSlots = [];
    this.stepIndexK = [];
    this.stepIndexP = [];

    for (let i = 0; i < SEQ_LEN; i++) {
      const ksx =
        mid - sep - groupW + this.slotSz / 2 + i * (this.slotSz + gap);
      const psx = mid + sep + this.slotSz / 2 + i * (this.slotSz + gap);
      const num = `${i + 1}`;
      const stepY = y - this.slotSz / 2 - 4;
      const pairK = this.createStepIndexPair(ksx, stepY, num, "k");
      this.stepIndexK.push(pairK);
      const pairP = this.createStepIndexPair(psx, stepY, num, "p");
      this.stepIndexP.push(pairP);
      this.kSlots.push(this.makeSlot(ksx, y, this.slotSz, "kaiju"));
      this.pSlots.push(this.makeSlot(psx, y, this.slotSz, "player"));
    }

    this.seqVsZab = this.add.graphics();
    const tV = this.add
      .text(0, 0, "VS", { ...this.hudLineTextStyle(12, "#9aa5b4", "800") })
      .setOrigin(0.5, 0.5);
    this.add.container(mid, y, [this.seqVsZab, tV]);
    this.layoutZabutonBehindText(tV, this.seqVsZab, ZABUTON_PAD);
    tV.setDepth(1);
  }

  private makeSlot(
    x: number,
    y: number,
    sz: number,
    side: "kaiju" | "player",
  ): SlotUI {
    const root = this.add.container(x, y);
    const underBase =
      side === "kaiju"
        ? { c: 0x1a1e28 as number, a: 0.96 }
        : { c: PAL.slotBg as number, a: 0.98 };
    const underlay = this.add
      .rectangle(0, 0, sz, sz, underBase.c, underBase.a)
      .setOrigin(0.5);
    const themeTint = this.add
      .rectangle(0, 0, sz, sz, 0xffffff, 0)
      .setOrigin(0.5);
    themeTint.setAlpha(0);
    const border = this.add.rectangle(0, 0, sz, sz);
    border.setFillStyle();
    border.setStrokeStyle(2, PAL.slotStroke);
    const labelZab = this.add.graphics();
    const iconSize = Math.max(20, Math.floor(sz * 0.5));
    // Geometric centre of the cell (local 0,0 = slot centre in world x,y).
    const icon = this.add
      .text(0, 0, "", {
        ...materialIconGlyphStyle(
          iconSize,
          "#e6edf3",
          Math.max(2, Math.floor(iconSize * 0.1)),
        ),
      })
      .setVisible(false);
    this.centerSlotActionIcon(icon);
    const label = this.add
      .text(0, 0, "", {
        font: '800 13px system-ui, "Segoe UI", sans-serif',
        color: "#e6edf3",
        stroke: "#000000",
        strokeThickness: HUD_STROKE_THICK,
        shadow: { ...HUD_SHADOW },
      })
      .setOrigin(0.5)
      .setVisible(false);
    // Border on top so thick RESOLUTION strokes read over the icon.
    root.add([underlay, themeTint, labelZab, icon, label, border]);
    const slot: SlotUI = {
      root,
      underlay,
      themeTint,
      border,
      icon,
      label,
      labelZab,
    };
    this.reflowSlotLabelZab(slot);
    return slot;
  }

  /** Slightly oversized dark plate + stroke so HP / Heat never blend into the playfield. */
  private drawHpHeatGaugePanel(
    g: Phaser.GameObjects.Graphics,
    cx: number,
    cy: number,
    w: number,
    h: number,
  ): void {
    g.clear();
    const x = cx - w / 2;
    const y = cy - h / 2;
    g.fillStyle(0x08080c, 0.94);
    g.fillRoundedRect(x, y, w, h, 5);
    g.lineStyle(2, 0x5a6578, 0.95);
    g.strokeRoundedRect(x, y, w, h, 5);
  }

  private reflowSlotLabelZab(s: SlotUI): void {
    if (!s.label.visible) {
      s.labelZab.clear();
      return;
    }
    this.layoutZabutonBehindText(s.label, s.labelZab, 4, 0.55);
  }

  /**
   * Call after any `setText` / `setFontSize` on a slot’s material icon.
   * Classic Material Icons sit visually high inside the em box on canvas, so
   * geometric (0,0) + origin 0.5 looks top-heavy; nudge Y down for optical center.
   */
  private centerSlotActionIcon(icon: Phaser.GameObjects.Text): void {
    icon.setOrigin(0.5, 0.5);
    let fontPx = 24;
    const raw = icon.style?.fontSize;
    if (raw != null) {
      if (typeof raw === "number" && !Number.isNaN(raw)) {
        fontPx = raw;
      } else {
        const m = /(\d+(?:\.\d+)?)/.exec(String(raw));
        if (m) fontPx = parseFloat(m[1]);
      }
    }
    const nudgeY = Math.max(2, Math.round(fontPx * 0.12));
    icon.setPosition(0, nudgeY);
  }

  /** Cyan USER CONSOLE rim — subtle “live” pulse (kept off slot alpha). */
  private startPlayerConsoleRimPulse(): void {
    this.playerConsoleRimTween?.stop();
    if (!this.playerConsoleRim) return;
    const mode = this.playerRimLively
      ? PLAYER_CONSOLE_RIM.program
      : PLAYER_CONSOLE_RIM.idle;
    this.playerConsoleRim.setAlpha(mode.lo);
    this.playerConsoleRimTween = this.tweens.add({
      targets: this.playerConsoleRim,
      alpha: { from: mode.lo, to: mode.hi },
      duration: mode.durationMs,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  /** Stronger / faster rim pulse while the player is programming the lower row. */
  private setPlayerConsoleRimLively(lively: boolean): void {
    if (this.playerRimLively === lively) return;
    this.playerRimLively = lively;
    this.startPlayerConsoleRimPulse();
  }

  /** Action-button fills derived from the same theme colour as the sequencer. */
  private buttonThemePalette(action: ActionType): {
    on: number;
    hover: number;
    off: number;
    stroke: number;
  } {
    const base = Phaser.Display.Color.ValueToColor(ACT_COL[action]);
    return {
      on: Phaser.Display.Color.GetColor(
        Math.max(0, base.red - 55),
        Math.max(0, base.green - 55),
        Math.max(0, base.blue - 70),
      ),
      hover: Phaser.Display.Color.GetColor(
        Math.max(0, base.red - 25),
        Math.max(0, base.green - 25),
        Math.max(0, base.blue - 30),
      ),
      off: Phaser.Display.Color.GetColor(
        Math.max(0, base.red - 95),
        Math.max(0, base.green - 95),
        Math.max(0, base.blue - 105),
      ),
      stroke: ACT_COL[action],
    };
  }

  private stopNextInputSlotHint(): void {
    if (this.nextInputSlotTween) {
      this.nextInputSlotTween.stop();
      this.nextInputSlotTween = undefined;
    }
    if (this.nextInputSlotIndex >= 0 && this.pSlots[this.nextInputSlotIndex]?.root) {
      const r = this.pSlots[this.nextInputSlotIndex].root;
      r.setAlpha(1);
      r.setScale(1);
    }
    this.nextInputSlotIndex = -1;
  }

  /**
   * PROGRAM phase: first empty player slot slowly blinks so the next
   * commitment target is obvious (alpha 0.5 ↔ 1.0).
   */
  private refreshNextInputSlotHint(): void {
    if (
      this.phase !== GamePhase.RHYTHM_PLAYER ||
      this.rhythmEnded ||
      this.isRunTerminalPhase()
    ) {
      this.stopNextInputSlotHint();
      return;
    }
    let next = -1;
    for (let i = 0; i < SEQ_LEN; i++) {
      if (this.playerSeq[i] === ActionType.IDLE) {
        next = i;
        break;
      }
    }
    if (next < 0) {
      this.stopNextInputSlotHint();
      return;
    }
    if (next === this.nextInputSlotIndex && this.nextInputSlotTween) return;

    this.stopNextInputSlotHint();
    this.nextInputSlotIndex = next;
    const r = this.pSlots[next].root;
    r.setAlpha(1);
    r.setScale(1);
    this.nextInputSlotTween = this.tweens.add({
      targets: r,
      scale: { from: 0.96, to: 1.035 },
      duration: 750,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  /**
   * RESOLUTION: the active row is lit; on telegraph tick the **kaiju** side
   * is emphasized, on resolve the **player** side — so call-and-response
   * reads as kaiju → you.
   */
  private applyResolutionRowFocus(row: number, kaijuEmphasis: boolean): void {
    for (let i = 0; i < SEQ_LEN; i++) {
      if (i !== row) {
        this.styleResolutionRowDimmed(i);
      } else {
        this.styleResolutionRowCallResponse(i, kaijuEmphasis);
      }
    }
  }

  private styleResolutionRowDimmed(i: number): void {
    const u = RESOLVE_SLOT_UI;
    this.kSlots[i].root.setAlpha(u.dimRowAlpha);
    this.pSlots[i].root.setAlpha(u.dimRowAlpha);
    this.kSlots[i].root.setScale(1);
    this.pSlots[i].root.setScale(1);
    this.kSlots[i].border.setStrokeStyle(2, PAL.slotStroke, 1);
    this.pSlots[i].border.setStrokeStyle(2, PAL.slotStroke, 1);
    this.kSlots[i].border.setBlendMode(Phaser.BlendModes.NORMAL);
    this.pSlots[i].border.setBlendMode(Phaser.BlendModes.NORMAL);
  }

  /**
   * Active row: `emphasizeKaiju` — telegraph; `false` — player program resolves.
   */
  private styleResolutionRowCallResponse(
    i: number,
    emphasizeKaiju: boolean,
  ): void {
    const u = RESOLVE_SLOT_UI;
    const lead = emphasizeKaiju ? this.kSlots[i] : this.pSlots[i];
    const follow = emphasizeKaiju ? this.pSlots[i] : this.kSlots[i];
    lead.root.setAlpha(1);
    lead.root.setScale(u.leadScale);
    follow.root.setAlpha(u.followAlpha);
    follow.root.setScale(u.followScale);
    lead.border.setStrokeStyle(u.leadBorderW, 0xffffff, 1);
    lead.border.setBlendMode(Phaser.BlendModes.ADD);
    follow.border.setStrokeStyle(
      u.followBorderW,
      PAL.slotStroke,
      u.followBorderAlpha,
    );
    follow.border.setBlendMode(Phaser.BlendModes.NORMAL);
  }

  private buildRhythmIndicators(W: number, H: number): void {
    const seqY = H * 0.65;
    const sz = this.slotSz;

    // Scan cursor: ADD blend mode gives a cyber-glow feel.
    this.rhythmCursor = this.add.rectangle(0, seqY, sz + 12, sz + 12);
    this.rhythmCursor.setFillStyle();
    this.rhythmCursor.setStrokeStyle(4, PAL.cursor);
    this.rhythmCursor
      .setBlendMode(Phaser.BlendModes.ADD)
      .setVisible(false)
      .setDepth(DEPTH.rhythmCursor);

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
      seqY - sz / 2 - 28,
      W * 0.6,
      2,
      PAL.cursor,
      0,
    );
    this.beatFlash.setDepth(DEPTH.rhythmCursor);
  }

  private buildButtons(W: number, H: number): void {
    const by = H * 0.855;
    const acts: ActionType[] = [
      ActionType.ATTACK,
      ActionType.GUARD,
      ActionType.COOL,
      ActionType.SPECIAL,
    ];
    const gap = ACTION_BUTTON_ROW_GAP;
    const bh = ACTION_BUTTON_H;
    // Equal width for every action; row fits inside ~88% of the logical view.
    const rowAvail = W * 0.88;
    let bw = Phaser.Math.Clamp(
      Math.floor(
        (rowAvail - (acts.length - 1) * gap) / Math.max(1, acts.length),
      ),
      ACTION_BUTTON_MIN_W,
      ACTION_BUTTON_MAX_W,
    );
    bw = Math.max(
      ACTION_BUTTON_MIN_W_AFTER_SHRINK,
      Math.floor(bw * ACTION_BUTTON_WIDTH_SHRINK),
    );
    // Horizontal pad stays small so neighbouring tap zones just touch
    // (no overlap → no ambiguity); vertical pad is generous so thumbs
    // landing slightly above or below the button still register.
    const HIT_PAD_X = 6;
    const HIT_PAD_Y = 20;
    const totalW = acts.length * bw + (acts.length - 1) * gap;
    let cursorX = (W - totalW) / 2;

    this.btns = [];
    for (const action of acts) {
      const bx = cursorX + bw / 2;
      cursorX += bw + gap;

      const pal = this.buttonThemePalette(action);
      const bg = this.add
        .rectangle(0, 0, bw, bh, pal.on)
        .setStrokeStyle(2, pal.stroke, 1);

      const leftEdge = -bw / 2;
      const r = ACTION_BUTTON_ICON_R;
      const cx = leftEdge + ACTION_BUTTON_INNER_PAD + r;
      const textLeft = leftEdge + ACTION_BUTTON_INNER_PAD + 2 * r + ACTION_BTN_ICON_GAP;
      const icPx = Math.min(
        28,
        Math.max(20, Math.floor((r * 2 - 4) * 0.9)),
      );
      const {
        namePx,
        nameStroke,
        keyPx,
        keyStroke,
        nameLineY,
        keyLineY,
      } = computeActionButtonTextLayout(bw);
      /** Optical nudge: Material icon sits slightly high in the em box. */
      const actionIconNudgeY = Math.max(1, Math.round(icPx * 0.1));

      const iconText = this.add
        .text(0, 0, actionTheme(action).icon, {
          ...materialIconGlyphStyle(icPx, "#e6edf3", 2),
        })
        .setOrigin(0.5, 0.5)
        .setPosition(cx, actionIconNudgeY);
      const nameTxt = this.add
        .text(textLeft, nameLineY, String(action), {
          font: `900 ${namePx}px system-ui, "Segoe UI", sans-serif`,
          color: "#e6edf3",
          stroke: "#000000",
          strokeThickness: nameStroke,
          shadow: { ...HUD_SHADOW },
        })
        .setOrigin(0, 0.5);
      const keyHint = this.add
        .text(textLeft, keyLineY, ACT_KEY_HINT[action], {
          font: `800 ${keyPx}px system-ui, "Segoe UI", sans-serif`,
          color: "#b0bac8",
          stroke: "#000000",
          strokeThickness: keyStroke,
          shadow: { ...HUD_SHADOW },
        })
        .setOrigin(0, 0.5);
      const contents: Phaser.GameObjects.GameObject[] = [
        bg,
        iconText,
        nameTxt,
        keyHint,
      ];

      if (action === ActionType.SPECIAL) {
        const finGlow = this.add
          .rectangle(0, 0, bw + 18, bh + 10, 0xff9933, 0.22)
          .setStrokeStyle(3, 0xffeebb, 0.95);
        finGlow.setBlendMode(Phaser.BlendModes.ADD);
        finGlow.setVisible(false);
        this.specialFinisherGlow = finGlow;
        contents.unshift(finGlow);
      }
      const ctr = this.add
        .container(bx, by, contents)
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
          if (this.buttonsReady) bg.setFillStyle(pal.hover, 1);
        })
        .on("pointerout", () => {
          bg.setFillStyle(
            this.buttonsReady ? pal.on : pal.off,
            this.buttonsReady ? 1 : 0.5,
          );
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

    this.bossFinisherHint = this.add
      .text(
        W / 2,
        by - 58,
        "FINISH WITH SPECIAL — FINISHER REQUIRED!\n1 HP left  —  W / \u2191  or tap SPECIAL",
        {
          ...this.hudLineTextStyle(13, "#ffdd77", "900"),
          align: "center",
          lineSpacing: 4,
          wordWrap: { width: W * 0.92, useAdvancedWrap: true },
        },
      )
      .setOrigin(0.5, 1)
      .setVisible(false)
      .setDepth(12);

    this.controlGuideZab = this.add.graphics();
    this.controlGuideText = this.add
      .text(0, 0, "Tap or press WASD / arrow keys in rhythm to program your sequence.", {
        ...this.hudLineTextStyle(11, "#b8c0ce", "600"),
        align: "center",
        wordWrap: { width: W * 0.88, useAdvancedWrap: true },
      })
      .setOrigin(0.5, 0);
    this.controlGuideContainer = this.add.container(
      W / 2,
      by + bh / 2 + 20,
      [this.controlGuideZab, this.controlGuideText],
    );
    this.layoutControlGuideZab();
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
  /**
   * `KeyboardPlugin` is shared: keys + capture must be dropped on
   * {@link Phaser.Scenes.Events.SHUTDOWN} or `TitleScene` never receives WASD/arrow input.
   */
  private teardownActionKeyboard(): void {
    const kb = this.input.keyboard;
    if (!kb) return;
    try {
      kb.removeCapture("UP,DOWN,LEFT,RIGHT,W,A,S,D");
    } catch {
      // ignore: capture list may already be empty on some runtimes
    }
    kb.removeAllKeys(true);
  }

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
    const pal = this.buttonThemePalette(action);
    btn.bg.setFillStyle(pal.hover, 1);
    // Run the same press/release tweens the pointer path uses so
    // keyboard input feels identical to touch input.
    this.pressButtonTween(btn.container);
    this.time.delayedCall(90, () => {
      btn.bg.setFillStyle(
        this.buttonsReady ? pal.on : pal.off,
        this.buttonsReady ? 1 : 0.5,
      );
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
    const endless = isEndless(this.difficulty);
    const titleY = endless ? H * 0.12 : H / 2 - 76;
    const title = this.add
      .text(W / 2, titleY, "GAME OVER", {
        fontFamily: FONT,
        fontSize: "42px",
        color: "#ff4444",
        fontStyle: "bold",
      })
      .setOrigin(0.5);

    const rowY = endless ? H * 0.68 : H / 2 + 68;
    const connectY = endless ? H * 0.8 : H / 2 + 128;
    const submitY = endless ? H * 0.875 : H / 2 + 168;
    const web3StatusY = endless ? H * 0.92 : H / 2 + 202;

    if (endless) {
      const heroSize = Math.max(56, Math.min(96, Math.round(H * 0.15)));
      this.goEndlessScoreLabel = this.add
        .text(W / 2, H * 0.24, "FINAL SCORE", {
          fontFamily: FONT,
          fontSize: "15px",
          color: "#8b95a6",
          fontStyle: "bold",
        })
        .setOrigin(0.5);
      this.goEndlessScoreHero = this.add
        .text(W / 2, H * 0.33, "0", {
          fontFamily: '"Dela Gothic One", Impact, "Arial Black", sans-serif',
          fontSize: `${heroSize}px`,
          color: "#ffdd55",
          stroke: "#3a2000",
          strokeThickness: Math.max(4, Math.round(heroSize * 0.08)),
        })
        .setOrigin(0.5)
        .setShadow(0, 4, "#ff9a1f", 12, true, true);
      this.goScoreText = this.txt(W / 2, H * 0.5, "", 16, "#c4ccd8")
        .setOrigin(0.5)
        .setAlign("center");
    } else {
      this.goEndlessScoreLabel = undefined;
      this.goEndlessScoreHero = undefined;
      this.goScoreText = this.txt(W / 2, H / 2 - 8, "", 18, "#e6edf3")
        .setOrigin(0.5)
        .setAlign("center");
    }

    // Two-button row: RETRY (same difficulty) on the left,
    // BACK TO TITLE on the right. Sized for comfortable thumb taps.
    const retry = this.makeMenuButton(
      W / 2 - 110,
      rowY,
      "RETRY",
      0x2a354e,
      () => this.beginHandoffRetryFromGameOver(),
    );
    const back = this.makeMenuButton(
      W / 2 + 110,
      rowY,
      "BACK TO TITLE",
      0x1a1f2e,
      () => this.beginHandoffToTitle(),
    );

    // ---- Web3 panel ----------------------------------------------
    // Optional Ethereum score-attestation flow (OP Guild challenge).
    // Rendered below the primary retry/back row so the core loop
    // stays dominant; falls back to a plain "no wallet" status line
    // when the browser has no EIP-1193 provider injected.
    const connectBtn = this.makeMenuButton(
      W / 2,
      connectY,
      "[ Connect Web3 Wallet ]",
      0x2b3a66,
      () => this.onConnectWalletClick(),
      { width: 260, height: 36, color: "#a9c4ff" },
    );
    this.goWalletBtn = connectBtn;
    this.goWalletBtnLabel = this.menuButtonLabel(connectBtn);

    const submitBtn = this.makeMenuButton(
      W / 2,
      submitY,
      "[ Submit Score to Ethereum ]",
      0x3a2b66,
      () => this.onSubmitScoreClick(),
      { width: 260, height: 36, color: "#ffd166" },
    );
    // Hide + detach hit area so the invisible rectangle cannot
    // eat stray pointer events while the button is not in play.
    submitBtn.setVisible(false).disableInteractive();
    this.goSubmitBtn = submitBtn;

    this.goWeb3Status = this.txt(W / 2, web3StatusY, "", 12, "#8a95a8")
      .setOrigin(0.5)
      .setAlign("center");

    const goChildren: Phaser.GameObjects.GameObject[] = [dim, title];
    if (endless) {
      goChildren.push(
        this.goEndlessScoreLabel!,
        this.goEndlessScoreHero!,
      );
    }
    goChildren.push(
      this.goScoreText,
      retry,
      back,
      connectBtn,
      submitBtn,
      this.goWeb3Status,
    );
    this.goLayer = this.add.container(0, 0, goChildren);
    this.goLayer.setVisible(false).setDepth(DEPTH.gameOver);
  }

  /**
   * Reconcile the Web3 widgets with the live `wallet` singleton
   * state and the current run's submission latch. Called whenever
   * the GO overlay is shown, and after any connect/submit RPC
   * finishes, so the UI always reflects what the user can do next.
   *
   * The submit button toggles both visibility AND its input hit
   * area, so a hidden button cannot swallow a stray tap before the
   * wallet is connected.
   */
  private refreshWeb3UI(): void {
    if (!this.goWalletBtn || !this.goWalletBtnLabel || !this.goSubmitBtn) {
      return;
    }
    const addr = wallet.getAddress();
    if (addr) {
      this.goWalletBtnLabel.setText(
        `\u2713 ${WalletManager.shortAddress(addr)}`,
      );
      if (this.scoreSubmitted) {
        this.goSubmitBtn.setVisible(false).disableInteractive();
      } else {
        this.goSubmitBtn.setVisible(true);
        this.goSubmitBtn.setInteractive(
          new Phaser.Geom.Rectangle(
            -(this.goSubmitBtn.width / 2),
            -(this.goSubmitBtn.height / 2),
            this.goSubmitBtn.width,
            this.goSubmitBtn.height,
          ),
          Phaser.Geom.Rectangle.Contains,
        );
      }
    } else {
      this.goWalletBtnLabel.setText("[ Connect Web3 Wallet ]");
      this.goSubmitBtn.setVisible(false).disableInteractive();
    }
  }

  /**
   * Seed the status line with a helpful hint the first time the
   * overlay appears this run: explain that no wallet was detected
   * (so the connect button's failure isn't surprising), or note the
   * already-signed state on a restart of the same browser session.
   * Idempotent — runs every time the overlay is shown, but only
   * writes to an empty status so active messages are preserved.
   */
  private primeWeb3StatusLine(): void {
    if (!this.goWeb3Status) return;
    if (this.goWeb3Status.text.length > 0) return;
    if (!wallet.isProviderAvailable()) {
      this.setWeb3Status(
        "No Ethereum wallet detected \u2014 scores can still be saved locally.",
      );
      return;
    }
    if (this.scoreSubmitted) {
      this.setWeb3Status("Score already signed for this run.");
    }
  }

  /**
   * Short, non-disruptive status line shown under the Web3 buttons.
   * `tone: "error"` paints it red so rejection / missing-wallet cases
   * are unmissable without yanking the player out of the overlay.
   */
  private setWeb3Status(text: string, tone: "info" | "error" = "info"): void {
    if (!this.goWeb3Status) return;
    this.goWeb3Status.setText(text);
    this.goWeb3Status.setColor(tone === "error" ? "#ff9b9b" : "#8a95a8");
  }

  /**
   * Handler for the [ Connect Web3 Wallet ] button. Idempotent: if
   * the wallet is already connected, just re-syncs the UI instead of
   * re-prompting the user. The `walletBusy` latch prevents rapid
   * re-taps from queuing duplicate `eth_requestAccounts` calls while
   * the first popup is still open.
   */
  private async onConnectWalletClick(): Promise<void> {
    if (this.walletBusy) return;
    if (wallet.getAddress()) {
      this.refreshWeb3UI();
      return;
    }
    this.walletBusy = true;
    this.setWeb3Status("Opening wallet\u2026");
    try {
      const result = await wallet.connectWallet();
      if (result.ok) {
        this.setWeb3Status(
          `Wallet connected: ${WalletManager.shortAddress(result.data.address)}`,
        );
      } else if (result.code === "no-provider") {
        this.setWeb3Status(
          "No Ethereum wallet detected. Install MetaMask to submit.",
          "error",
        );
        console.warn("[Web3] connect failed:", result.message);
      } else if (result.code === "user-rejected") {
        this.setWeb3Status("Connection cancelled.", "error");
      } else {
        this.setWeb3Status(result.message, "error");
        console.warn("[Web3] connect failed:", result.message);
      }
    } finally {
      this.walletBusy = false;
      this.refreshWeb3UI();
    }
  }

  /**
   * Handler for the [ Submit Score to Ethereum ] button. Requests a
   * `personal_sign` over the run summary so the score can be verified
   * off-chain via `ecrecover` — a minimal, gas-free foundation for a
   * future on-chain leaderboard contract.
   */
  private async onSubmitScoreClick(): Promise<void> {
    if (this.walletBusy || this.scoreSubmitted) return;
    const addr = wallet.getAddress();
    if (!addr) {
      this.setWeb3Status("Connect a wallet first.", "error");
      return;
    }
    this.walletBusy = true;
    this.setWeb3Status("Awaiting signature\u2026");
    try {
      const result = await wallet.submitScore(this.score, addr);
      if (result.ok) {
        this.scoreSubmitted = true;
        this.setWeb3Status(
          `Signed at ${new Date().toLocaleTimeString()} \u00B7 ${result.data.signature.slice(
            0,
            10,
          )}\u2026`,
        );
        this.showScoreSubmittedPopup();
        console.log("[Web3] score signature:", result.data.signature);
        console.log("[Web3] signed message:", result.data.message);
      } else if (result.code === "user-rejected") {
        this.setWeb3Status("Signature cancelled.", "error");
      } else {
        this.setWeb3Status(result.message, "error");
        console.warn("[Web3] sign failed:", result.message);
      }
    } finally {
      this.walletBusy = false;
      this.refreshWeb3UI();
    }
  }

  /**
   * Gold "Score Submitted!" celebration pop. Mirrors `showPraise()`
   * visually but lives on the game-over layer depth so it does not
   * hide behind the GO dim rectangle.
   */
  private showScoreSubmittedPopup(): void {
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;
    const t = this.add
      .text(cx, cy, "Score Submitted!", {
        fontFamily: FONT,
        fontSize: "40px",
        color: "#ffd24a",
        fontStyle: "bold",
        stroke: "#3b1d00",
        strokeThickness: 6,
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.gameOver + 1)
      .setScale(0.4);

    this.tweens.add({
      targets: t,
      scale: { from: 0.4, to: 1.2 },
      duration: 260,
      ease: "Back.easeOut",
    });
    this.tweens.add({
      targets: t,
      y: cy - 80,
      alpha: { from: 1, to: 0 },
      duration: 1100,
      ease: "Sine.easeOut",
      onComplete: () => t.destroy(),
    });
  }

  /**
   * Compact "menu" button (used by the game-over overlay). Uses the
   * same press/release tween language as the combat buttons so the
   * whole game feels consistent at every layer.
   *
   * The label `Text` is attached via `setData("label", lbl)` so
   * callers can later mutate it through {@link menuButtonLabel} —
   * without relying on fragile `container.list[...]` index access.
   */
  private makeMenuButton(
    x: number,
    y: number,
    label: string,
    fill: number,
    onClick: () => void,
    opts: { width?: number; height?: number; color?: string } = {},
  ): Phaser.GameObjects.Container {
    const bw = opts.width ?? 180;
    const bh = opts.height ?? 42;
    const bg = this.add
      .rectangle(0, 0, bw, bh, fill)
      .setStrokeStyle(2, 0x3d4663);
    const lbl = this.txt(0, 0, label, 15, opts.color ?? "#e6edf3").setOrigin(
      0.5,
    );
    const ctr = this.add.container(x, y, [bg, lbl]);
    ctr.setSize(bw, bh);
    ctr.setData("label", lbl);
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
   * Typed accessor for the label `Text` attached to a menu button.
   * Centralises the `getData("label")` cast so scene code never has
   * to sprinkle `as Phaser.GameObjects.Text` at call sites.
   */
  private menuButtonLabel(
    btn: Phaser.GameObjects.Container,
  ): Phaser.GameObjects.Text | undefined {
    const v = btn.getData("label") as unknown;
    return v instanceof Phaser.GameObjects.Text ? v : undefined;
  }

  /**
   * Celebration overlay for a completed EASY / NORMAL run. Big gold
   * headline, clear-time readout, wave/boss/giga summary. Tap / key / auto
   * timer hand off via {@link beginHandoffToTitle}.
   */
  private showGameClearOverlay(timeMs: number): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;
    const cy = H * 0.44;
    const d = DEPTH.gameOver;

    audio.playGameClear();

    this.cameras.main.resetFX();
    this.cameras.main.flash(180, 255, 245, 190, true);
    this.cameras.main.shake(280, 0.006);
    const cam = this.cameras.main;
    this.tweens.add({
      targets: cam,
      zoom: { from: 1, to: 1.035 },
      duration: 420,
      ease: "Sine.easeOut",
      yoyo: true,
      onComplete: () => {
        cam.setZoom(1);
      },
    });

    const dim = this.add
      .rectangle(0, 0, W, H, 0x020a18, 0.52)
      .setOrigin(0)
      .setDepth(d);
    const dim2 = this.add
      .rectangle(0, 0, W, H, 0x000000, 0.4)
      .setOrigin(0)
      .setDepth(d);
    // Block pass-through clicks while the clear overlay plays (topmost layer).
    dim2.setInteractive();

    const warmGlow = this.add
      .circle(cx, cy, Math.max(W, H) * 0.38, 0xffaa44, 0.12)
      .setDepth(d)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setAlpha(0);
    this.tweens.add({
      targets: warmGlow,
      alpha: { from: 0.08, to: 0.24 },
      scale: { from: 0.92, to: 1.08 },
      duration: 900,
      yoyo: true,
      repeat: 2,
      ease: "Sine.easeInOut",
    });

    const rayGr = this.add.graphics().setDepth(d).setBlendMode(Phaser.BlendModes.ADD);
    const rayLen = Math.max(W, H) * 0.52;
    rayGr.lineStyle(2.5, 0xffe8aa, 0.32);
    for (let i = 0; i < 20; i++) {
      const a = (i / 20) * Math.PI * 2;
      rayGr.lineBetween(0, 0, Math.cos(a) * rayLen, Math.sin(a) * rayLen);
    }
    const rayPivot = this.add.container(cx, cy, [rayGr]);
    rayPivot.setDepth(d).setAlpha(0);
    this.tweens.add({
      targets: rayPivot,
      alpha: 0.5,
      duration: 600,
    });
    this.tweens.add({
      targets: rayPivot,
      angle: 360,
      duration: 36000,
      repeat: -1,
      ease: "Linear",
    });
    this.tweens.add({
      targets: rayPivot,
      scaleX: 1.2,
      scaleY: 1.2,
      duration: 1400,
      yoyo: true,
      repeat: 3,
      ease: "Sine.easeInOut",
    });

    const burstTint = [0xffee55, 0xffffff, 0xffaa33, 0x66e8ff, 0xffccff] as const;
    for (let b = 0; b < 5; b++) {
      this.time.delayedCall(120 * b, () => {
        for (let k = 0; k < 3; k++) {
          const ang = (k / 3) * Math.PI * 2 + b * 0.4;
          const px = cx + Math.cos(ang) * 40;
          const py = cy + Math.sin(ang) * 28;
          this.emitGameClearSparkBurst(
            px,
            py,
            burstTint[(b + k) % burstTint.length]!,
            0.5 + b * 0.12,
          );
        }
      });
    }
    for (let r = 0; r < 4; r++) {
      const ring = this.add
        .circle(cx, cy, 36 + r * 22, 0xffcc22, 0.35)
        .setDepth(d + 1)
        .setBlendMode(Phaser.BlendModes.ADD);
      this.tweens.add({
        targets: ring,
        delay: r * 90,
        scale: { from: 0.2, to: 2.4 + r * 0.25 },
        alpha: { from: 0.55, to: 0 },
        duration: 700 + r * 80,
        ease: "Cubic.easeOut",
        onComplete: () => ring.destroy(),
      });
    }

    const modeLabel = DIFFICULTY_CONFIGS[this.difficulty].label;
    const badge = this.add
      .text(
        cx,
        cy - 108,
        `${modeLabel}  MODE  CLEARED`,
        {
          fontFamily: FONT,
          fontSize: "17px",
          color: "#9ef5ff",
          fontStyle: "bold",
          stroke: "#002030",
          strokeThickness: 5,
        },
      )
      .setOrigin(0.5)
      .setDepth(d + 2)
      .setAlpha(0);

    const title = this.add
      .text(cx, cy - 48, "GAME CLEAR", {
        fontFamily: '"Dela Gothic One", Impact, "Arial Black", sans-serif',
        fontSize: "60px",
        color: "#ffee55",
        stroke: "#4a2a00",
        strokeThickness: 9,
      })
      .setOrigin(0.5)
      .setDepth(d + 2)
      .setScale(0.5);

    const mm = Math.floor(timeMs / 60000);
    const ss = Math.floor((timeMs % 60000) / 1000)
      .toString()
      .padStart(2, "0");
    const sub = this.add
      .text(
        cx,
        cy + 32,
        `TIME  ${mm}:${ss}`,
        {
          fontFamily: FONT,
          fontSize: "24px",
          color: "#f0f4fc",
          fontStyle: "bold",
        },
      )
      .setOrigin(0.5)
      .setDepth(d + 2);

    const stats = this.add
      .text(
        cx,
        cy + 72,
        `Waves ${this.wave}  \u00B7  Bosses ${this.bossesDefeated}` +
          `  \u00B7  Gigas ${this.gigasDefeated}`,
        {
          fontFamily: FONT,
          fontSize: "16px",
          color: "#a8b0bc",
        },
      )
      .setOrigin(0.5)
      .setDepth(d + 2);

    const starGlyph = MATERIAL_ICON_GLYPH.star;
    const stars = `${starGlyph}  ${starGlyph}  ${starGlyph}`;
    const row = this.add
      .text(cx, cy + 110, stars, {
        ...materialIconGlyphStyle(22, "#ffd24a", 1),
      })
      .setOrigin(0.5)
      .setDepth(d + 2)
      .setScale(0.3);

    const hint = this.add
      .text(
        cx,
        H - 36,
        "Tap, click, or any key to continue  ·  or wait to return",
        {
          fontFamily: FONT,
          fontSize: "13px",
          color: "#7d8694",
          align: "center",
        },
      )
      .setOrigin(0.5)
      .setDepth(d + 2);

    this.tweens.add({
      targets: title,
      scale: { from: 0.5, to: 1 },
      duration: 520,
      ease: "Back.easeOut",
    });
    this.tweens.add({
      targets: badge,
      alpha: 1,
      duration: 400,
      delay: 200,
    });
    this.tweens.add({
      targets: row,
      scale: 1,
      duration: 500,
      delay: 350,
      ease: "Back.easeOut",
    });
    this.tweens.add({
      targets: row,
      angle: { from: -6, to: 6 },
      duration: 350,
      yoyo: true,
      repeat: 1,
      delay: 400,
    });
    this.time.delayedCall(450, () => audio.playClick({ volume: 0.45 }));
    [dim, dim2, sub, stats, hint, row].forEach((o) => {
      o.setAlpha(0);
      this.tweens.add({ targets: o, alpha: 1, duration: 420 });
    });

    // Full-screen, above text so the player can skip the auto-timer without hunting UI.
    const tapToContinue = this.add
      .rectangle(0, 0, W, H, 0x000000, 0)
      .setOrigin(0)
      .setScrollFactor(0)
      .setDepth(d + 30);
    tapToContinue.setInteractive({ useHandCursor: true });
    tapToContinue.on("pointerdown", () => {
      this.trySkipGameClearToTitle();
    });
  }

  /** Dense spark cloud for the game-clear screen (gold / white / cyan tints). */
  private emitGameClearSparkBurst(
    x: number,
    y: number,
    tint: number,
    speedMul: number,
  ): void {
    const emitter = this.add.particles(x, y, "spark", {
      speed: { min: 90 * speedMul, max: 320 * speedMul },
      angle: { min: 0, max: 360 },
      scale: { start: 2.1, end: 0 },
      tint,
      lifespan: 520,
      quantity: 18,
      emitting: false,
    });
    emitter.setDepth(DEPTH.gameOver + 2);
    emitter.setBlendMode(Phaser.BlendModes.ADD);
    emitter.explode(18);
    this.time.delayedCall(700, () => emitter.destroy());
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
      this.phaseHudContainer,
      this.scoreHudPanel,
      ...this.btns.map((b) => b.container),
    ];
    this.bounceTargets = items.map((obj) => ({
      obj,
      baseScale: obj.scaleX,
    }));
  }

  /**
   * Canvas text can cache the wrong bitmap if "Material Icons" is not ready
   * on the first `updateText()` pass. Re-run after `document.fonts` settles.
   */
  private scheduleMaterialIconRasterRefresh(): void {
    const bump = (): void => {
      if (!this.scene.isActive()) return;
      this.refreshMaterialIconTexts();
    };
    void loadMaterialIconsFont(40).then(bump).catch(bump);
    if (typeof document !== "undefined" && document.fonts?.ready) {
      void document.fonts.ready.then(bump).catch(bump);
    }
    this.time.delayedCall(0, bump);
  }

  /** Depth-first walk: refresh any Text whose style uses Material Icons. */
  private refreshMaterialIconTexts(): void {
    const visit = (go: Phaser.GameObjects.GameObject): void => {
      if (go instanceof Phaser.GameObjects.Text) {
        const fam = go.style.fontFamily ?? "";
        if (fam.includes("Material Icons")) {
          go.updateText();
        }
      }
      if (go instanceof Phaser.GameObjects.Container) {
        go.iterate((child: Phaser.GameObjects.GameObject) => {
          visit(child);
        });
      }
    };
    this.children.each((child: Phaser.GameObjects.GameObject) => {
      visit(child);
    });
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

  /**
   * 下半分のコントロールデッキ用背景。不透明度を上げて手前の
   * 白文字を浮かせる。
   */
  private buildControlDeckBack(W: number, H: number): void {
    const y0 = H * 0.52;
    const h = H - y0;
    this.add
      .rectangle(W / 2, y0 + h / 2, W, h, 0x05070c, 0.82)
      .setStrokeStyle(1, 0x2a3848, 0.65)
      .setDepth(-2);
  }

  /**
   * Top-right: Material `skull` + kill count (gold) + WAVE line; autoscale when
   * the row exceeds ~80% of the panel inner width.
   */
  private buildScoreHud(): void {
    const padX = 12;
    const padY = 8;

    this.scoreHudPanel = this.add.container(this.scale.width - 16, 12);
    this.scoreHudPanel.setName("scoreHud");

    this.scoreHudBg = this.add.graphics();
    this.scoreHudBg.setName("scoreHudZab");

    this.scoreKillsNumber = this.add
      .text(0, 0, "0", {
        ...this.hudLineTextStyle(17, SCORE_GOLD, "900"),
      })
      .setOrigin(1, 0);
    this.scoreKillsGlyph = this.add
      .text(0, 0, MATERIAL_ICON_GLYPH.scoreKills, {
        ...materialIconGlyphStyle(19, SCORE_GOLD, 2),
      })
      .setOrigin(1, 0);
    const killGap = 6;
    this.scoreKillsRow = this.add.container(-padX, padY, [
      this.scoreKillsGlyph,
      this.scoreKillsNumber,
    ]);
    this.layoutScoreKillsGlyphX(killGap);

    this.scoreWaveText = this.add
      .text(-padX, padY + 20, "WAVE", {
        ...this.hudLineTextStyle(12, "#c4ccd8", "800"),
      })
      .setOrigin(1, 0);

    this.scoreHudPanel.add([
      this.scoreHudBg,
      this.scoreKillsRow,
      this.scoreWaveText,
    ]);
  }

  /** Keeps the skull glyph tucked left of the numeric score (right-aligned row). */
  private layoutScoreKillsGlyphX(gap: number): void {
    this.scoreKillsGlyph.setPosition(
      -this.scoreKillsNumber.width - gap,
      0,
    );
  }

  private layoutScoreHud(): void {
    if (!this.scoreKillsRow?.active || !this.scoreWaveText?.active) return;

    const W = this.scale.width;
    this.scoreHudPanel.setX(W - 16);

    const maxPanelW = Math.min(220, W * 0.3);
    const padX = 12;
    const padY = 8;

    const killGap = 6;
    this.scoreKillsNumber.setText(String(this.score));
    this.layoutScoreKillsGlyphX(killGap);

    let kfs = 17;
    const setKillStyle = (fs: number): void => {
      this.scoreKillsNumber.setStyle({
        font: `900 ${fs}px system-ui, "Segoe UI", sans-serif`,
        color: SCORE_GOLD,
        stroke: "#000000",
        strokeThickness: HUD_STROKE_THICK,
        shadow: { ...HUD_SHADOW },
      });
    };
    const setGlyphStyle = (fs: number): void => {
      this.scoreKillsGlyph.setStyle({
        ...materialIconGlyphStyle(fs, SCORE_GOLD, Math.max(1, Math.floor(fs * 0.1))),
      });
    };
    setKillStyle(kfs);
    setGlyphStyle(Math.round(kfs * 1.08));
    this.layoutScoreKillsGlyphX(killGap);

    const cap = this.maxWave;
    if (cap === Infinity) {
      this.scoreWaveText.setText(`WAVE ${Math.max(1, this.wave)}`);
    } else {
      const shown = Math.min(Math.max(1, this.wave), cap);
      this.scoreWaveText.setText(`WAVE ${shown}/${cap}`);
    }
    const setWaveStyle = (fs: number): void => {
      this.scoreWaveText.setStyle({
        font: `800 ${fs}px system-ui, "Segoe UI", sans-serif`,
        color: "#c4ccd8",
        stroke: "#000000",
        strokeThickness: HUD_STROKE_THICK,
        shadow: { ...HUD_SHADOW },
      });
    };
    let wfs = 12;
    setWaveStyle(wfs);

    const killRowW0 =
      this.scoreKillsGlyph.width + killGap + this.scoreKillsNumber.width;
    const bodyW = Math.min(
      maxPanelW,
      Math.max(killRowW0, this.scoreWaveText.width) + padX * 2,
    );
    const bodyH =
      padY * 2 +
      Math.max(this.scoreKillsGlyph.height, this.scoreKillsNumber.height) +
      4 +
      this.scoreWaveText.height;
    const innerMax = bodyW * 0.8;

    let killRowW =
      this.scoreKillsGlyph.width + killGap + this.scoreKillsNumber.width;
    while (killRowW > innerMax && kfs > 8) {
      kfs -= 1;
      setKillStyle(kfs);
      setGlyphStyle(Math.round(kfs * 1.08));
      this.layoutScoreKillsGlyphX(killGap);
      killRowW =
        this.scoreKillsGlyph.width + killGap + this.scoreKillsNumber.width;
    }
    while (this.scoreWaveText.width > innerMax && wfs > 7) {
      wfs -= 1;
      setWaveStyle(wfs);
    }

    this.scoreHudBg.clear();
    this.scoreHudBg.fillStyle(0x000000, ZABUTON_ALPHA);
    this.scoreHudBg.fillRoundedRect(
      -bodyW,
      0,
      bodyW,
      bodyH,
      ZABUTON_RADIUS,
    );
  }

  private createStepIndexPair(
    x: number,
    y: number,
    num: string,
    col: "k" | "p",
  ): StepIndexUI {
    const baseColor = col === "k" ? STEP_INACTIVE : "#5a7a8a";
    const main = this.add
      .text(0, 0, num, {
        font: `800 12px system-ui, "Segoe UI", sans-serif`,
        color: baseColor,
        stroke: "#05080c",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 0.5)
      .setPosition(0, 0)
      .setAlpha(col === "k" ? 0.38 : 0.42);
    const container = this.add.container(x, y, [main]);
    return { container, main, col };
  }

  private setStepIndexVisual(
    pair: StepIndexUI,
    col: "k" | "p",
    active: boolean,
  ): void {
    const { main } = pair;
    if (active) {
      if (col === "k") {
        main.setAlpha(0.95);
        main.setStyle({
          font: `900 13px system-ui, "Segoe UI", sans-serif`,
          color: "#ffccb0",
          stroke: "#000000",
          strokeThickness: 4,
        });
      } else {
        main.setAlpha(0.95);
        main.setStyle({
          font: `900 13px system-ui, "Segoe UI", sans-serif`,
          color: "#a8f0ff",
          stroke: "#000000",
          strokeThickness: 4,
        });
      }
    } else {
      const baseColor = col === "k" ? STEP_INACTIVE : "#5a7a8a";
      main
        .setAlpha(col === "k" ? 0.35 : 0.4)
        .setColor(baseColor)
        .setStyle({
          font: `800 12px system-ui, "Segoe UI", sans-serif`,
          color: baseColor,
          stroke: "#05080c",
          strokeThickness: 3,
        });
    }
  }

  private refreshSequencerStepHighlight(beat: number): void {
    for (let i = 0; i < SEQ_LEN; i++) {
      const k = this.stepIndexK[i];
      const p = this.stepIndexP[i];
      if (k) this.setStepIndexVisual(k, "k", false);
      if (p) this.setStepIndexVisual(p, "p", false);
    }
    if (beat < 0) return;
    if (beat < SEQ_LEN) {
      const p = this.stepIndexK[beat];
      if (p) this.setStepIndexVisual(p, "k", true);
    } else {
      const pi = beat - SEQ_LEN;
      if (pi >= 0 && pi < SEQ_LEN) {
        const p = this.stepIndexP[pi];
        if (p) this.setStepIndexVisual(p, "p", true);
      }
    }
  }

  /* ============================================================ */
  /*  Beat-count rhythm driver                                      */
  /* ============================================================ */

  private updateRhythm(): void {
    const elapsed = this.time.now - this.rhythmStartTime;

    if (elapsed < 0) return;

    if (!this.buttonsReady) {
      const earlyEnable = SEQ_LEN * this.rhythmMs - RHYTHM.INPUT_WINDOW_MS;
      if (elapsed >= earlyEnable) {
        this.buttonsReady = true;
        this.enableButtons(true);
      }
    }

    const currentBeat = Math.floor(elapsed / this.rhythmMs);

    while (
      this.lastProcessedBeat < currentBeat &&
      this.lastProcessedBeat < TOTAL_BEATS - 1
    ) {
      this.lastProcessedBeat++;
      this.onRhythmBeat(this.lastProcessedBeat);
    }

    if (!this.rhythmEnded && this.lastProcessedBeat >= TOTAL_BEATS - 1) {
      const lastWindowEnd = (TOTAL_BEATS - 1) * this.rhythmMs + RHYTHM.INPUT_WINDOW_MS;
      if (elapsed > lastWindowEnd) {
        this.rhythmEnded = true;
        this.endRhythmSequence();
      }
    }
  }

  /* ============================================================ */
  /*  Game flow                                                     */
  /* ============================================================ */

  /**
   * Wave 1 開始前に "READY" を 2 拍分表示してプレイヤーに準備の猶予を与える。
   * この間は `GamePhase.INTRO_READY` のため `updateRhythm()` は走らない。
   * READY が消えたあと `beginWave()` → `startRhythmSequence()` で初めて
   * 相手ターン（リズム）が始まる。
   */
  private showReadyThenBeginWave(): void {
    const W = this.scale.width;
    const H = this.scale.height;

    const readyText = this.add
      .text(W / 2, H / 2, "READY", {
        fontFamily: '"Dela Gothic One", Impact, "Arial Black", sans-serif',
        fontSize: "80px",
        color: "#ffcc00",
        stroke: "#000000",
        strokeThickness: 8,
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.gameOver)
      .setAlpha(0)
      .setScale(1.4);

    this.tweens.add({
      targets: readyText,
      alpha: 1,
      scale: 1,
      duration: 320,
      ease: "Back.easeOut",
      onComplete: () => {
        // 2 拍 (= 2 × rhythmMs) 表示してから消す
        this.time.delayedCall(this.rhythmMs * 2, () => {
          this.tweens.add({
            targets: readyText,
            alpha: 0,
            y: H / 2 - 50,
            duration: 380,
            ease: "Sine.easeIn",
            onComplete: () => {
              readyText.destroy();
              this.beginWave();
            },
          });
        });
      },
    });
  }

  private beginWave(): void {
    this.wave += 1;
    this.syncBeatDuration();
    if (this.wave === 1) {
      // Anchor the run clock on the very first wave of the encounter.
      // `resetState()` already zeroes this, but reading `time.now` here
      // keeps the accounting correct after scene restarts where create()
      // and beginWave may land on different frames.
      this.runStartTime = this.time.now;
    }
    const rank = pickKaijuRank(this.wave);
    if (rank === "boss" || rank === "giga") {
      this.showBossGigaWarning(rank, () => this.continueBeginWave(rank));
    } else {
      this.continueBeginWave(rank);
    }
  }

  /**
   * Shared body of `beginWave` after optional WARNING overlay for boss/giga
   * waves (called immediately for zako, or after the alert dismisses).
   */
  private continueBeginWave(rank: KaijuRank): void {
    this.wavePerfectCount = 0;
    this.resetCombo();
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
   * Shown the moment a boss or giga encounter begins — right after the
   * previous wave is cleared, before the rhythm phase for the new rank.
   * Click or auto-timeout dismisses; does not change game state.
   */
  private showBossGigaWarning(
    rank: KaijuRank,
    onComplete: () => void,
  ): void {
    const W = this.scale.width;
    const H = this.scale.height;

    const isGiga = rank === "giga";
    // Boss: WARNING / Giga: EMERGENCY — different headline vocabulary.
    const head = isGiga ? "EMERGENCY" : "WARNING";
    const sub1 = isGiga ? "GIGA" : "BOSS";
    const sub2 = isGiga
      ? "SEISMIC-CLASS  THREAT  DETECTED"
      : "HEAVY-ARMOR  BATTLE  IMMINENT";
    const headColor = isGiga ? "#ffeedd" : "#ffcc00";
    const headStroke = isGiga ? "#4a0000" : "#1a0a00";

    const dim = this.add
      .rectangle(0, 0, W, H, 0x000000, 0.58)
      .setOrigin(0)
      .setDepth(DEPTH.rankWarning);

    const line1 = this.add
      .text(W / 2, H * 0.38, head, {
        fontFamily: '"Dela Gothic One", Impact, "Arial Black", sans-serif',
        fontSize: isGiga ? "40px" : "38px",
        color: headColor,
        stroke: headStroke,
        strokeThickness: 6,
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.rankWarning)
      .setAlpha(0);

    const line2 = this.add
      .text(W / 2, H * 0.48, sub1, {
        fontFamily: '"Dela Gothic One", Impact, "Arial Black", sans-serif',
        fontSize: "52px",
        color: isGiga ? "#ff55aa" : "#ff5555",
        stroke: "#200008",
        strokeThickness: 8,
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.rankWarning)
      .setAlpha(0)
      .setScale(0.9);

    const line3 = this.add
      .text(W / 2, H * 0.6, sub2, {
        fontFamily: FONT,
        fontSize: "14px",
        color: "#8b949e",
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.rankWarning)
      .setAlpha(0);

    this.tweens.add({
      targets: [line1, line2, line3],
      alpha: 1,
      duration: 220,
    });
    this.tweens.add({
      targets: line2,
      scale: 1,
      duration: 360,
      ease: "Back.easeOut",
    });

    // Pulse the WARNING / EMERGENCY headline
    this.tweens.add({
      targets: line1,
      alpha: { from: 0.85, to: 1 },
      duration: 420,
      yoyo: true,
      repeat: 2,
      ease: "Sine.easeInOut",
    });

    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      this.tweens.add({
        targets: [line1, line2, line3, dim],
        alpha: 0,
        duration: 200,
        onComplete: () => {
          line1.destroy();
          line2.destroy();
          line3.destroy();
          dim.destroy();
          onComplete();
        },
      });
    };

    dim.setInteractive();
    dim.once("pointerdown", finish);

    this.time.delayedCall(2400, () => finish());
  }

  /**
   * Re-roll weather when we cross a phase boundary, then compose the
   * per-slot mask for this wave. Two noise sources are OR-ed together:
   *
   *  1. Sand weather picks one guaranteed slot to fog up.
   *  2. Once `this.wave >= KAIJU_BASELINE_NOISE_WAVE`, each slot
   *     independently rolls a 20% chance to be masked.
   *
   *  3. If more than `KAIJU_MASK_MAX_CONCURRENT` slots would be masked,
   *     extras are **dropped** at random, but a sand-weather pick is
   *     **kept** when possible.
   *
   * Rolling once per wave keeps the fog stable while the player is
   * programming their response, and unpredictable between encounters.
   */
  private rollWeatherForWave(): void {
    const phaseIdx = phaseIndexForWave(this.wave);
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
    this.kaijuNoiseMask = this.capKaijuNoiseMask(mask, sandIdx);
  }

  /**
   * Enforces a maximum number of `???` slots. Prefers keeping the
   * sand-weather slot when it was part of the proposed mask, then
   * fills the remainder from other masked slots at random.
   */
  private capKaijuNoiseMask(
    mask: boolean[],
    sandSlot: number,
  ): boolean[] {
    const trues: number[] = [];
    for (let i = 0; i < SEQ_LEN; i++) {
      if (mask[i]) trues.push(i);
    }
    if (trues.length <= KAIJU_MASK_MAX_CONCURRENT) {
      return mask;
    }
    const out: boolean[] = new Array(SEQ_LEN).fill(false);
    const kept = new Set<number>();
    if (sandSlot >= 0 && mask[sandSlot]) {
      out[sandSlot] = true;
      kept.add(sandSlot);
    }
    const rest = trues.filter((i) => !kept.has(i));
    Phaser.Utils.Array.Shuffle(rest);
    for (const i of rest) {
      if (kept.size >= KAIJU_MASK_MAX_CONCURRENT) break;
      out[i] = true;
      kept.add(i);
    }
    return out;
  }

  /** Convenience accessor so consumers never touch the table directly. */
  private weatherEffect(): WeatherEffect {
    return WEATHER_EFFECTS[this.currentWeather];
  }

  /** Paint the top-left weather shelf with the current mood + summary. */
  private refreshWeatherHUD(): void {
    const eff = this.weatherEffect();
    this.weatherIcon.setText(getWeatherIconGlyph(this.currentWeather));
    this.weatherIcon.setColor(eff.color);
    this.weatherLabel.setText(`WEATHER: ${eff.label}`).setColor(eff.color);
    this.weatherDetailLabel.setText(eff.hudDetail);
    this.layoutWeatherZabBlock();
  }

  /* ---- Combat modifier helpers ---- */
  /*                                                                 */
  /* Thin wrappers around the pure helpers in src/config/weather.ts. */
  /* They read the current weather once so the call sites inside    */
  /* executeCombat stay compact and free of repeated lookups.       */

  private weatherAdjAtkDmg(base: number): number {
    return adjustAttackDmg(base, this.weatherEffect());
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
    this.layoutZabutonBehindText(
      this.kaijuLabel,
      this.kaijuLabelZab,
      ZABUTON_PAD,
    );
    this.currentKaijuRank = rank;
    audio.setCombatBgmKaijuRank(rank);
  }

  /* ---- Rhythm phase (Foreshadow + Programming, 8 beats) ---- */

  /**
   * Kick off a fresh rhythm phase. `leadInMs` controls the gap before
   * the first beat fires — `this.rhythmMs` (default) gives the player a
   * full beat of breathing room when a new kaiju appears, while a tighter
   * value is used when looping back after a resolve phase against the same
   * kaiju so the encounter flows without dead time.
   */
  private startRhythmSequence(leadInMs?: number): void {
    const lead = leadInMs ?? this.rhythmMs;
    this.phase = GamePhase.RHYTHM_KAIJU;
    this.setPhaseDisplay(
      "READING",
      "#ffcc00",
      MATERIAL_ICON_GLYPH.phaseReading,
      PHASE_FLOW.readingLabel.text,
      PHASE_FLOW.readingLabel.color,
    );
    this.clearSlots();
    this.enableButtons(false);
    this.buttonsReady = false;

    this.kaijuSeq = Array.from({ length: SEQ_LEN }, () =>
      Phaser.Math.RND.pick(KAIJU_POOL),
    );
    this.playerSeq = Array.from({ length: SEQ_LEN }, () => ActionType.IDLE);
    this.rhythmInputQuality = [null, null, null, null];
    this.rhythmEnded = false;
    this.beatPulseIndex = 0;

    this.rhythmStartTime = this.time.now + lead;
    this.lastProcessedBeat = -1;

    this.rhythmCursor.setPosition(
      this.kSlots[0].root.x,
      this.kSlots[0].root.y,
    );
    this.refreshSequencerStepHighlight(-1);

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
      this.setPhaseFromHint(phaseFlowKaijuBeat(beat, SEQ_LEN));
    } else {
      const pIdx = beat - SEQ_LEN;

      if (beat === SEQ_LEN) {
        this.phase = GamePhase.RHYTHM_PLAYER;
        this.setPhaseDisplay(
          "PROGRAM",
          "#44cc88",
          MATERIAL_ICON_GLYPH.phaseProgram,
          PHASE_FLOW.programLabel.text,
          PHASE_FLOW.programLabel.color,
        );
        this.setPlayerConsoleRimLively(true);
        if (!this.buttonsReady) {
          this.buttonsReady = true;
          this.enableButtons(true);
        }
      }

      this.setPhaseFromHint(phaseFlowPlayerInput(pIdx, SEQ_LEN));

      this.moveCursorTo(this.pSlots[pIdx]);
      this.startTimingBar(this.pSlots[pIdx]);
      this.pSlots[pIdx].border.setStrokeStyle(3, PAL.cursor);

      if (this.playerSeq[pIdx] !== ActionType.IDLE) {
        this.showSlotInput(pIdx, this.playerSeq[pIdx]);
      }

      console.log(`[Rhythm] Slot ${pIdx} active`);
    }
    this.refreshSequencerStepHighlight(beat);
    if (beat >= SEQ_LEN) {
      this.refreshNextInputSlotHint();
    }
  }

  private endRhythmSequence(): void {
    this.stopNextInputSlotHint();
    this.refreshSequencerStepHighlight(-1);
    this.finalizeSlotInput(SEQ_LEN - 1);
    this.rhythmCursor.setVisible(false);
    this.timingBar.setVisible(false);
    this.enableButtons(false);
    this.buttonsReady = false;
    this.setPlayerConsoleRimLively(false);

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
    s.themeTint.setFillStyle(col, 1);
    s.themeTint.setAlpha(THEME_TINT_ALPHA);
    s.border.setStrokeStyle(2, col, 1);
    if (masked) {
      s.icon.setVisible(false);
      s.label
        .setVisible(true)
        .setFontSize(KAIJU_NOISE_FONT_PX)
        .setText(KAIJU_NOISE_TEXT);
    } else {
      s.label.setVisible(false);
      s.icon.setVisible(true).setText(actionTheme(action).icon);
      this.centerSlotActionIcon(s.icon);
    }
    this.reflowSlotLabelZab(s);
    s.root.setAlpha(0);
    this.tweens.add({
      targets: s.root,
      alpha: { from: 0, to: 1 },
      duration: 180,
    });
  }

  private moveCursorTo(slot: SlotUI): void {
    // Expo.easeOut gives an instant "snap" that reads as the cursor
    // locking onto the current beat with mechanical precision.
    this.tweens.add({
      targets: this.rhythmCursor,
      x: slot.root.x,
      y: slot.root.y,
      duration: 110,
      ease: "Expo.easeOut",
    });
    this.tweens.add({
      targets: this.rhythmCursor,
      scaleX: { from: 1.3, to: 1 },
      scaleY: { from: 1.3, to: 1 },
      duration: 220,
      ease: "Back.easeOut",
    });
  }

  private startTimingBar(slot: SlotUI): void {
    this.tweens.killTweensOf(this.timingBar);
    const x = slot.root.x - this.slotSz / 2;
    const y = slot.root.y + this.slotSz / 2 - 2;
    this.timingBar.setPosition(x, y);
    this.timingBar.setScale(0, 1);
    this.timingBar.setVisible(true).setAlpha(0.8);
    this.tweens.add({
      targets: this.timingBar,
      scaleX: 1,
      duration: this.rhythmMs,
      ease: "Linear",
    });
  }

  private finalizeSlotInput(idx: number): void {
    if (idx < 0 || idx >= SEQ_LEN) return;

    if (this.playerSeq[idx] === ActionType.IDLE) {
      this.resetCombo();
      const s = this.pSlots[idx];
      s.icon.setVisible(false);
      s.label
        .setVisible(true)
        .setText("MISS")
        .setColor("#ff4444");
      s.themeTint.setFillStyle(PAL.miss, 1);
      s.themeTint.setAlpha(0.25);
      this.reflowSlotLabelZab(s);

      this.time.delayedCall(350, () => {
        s.label.setVisible(false);
        s.icon.setText(actionTheme(ActionType.IDLE).icon).setVisible(true);
        this.centerSlotActionIcon(s.icon);
        s.themeTint.setFillStyle(ACT_COL[ActionType.IDLE], 1);
        s.themeTint.setAlpha(THEME_TINT_ALPHA);
        s.border.setStrokeStyle(2, ACT_COL[ActionType.IDLE], 1);
        this.reflowSlotLabelZab(s);
      });

      console.log(`[Rhythm] Slot ${idx}: MISS`);
    }

    this.timingBar.setVisible(false);
  }

  /* ---- Input with timing window ---- */

  private onActionClick(action: ActionType): void {
    if (!this.isRhythmPhase()) return;

    const now = this.time.now;
    const resolved = resolvePlayerRhythmInput(
      now,
      this.rhythmStartTime,
      this.rhythmMs,
      SEQ_LEN,
      RHYTHM.INPUT_WINDOW_MS,
    );
    if (!resolved) return;
    const { pIdx, absOffsetMs: offset, beatCenterTime } = resolved;
    if (this.playerSeq[pIdx] !== ActionType.IDLE) return;

    const timing = classifyRhythmInputOffset(offset);

    this.playerSeq[pIdx] = action;
    this.rhythmInputQuality[pIdx] = timing;
    if (timing === "PERFECT") {
      this.comboCount += 1;
      this.wavePerfectCount += 1;
      this.playerHeat = Math.max(0, this.playerHeat - HEAT_BONUS.PERFECT_RELIEF);
      if (this.comboCount >= 2) {
        this.spawnChainComboPop();
      }
    } else {
      this.resetCombo();
    }

    this.spawnRhythmTimingFeedback(pIdx, timing);
    this.refreshHUD();

    if (this.lastProcessedBeat >= pIdx + SEQ_LEN) {
      this.showSlotInput(pIdx, action);
    }

    this.refreshNextInputSlotHint();
    console.log(
      `[Rhythm] Slot ${pIdx}: ${action} (${timing}, ${offset.toFixed(0)}ms, centre=${beatCenterTime.toFixed(0)})`,
    );
  }

  private showSlotInput(pIdx: number, action: ActionType): void {
    const s = this.pSlots[pIdx];
    const q = this.rhythmInputQuality[pIdx] ?? "GOOD";
    this.rhythmInputQuality[pIdx] = null;

    this.tweens.killTweensOf(s.root);
    this.tweens.killTweensOf(s.icon);
    s.root.setScale(1);
    s.icon.setScale(1);

    s.label.setVisible(false);
    s.icon.setVisible(true).setText(actionTheme(action).icon);
    this.centerSlotActionIcon(s.icon);
    s.themeTint.setFillStyle(ACT_COL[action], 1);
    s.themeTint.setAlpha(THEME_TINT_HEAVY);
    // Border snaps to pure white for the punch-in frame, then eases
    // back to the action-tinted stroke so the slot reads as "locked".
    s.border.setStrokeStyle(3, 0xffffff);
    this.time.delayedCall(160, () => {
      s.border.setStrokeStyle(2, ACT_COL[action], 1);
    });
    this.reflowSlotLabelZab(s);

    this.tweens.add({
      targets: s.icon,
      scaleX: 1.3,
      scaleY: 1.3,
      duration: 100,
      ease: "Cubic.easeOut",
      yoyo: true,
    });

    // Input bloom: PERFECT already has a gold burst; GOOD keeps a softer flash.
    if (q !== "PERFECT") {
      const fa = q === "GOOD" ? 0.38 : 0.9;
      const flash = this.add
        .rectangle(
          s.root.x,
          s.root.y,
          this.slotSz,
          this.slotSz,
          0xffffff,
          fa,
        )
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
    }

    this.tweens.add({
      targets: s.root,
      scaleX: { from: 0.8, to: 1 },
      scaleY: { from: 0.8, to: 1 },
      duration: 120,
      ease: "Back.easeOut",
    });
  }

  private pulseBeat(): void {
    this.beatPulseIndex++;
    const em = this.isEmergencyMode;
    audio.playBeat({
      pitchMul: em ? PULSE.EMERGENCY_BEAT_PITCH_MUL : 1,
    });
    if (em && this.beatPulseIndex % PULSE.EMERGENCY_OVERHEAT_INTERVAL === 0) {
      audio.playOverheat({ pan: 0, volume: PULSE.EMERGENCY_OVERHEAT_VOLUME });
    }
    this.beatFlash.setAlpha(0.7);
    this.tweens.add({
      targets: this.beatFlash,
      alpha: 0,
      duration: 250,
      ease: "Sine.easeOut",
    });

    for (const { obj, baseScale } of this.bounceTargets) {
      if (obj === this.kaijuBody || obj === this.playerBody) {
        const delay =
          obj === this.playerBody ? RHYTHM_BODY_SQUASH.playerDelayMs : 0;
        this.tweens.add({
          targets: obj,
          scaleX: baseScale * RHYTHM_BODY_SQUASH.stretchX,
          scaleY: baseScale * RHYTHM_BODY_SQUASH.squashY,
          duration: RHYTHM_BODY_SQUASH.halfMs,
          delay,
          yoyo: true,
          ease: "Sine.easeInOut",
        });
      } else {
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
  }

  /* ---- Phase C: Resolution ---- */

  private stopResolutionSchedule(): void {
    this.resolutionBeatTimer?.remove(false);
    this.resolutionBeatTimer = null;
  }

  private clearWaveCatharsisHandle(): void {
    if (this.waveCatharsisRealHandle !== null) {
      window.clearTimeout(this.waveCatharsisRealHandle);
      this.waveCatharsisRealHandle = null;
      // The cancelled timeout normally calls `resumeGlobalTimeScale`; if we
      // clear it early (GAME OVER, scene shutdown), restore scale here or
      // `this.time` stays at 0 and handoff/title are frozen.
      this.resumeGlobalTimeScale();
    }
  }

  private pauseGlobalTimeScale(): void {
    this.time.timeScale = 0;
    this.tweens.timeScale = 0;
  }

  private resumeGlobalTimeScale(): void {
    this.time.timeScale = 1;
    this.tweens.timeScale = 1;
  }

  private clearGameClearAutoTitleHandle(): void {
    if (this.gameClearAutoTitleHandle !== null) {
      window.clearTimeout(this.gameClearAutoTitleHandle);
      this.gameClearAutoTitleHandle = null;
    }
  }

  private clearPostFadeSceneHandle(): void {
    if (this.postFadeSceneHandle !== null) {
      window.clearTimeout(this.postFadeSceneHandle);
      this.postFadeSceneHandle = null;
    }
  }

  /**
   * GAME_CLEAR の自動戻しとフェード後 `start`/`restart` 用。SHUTDOWN や
   * 遷移開始時にまとめて掃除する。
   */
  private clearResultHandoffWallClockHandles(): void {
    this.clearGameClearAutoTitleHandle();
    this.clearPostFadeSceneHandle();
  }

  /**
   * カメラフェード完了後に 1 回だけ実行。実時間 `setTimeout` なので
   * `timeScale === 0` でも遅延は進む（`delayedCall` とは違う）。
   */
  private schedulePostFadeHandoff(
    delayMs: number,
    action: () => void,
  ): void {
    this.clearPostFadeSceneHandle();
    this.postFadeSceneHandle = window.setTimeout(() => {
      this.postFadeSceneHandle = null;
      if (!this.scene.isActive("MainScene")) return;
      this.resumeGlobalTimeScale();
      action();
    }, delayMs);
  }

  private scheduleGameClearCountdownToTitle(): void {
    this.clearGameClearAutoTitleHandle();
    this.gameClearAutoTitleHandle = window.setTimeout(() => {
      this.gameClearAutoTitleHandle = null;
      if (this.phase !== GamePhase.GAME_CLEAR) return;
      this.beginHandoffToTitle();
    }, GAME_CLEAR_AUTO_TITLE_MS);
  }

  private resetCombo(): void {
    this.comboCount = 0;
  }

  private playerComboDamageMultiplier(): number {
    return comboDamageMultiplier(this.comboCount, COMBO.DMG_PER_STACK);
  }

  /**
   * 敵からダメージを受けたらコンボ途切れ（衝突双方を含む）。
   */
  private onPlayerTookDamageFromKaiju(): void {
    this.resetCombo();
  }

  private startResolve(): void {
    this.stopResolutionSchedule();
    this.phase = GamePhase.RESOLUTION;
    this.setPhaseDisplay(
      "RESOLUTION",
      "#ff6644",
      MATERIAL_ICON_GLYPH.phaseResolve,
      PHASE_FLOW.resolutionIntro.text,
      PHASE_FLOW.resolutionIntro.color,
    );
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
    this.resolutionBeatTimer = this.time.addEvent({
      delay: this.resolveMs,
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

    this.applyResolutionRowFocus(stepIdx, isTelegraph);
    this.setPhaseFromHint(
      isTelegraph
        ? phaseFlowTelegraph(stepIdx, SEQ_LEN)
        : phaseFlowPlayerResolve(stepIdx, SEQ_LEN),
    );
    this.pulseBeat();

    if (isTelegraph) {
      this.telegraphKaiju(stepIdx);
    } else {
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
      s.themeTint.setFillStyle(ACT_COL[kAct], 1);
      s.themeTint.setAlpha(THEME_TINT_ALPHA);
      s.border.setStrokeStyle(2, ACT_COL[kAct], 1);
      s.label.setVisible(false);
      s.icon
        .setVisible(true)
        .setText(actionTheme(kAct).icon);
      s.icon.setFontSize(Math.max(20, Math.floor(this.slotSz * 0.5)));
      this.centerSlotActionIcon(s.icon);
      this.reflowSlotLabelZab(s);
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
      this.resetCombo();
      this.ohStreak++;
      console.log(`[Step ${i}] OVERHEAT streak=${this.ohStreak}`);
      pAct = ActionType.IDLE;
      const s = this.pSlots[i];
      s.icon.setVisible(false);
      s.label.setVisible(true).setText("OH!").setColor("#ff6666");
      s.label.setFontSize(14);
      s.themeTint.setFillStyle(PAL.heatRed, 0.7);
      this.reflowSlotLabelZab(s);
      const isFirstOverheatInTurn = !this.ohAlarmedThisTurn;
      if (isFirstOverheatInTurn) {
        this.ohAlarmedThisTurn = true;
        audio.playOverheat({
          pan: PAN_PLAYER,
          volume: OVERHEAT_SFX.FIRST_STEP_VOLUME,
        });
      } else {
        audio.playOverheat({
          pan: PAN_PLAYER,
          volume: OVERHEAT_SFX.SUBSEQUENT_STEP_VOLUME,
        });
      }
      this.spawnOverheatSilencePunish(i);
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
      this.startRhythmSequence(this.resolveMs);
    }
  }

  /* ============================================================ */
  /*  Combat                                                        */
  /* ============================================================ */

  /**
   * Removes HP from the current kaiju. For **BOSS** rank only, non–
   * SPECIAL damage cannot take HP below 1 — the boss must be finished
   * with a SPECIAL (必殺). GIGA / zako are unchanged.
   *
   * @param amount  Raw damage to apply
   * @param fromSpecial  `true` when the source is a player SPECIAL
   * @returns HP actually removed (for accurate floating combat text)
   */
  private damageKaiju(amount: number, fromSpecial: boolean): number {
    if (this.currentKaijuRank !== "boss" || fromSpecial) {
      this.kaijuHP -= amount;
      return amount;
    }
    const canTake = Math.max(0, this.kaijuHP - 1);
    const deal = Math.min(amount, canTake);
    this.kaijuHP -= deal;
    return deal;
  }

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
    // (transition across zero) from a non-fatal hit; CRITICAL! は
    // 非撃破専用。
    const prevKaijuHP = this.kaijuHP;

    switch (pAct) {
      case ActionType.ATTACK:
        this.playerHeat += this.weatherAdjHeatGain(HEAT_DELTA.attack);
        audio.playAttack({ pan: PAN_PLAYER });
        if (kAct === ActionType.ATTACK) {
          const m = this.playerComboDamageMultiplier();
          const clashDmg = this.weatherAdjAtkDmg(DMG.clash);
          const dealtK = this.damageKaiju(flooredWithCombo(clashDmg, m), false);
          this.playerHP -= clashDmg;
          this.onPlayerTookDamageFromKaiju();
          msg =
            dealtK < clashDmg
              ? `CLASH!  YOU -${clashDmg}  KAIJU -${dealtK}  (SPECIAL to finish BOSS)`
              : `CLASH! Both -${clashDmg}`;
          this.popText(kR, `-${dealtK}`, VFX.pop.damage);
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
          const m = this.playerComboDamageMultiplier();
          const hitDmg = flooredWithCombo(
            this.weatherAdjAtkDmg(DMG.attack),
            m,
          );
          const dealtK = this.damageKaiju(hitDmg, false);
          msg =
            dealtK < hitDmg
              ? `HIT! KAIJU -${dealtK}  (SPECIAL to finish BOSS)`
              : `HIT! KAIJU -${hitDmg}`;
          this.popText(kR, `-${dealtK}`, VFX.pop.damage);
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

      case ActionType.COOL: {
        const coolD =
          this.currentWeather === "snow" ? HEAT_DELTA.coolSnow : HEAT_DELTA.cool;
        this.playerHeat += coolD;
        audio.playCool({ pan: PAN_PLAYER });
        if (kAct === ActionType.ATTACK) {
          const vulnDmg = this.weatherAdjAtkDmg(DMG.coolVulnerable);
          this.playerHP -= vulnDmg;
          this.onPlayerTookDamageFromKaiju();
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
      }

      case ActionType.SPECIAL: {
        this.playerHeat += this.weatherAdjHeatGain(HEAT_DELTA.special);
        audio.playSpecial({ pan: PAN_PLAYER });
        // Hit-stop is slightly longer on a GUARD break because the
        // payoff of punching through a defence is bigger.
        const hitStopMs =
          kAct === ActionType.GUARD ? HITSTOP_MS.break : HITSTOP_MS.special;
        const mS = this.playerComboDamageMultiplier();
        if (kAct === ActionType.GUARD) {
          const vsG = flooredWithCombo(DMG.specialVsGuard, mS);
          const dealtK = this.damageKaiju(vsG, true);
          msg = `BREAK! KAIJU -${dealtK}`;
          this.popText(kR, `-${dealtK}`, VFX.pop.special);
        } else {
          const sp = flooredWithCombo(DMG.special, mS);
          const dealtK = this.damageKaiju(sp, true);
          msg = `SPECIAL! KAIJU -${dealtK}`;
          this.popText(kR, `-${dealtK}`, VFX.pop.special);
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
          this.onPlayerTookDamageFromKaiju();
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

    // 撃破は `runKaijuDefeatCatharsis` に任せ、ここは非致死 GUARD 割り専用。
    const killed = prevKaijuHP > 0 && this.kaijuHP <= 0;
    if (
      !killed &&
      pAct === ActionType.SPECIAL &&
      kAct === ActionType.GUARD
    ) {
      this.showPraise("CRITICAL!!");
    }
  }

  /* ============================================================ */
  /*  Win / Lose                                                    */
  /* ============================================================ */

  private onWaveWin(): void {
    // Do not let scheduled resolution ticks run after the K.O. — they
    // would keep pulsing the beat, telegraphing, and resolving under
    // the clear / next-wave flow.
    this.stopResolutionSchedule();
    this.cancelHitStop();

    const perfectBonus =
      this.wavePerfectCount * WAVE_CATHARSIS.BONUS_PER_PERFECT;
    const isFinal = this.wave >= this.maxWave;

    this.clearWaveCatharsisHandle();
    this.pauseGlobalTimeScale();
    this.waveCatharsisRealHandle = window.setTimeout(() => {
      this.waveCatharsisRealHandle = null;
      if (!this.scene.isActive() || this.phase === GamePhase.GAME_OVER) {
        this.resumeGlobalTimeScale();
        return;
      }
      this.resumeGlobalTimeScale();
      this.runKaijuDefeatCatharsis(perfectBonus, () => {
        this.proceedAfterKaijuDefeat(perfectBonus, isFinal);
      });
    }, WAVE_CATHARSIS.FREEZE_MS);
  }

  private emitKaijuDefeatExplosion(x: number, y: number): void {
    const burst = this.add.particles(x, y, "spark", {
      speed: { min: 100, max: 300 },
      scale: { start: 1, end: 0 },
      alpha: { start: 0.95, end: 0.15 },
      angle: { min: 0, max: 360 },
      tint: [0xff6622, 0xff2200, 0xffaa33, 0xff4400],
      lifespan: 800,
      quantity: 72,
      emitting: false,
    });
    burst.setDepth(DEPTH.sparks);
    burst.setBlendMode(Phaser.BlendModes.ADD);
    burst.explode(72);
    this.time.delayedCall(1000, () => burst.destroy());
  }

  /**
   * フリーズ解除直後: 白フラッシュ + 爆風 + 大絶賛 UI。終了後 `onComplete`。
   */
  private runKaijuDefeatCatharsis(
    perfectBonus: number,
    onComplete: () => void,
  ): void {
    const W = this.scale.width;
    const H = this.scale.height;
    const kx = this.kaijuBody.x;
    const ky = this.kaijuBody.y;

    this.cameras.main.flash(500, 255, 255, 255, true);
    this.emitKaijuDefeatExplosion(kx, ky);

    const c = this.add.container(W / 2, H * 0.4);
    c.setDepth(DEPTH.popText + 2);

    const t1Z = this.add.graphics();
    const t1 = this.add
      .text(0, -28, "[ KAIJU DESTROYED ]", {
        fontFamily: '"Dela Gothic One", Impact, "Arial Black", sans-serif',
        fontSize: `${Math.max(28, Math.round(H * 0.08))}px`,
        color: "#ffd24a",
        stroke: "#1a0a00",
        strokeThickness: 10,
        shadow: { offsetX: 0, offsetY: 5, color: "#000000", blur: 8, fill: true },
      })
      .setOrigin(0.5);
    this.layoutZabutonBehindText(t1, t1Z, 12, 0.68);

    const t2Z = this.add.graphics();
    const t2 = this.add
      .text(0, 28, `PERFECT BONUS: +${perfectBonus}`, {
        fontFamily: FONT,
        fontSize: `${Math.max(16, Math.round(H * 0.032))}px`,
        color: "#fff2aa",
        fontStyle: "bold",
        stroke: "#000000",
        strokeThickness: 6,
        shadow: { ...HUD_SHADOW, blur: 6 },
      })
      .setOrigin(0.5);
    this.layoutZabutonBehindText(t2, t2Z, 10, 0.6);

    c.add([t1Z, t1, t2Z, t2]);
    c.setAlpha(0);
    this.tweens.add({
      targets: c,
      alpha: 1,
      duration: 220,
    });
    this.tweens.add({
      targets: c,
      scale: { from: 0.88, to: 1.02 },
      duration: 420,
      ease: "Back.easeOut",
    });

    this.time.delayedCall(WAVE_CATHARSIS.PRIZE_HOLD_MS, () => {
      this.tweens.add({
        targets: c,
        alpha: 0,
        y: c.y - 32,
        duration: 300,
        onComplete: () => c.destroy(),
      });
    });
    this.time.delayedCall(WAVE_CATHARSIS.PRIZE_HOLD_MS + 120, onComplete);
  }

  private proceedAfterKaijuDefeat(perfectBonus: number, isFinal: boolean): void {
    const rank = pickKaijuRank(this.wave);
    this.score += 1;
    this.score += perfectBonus;
    if (rank === "boss") this.bossesDefeated += 1;
    else if (rank === "giga") this.gigasDefeated += 1;
    this.refreshProgressHUD();
    this.refreshHUD();
    console.log(
      `[Wave ${this.wave}] ${rank.toUpperCase()} defeated — Score: ${this.score}`,
    );

    const next = isFinal
      ? () => this.triggerGameClear()
      : () => this.beginWave();
    this.scheduleKaijuBodyDefeatExitThen(next);
  }

  /**
   * 撃破後の共通「点滅 → 短い間 → 次シーン遷移」カイジュ退場。
   */
  private scheduleKaijuBodyDefeatExitThen(next: () => void): void {
    this.tweens.add({
      targets: this.kaijuBody,
      alpha: 0,
      duration: 80,
      yoyo: true,
      repeat: 6,
      onComplete: () => this.time.delayedCall(400, next),
    });
  }

  /** PERFECT 連打の火力連鎖表示（2 本目から）。 */
  private spawnChainComboPop(): void {
    const H = this.scale.height;
    const cx = this.heatGaugeContainer.x;
    const cy = this.heatGaugeContainer.y - H * 0.11;

    const zab = this.add.graphics();
    const t = this.add
      .text(0, 0, `${this.comboCount} CHAIN!`, {
        fontFamily: FONT,
        fontSize: `${Math.max(19, Math.round(H * 0.038))}px`,
        color: "#ff8800",
        fontStyle: "bold",
        stroke: "#000000",
        strokeThickness: 6,
        shadow: { ...HUD_SHADOW },
      })
      .setOrigin(0.5)
      .setAngle(-10);
    this.layoutZabutonBehindText(t, zab, 9, 0.58);
    const ctr = this.add.container(cx, cy, [zab, t]);
    ctr.setDepth(DEPTH.popText + 3);
    ctr.setScale(0.0001);

    this.tweens.add({
      targets: ctr,
      scaleX: 1.2,
      scaleY: 1.2,
      duration: 380,
      ease: "Back.easeOut",
    });
    this.tweens.add({
      targets: ctr,
      y: cy - 48,
      alpha: 0,
      duration: 700,
      delay: 500,
      ease: "Sine.easeIn",
      onComplete: () => ctr.destroy(),
    });
  }

  /**
   * オーバーヒートでアクション消滅したステップ: 黒煙 + ERROR ラベル + 枠点滅。
   */
  private spawnOverheatSilencePunish(i: number): void {
    const s = this.pSlots[i];
    if (!s?.root) return;

    const sm = this.add.particles(
      this.playerBody.x,
      this.playerBody.y + 8,
      "spark",
      {
        speed: { min: 8, max: 46 },
        angle: { min: 250, max: 290 },
        gravityY: -32,
        alpha: { start: 0.7, end: 0 },
        scale: { start: 2, end: 4 },
        tint: [0x111111, 0x333333, 0x1c1c1c],
        lifespan: 1100,
        quantity: 22,
        emitting: false,
      },
    );
    sm.setDepth(DEPTH.sparks);
    sm.explode(22);
    this.time.delayedCall(1200, () => sm.destroy());

    const err = this.add
      .text(s.root.x, s.root.y - this.slotSz * 0.55, "ERROR", {
        fontFamily: FONT,
        fontSize: "15px",
        color: "#ff3333",
        fontStyle: "bold",
        stroke: "#1a0000",
        strokeThickness: 5,
        shadow: { ...HUD_SHADOW },
      })
      .setOrigin(0.5)
      .setDepth(DEPTH.popText + 2);
    this.tweens.add({
      targets: err,
      alpha: 0,
      y: err.y - 20,
      duration: 500,
      delay: 200,
      onComplete: () => err.destroy(),
    });

    for (let f = 0; f < 6; f++) {
      this.time.delayedCall(f * 200, () => {
        s.border.setStrokeStyle(4, 0xff0a0a, 0.95);
      });
      this.time.delayedCall(f * 200 + 100, () => {
        s.border.setStrokeStyle(2, 0xff2222, 0.85);
      });
    }
    this.time.delayedCall(1300, () => {
      const col = ACT_COL[this.playerSeq[i] ?? ActionType.IDLE];
      s.border.setStrokeStyle(2, col, 1);
    });
  }

  private endGame(reason: string): void {
    this.clearWaveCatharsisHandle();
    this.resumeGlobalTimeScale();
    this.stopResolutionSchedule();
    this.setPlayerConsoleRimLively(false);
    this.phase = GamePhase.GAME_OVER;
    this.rhythmCursor.setVisible(false);
    this.timingBar.setVisible(false);
    this.buttonsReady = false;
    // Release any active freeze / danger pulse so the game-over layer
    // animates in cleanly instead of staying frozen or tinted red.
    this.cancelHitStop();
    this.clearHeatAlert();
    this.heatDangerActive = false;
    this.endEmergencyMode();
    this.updateBossFinisherPrompt();
    this.setPhaseDisplay("GAME OVER", "#ff4444", undefined, "");
    console.log(`[GameOver] ${reason} | Score: ${this.score}`);

    const extraStatsLine =
      `Waves ${this.score}  \u00B7  Bosses ${this.bossesDefeated}  \u00B7  Gigas ${this.gigasDefeated}`;

    if (isEndless(this.difficulty) && this.goEndlessScoreHero) {
      this.tweens.killTweensOf(this.goEndlessScoreHero);
      this.goEndlessScoreHero.setText(String(this.score));
      this.goEndlessScoreHero.setScale(0.35);
      this.goEndlessScoreHero.setAlpha(1);
      this.tweens.add({
        targets: this.goEndlessScoreHero,
        scale: 1,
        duration: 600,
        ease: "Back.easeOut",
      });
      this.goScoreText.setText(`${reason}\n\n${extraStatsLine}`);
    } else {
      this.goScoreText.setText(
        `Score: ${this.score}  \u2014 ${reason}`,
      );
    }
    // Sync the Web3 widgets with the current wallet state before the
    // overlay fades in (handles the "already connected from previous
    // run" case where we can skip straight to the submit button).
    this.refreshWeb3UI();
    this.primeWeb3StatusLine();
    this.goLayer.setVisible(true).setAlpha(0);
    this.tweens.add({ targets: this.goLayer, alpha: 1, duration: 600 });
  }

  /**
   * Finite-length win flow for EASY / NORMAL. We never reach here for
   * ENDLESS (its `maxWave` is `Infinity`). Shows a brief celebration
   * overlay, then returns to the title so the player can pick a new
   * difficulty without a click.
   */
  private triggerGameClear(): void {
    this.clearWaveCatharsisHandle();
    this.resumeGlobalTimeScale();
    this.stopResolutionSchedule();
    this.setPlayerConsoleRimLively(false);
    this.phase = GamePhase.GAME_CLEAR;
    this.rhythmCursor.setVisible(false);
    this.timingBar.setVisible(false);
    this.buttonsReady = false;
    this.cancelHitStop();
    this.clearHeatAlert();
    this.heatDangerActive = false;
    this.endEmergencyMode();
    this.updateBossFinisherPrompt();

    const timeMs = Math.max(0, this.time.now - this.runStartTime);

    this.setPhaseDisplay("GAME CLEAR", "#ffd166", undefined, "");
    console.log(
      `[GameClear] ${this.difficulty.toUpperCase()} ${timeMs}ms — ` +
        `W${this.wave} B${this.bossesDefeated} G${this.gigasDefeated}`,
    );

    this.showGameClearOverlay(timeMs);

    this.scheduleGameClearCountdownToTitle();

    this.input.keyboard?.on("keydown", this.onGameClearKeyForTitleSkip);
  }

  /**
   * Skip the GAME_CLEAR countdown and cross-fade to the title (pointer or
   * key from {@link triggerGameClear}).
   */
  private trySkipGameClearToTitle(): void {
    if (this.phase !== GamePhase.GAME_CLEAR) return;
    if (this.resultScreenNavInProgress) return;
    this.beginHandoffToTitle();
  }

  /**
   * Stops the in-scene procedural BGM and low-HP static (also runs on
   * {@link Phaser.Scenes.Events.SHUTDOWN}).
   */
  private teardownEncounterAudio(): void {
    audio.stopBattleNoise();
    audio.stopCombatBgm();
  }

  /**
   * Cross-fade to `TitleScene` from GAME_OVER or GAME_CLEAR. Idempotent.
   */
  private beginHandoffToTitle(): void {
    if (this.resultScreenNavInProgress) return;
    this.resultScreenNavInProgress = true;
    // ウェーブ撃破直後のフリーズ等で timeScale が 0 の可能性がある。フェード
    // 前に 1 へ戻し、遷移予約は {@link schedulePostFadeHandoff}（実時間）。
    this.resumeGlobalTimeScale();
    this.input.keyboard?.off("keydown", this.onGameClearKeyForTitleSkip);
    this.clearResultHandoffWallClockHandles();
    this.teardownEncounterAudio();
    this.cameras.main.resetFX();
    this.cameras.main.fadeOut(RESULT_FADE_OUT_MS, 0, 0, 0);
    this.schedulePostFadeHandoff(RESULT_FADE_OUT_MS + 100, () => {
      this.scene.start("TitleScene");
    });
  }

  /**
   * Cross-fade then `restart` with the same difficulty (game-over RETRY).
   */
  private beginHandoffRetryFromGameOver(): void {
    if (this.resultScreenNavInProgress) return;
    this.resultScreenNavInProgress = true;
    this.resumeGlobalTimeScale();
    this.clearResultHandoffWallClockHandles();
    this.cameras.main.resetFX();
    this.cameras.main.fadeOut(RESULT_RESTART_FADE_MS, 0, 0, 0);
    this.schedulePostFadeHandoff(RESULT_RESTART_FADE_MS + 80, () => {
      this.scene.restart({ difficulty: this.difficulty });
    });
  }

  /* ============================================================ */
  /*  HUD helpers                                                   */
  /* ============================================================ */

  /**
   * Paints the top-right wave counter. Finite runs show the goal
   * (`WAVE 2/3` on EASY, etc.) so the player always knows how close they are to
   * clearing; ENDLESS just shows the raw count since there is no cap.
   */
  private refreshProgressHUD(): void {
    this.layoutScoreHud();
  }

  private refreshHUD(): void {
    const kh = Math.max(0, this.kaijuHP);
    const ph = Math.max(0, this.playerHP);
    const ht = Math.max(0, this.playerHeat);

    this.kaijuHPText.setText(`HP ${kh}`);
    this.layoutZabutonBehindText(this.kaijuHPText, this.kaijuHpZab, 6);
    this.kaijuHPBar.displayWidth =
      this.barMaxW * (kh / this.currentKaijuMaxHP);

    this.playerHPText.setText(`HP ${ph}`);
    this.layoutZabutonBehindText(this.playerHPText, this.playerHpZab, 6);
    this.playerHPBar.displayWidth = this.barMaxW * (ph / HP_INIT.player);

    // Heat gauge: three-stage colour ramp for immediate danger reading.
    //   0–50  → Cyan   (safe / normal operation)
    //   51–79 → Yellow (caution / heating up)
    //   80+   → Red    (danger zone — shake tween also kicks in)
    this.playerHeatBar.displayWidth =
      this.barMaxW * Math.min(1, ht / OVERHEAT_THRESHOLD);

    const heatColor =
      ht >= HEAT_DANGER ? 0xff0000 : ht > 50 ? 0xffff00 : 0x00ffff;
    const heatHex =
      ht >= HEAT_DANGER ? "#ff0000" : ht > 50 ? "#ffff00" : "#00ffff";
    this.playerHeatBar.setFillStyle(heatColor);
    const heatNum = Math.round(Math.min(999, ht));
    this.playerHeatText
      .setText(`HEAT ${heatNum}/${OVERHEAT_THRESHOLD}`)
      .setStyle({
        ...this.hudLineTextStyle(12, heatHex, "800"),
      });
    this.layoutZabutonBehindText(this.playerHeatText, this.heatLabelZab, 4);

    this.updateHeatDangerUI(ht);
    this.updateBossFinisherPrompt();
    this.updateEmergencyFromHP(ph);
    audio.setBattleNoiseFromPlayerHp(ph, HP_INIT.player);
  }

  /**
   * BOSS-only: non-SPECIAL damage cannot drop the boss below 1 HP. When the
   * player must land SPECIAL to win, show a clear line of English copy and
   * pulse the SPECIAL button frame.
   */
  private updateBossFinisherPrompt(): void {
    if (!this.bossFinisherHint || !this.specialFinisherGlow) return;
    const show =
      this.currentKaijuRank === "boss" &&
      this.kaijuHP === 1 &&
      !this.isRunTerminalPhase();

    this.bossFinisherHint.setVisible(show);
    this.specialFinisherGlow.setVisible(show);
    this.tweens.killTweensOf(this.specialFinisherGlow);
    this.specialFinisherGlow.setScale(1);

    if (!show) {
      this.specialFinisherGlow.setAlpha(0);
      return;
    }

    this.specialFinisherGlow.setAlpha(0.25);
    this.tweens.add({
      targets: this.specialFinisherGlow,
      alpha: { from: 0.12, to: 0.52 },
      scaleX: { from: 1, to: 1.08 },
      scaleY: { from: 1, to: 1.08 },
      duration: 420,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  /**
   * HP-driven emergency: dramatic vignette + half SPECIAL heat while active.
   */
  private updateEmergencyFromHP(ph: number): void {
    if (this.isRunTerminalPhase()) {
      this.endEmergencyMode();
      return;
    }
    if (!this.isEmergencyMode && ph <= EMERGENCY.HP_THRESHOLD) {
      this.startEmergencyMode();
    } else if (this.isEmergencyMode && ph > EMERGENCY.HP_THRESHOLD) {
      this.endEmergencyMode();
    }
  }

  private startEmergencyMode(): void {
    if (this.isEmergencyMode) return;
    const W = this.scale.width;
    const H = this.scale.height;
    const o = new EmergencyModeOverlay(this, {
      emergencyRed: DEPTH.emergencyRed,
      emergencyVig: DEPTH.emergencyVig,
    });
    if (!o.enter(W, H)) return;
    this.emergencyOverlay = o;
  }

  private endEmergencyMode(): void {
    this.emergencyOverlay?.exit();
    this.emergencyOverlay = null;
  }

  /** Recreate the emergency canvas + UI when the logical game size changes. */
  private syncEmergencyLayout(W: number, H: number): void {
    this.emergencyOverlay?.relayout(W, H);
  }

  private spawnRhythmTimingFeedback(
    pIdx: number,
    timing: RhythmInputTiming,
  ): void {
    const s = this.pSlots[pIdx];
    if (!s?.root) return;
    this.rhythmInputVfx.spawnForTiming(
      timing,
      s.root.x,
      s.root.y,
      this.slotSz,
    );
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
    if (this.isRunTerminalPhase()) {
      return;
    }

    const nowDanger = heat >= HEAT_DANGER;
    if (nowDanger === this.heatDangerActive) return;

    this.heatDangerActive = nowDanger;
    if (nowDanger) {
      this.activateHeatAlert();
      this.startHeatGaugeShake();
    } else {
      this.clearHeatAlert();
      this.stopHeatGaugeShake();
      this.playHeatReliefFlash();
    }
  }

  /**
   * @param materialIcon — When set, a single Material Icons PUA character
   *   (see `materialIconCodepoints.ts`) beside the label. Omit for GAME OVER / CLEAR.
   * @param flowHint — When set (incl. empty string), updates the sub-line under
   *   the phase; empty hides it. Pass `undefined` to leave the current line.
   * @param flowHintColor — Text colour for the sub-line; defaults to a neutral grey.
   */
  private setPhaseDisplay(
    label: string,
    color: string,
    materialIcon?: string,
    flowHint?: string,
    flowHintColor = "#a8b4c0",
  ): void {
    if (materialIcon) {
      this.phaseIcon.setVisible(true);
      this.phaseIcon.setText(materialIcon);
      const iconPx = 26;
      this.phaseIcon.setStyle({ ...materialIconGlyphStyle(iconPx, color, 2) });
      this.phaseLabel.setStyle({ ...this.hudLineTextStyle(18, color, "800") });
      this.phaseLabel.setText(label);
      const gap = 8;
      const tw = this.phaseIcon.width + gap + this.phaseLabel.width;
      const mh = Math.max(this.phaseIcon.height, this.phaseLabel.height);
      this.phaseIcon.setOrigin(0, 0.5).setPosition(-tw / 2, 0);
      this.phaseLabel
        .setOrigin(0, 0.5)
        .setPosition(this.phaseIcon.x + this.phaseIcon.width + gap, 0);
      this.layoutZabutonSizedRect(this.phaseZab, tw, mh, ZABUTON_PAD);
    } else {
      this.phaseIcon.setVisible(false);
      this.phaseLabel.setText(label);
      this.phaseLabel.setStyle({ ...this.hudLineTextStyle(18, color, "800") });
      this.phaseLabel.setOrigin(0.5, 0.5).setPosition(0, 0);
      this.layoutZabutonBehindText(this.phaseLabel, this.phaseZab, ZABUTON_PAD);
    }
    this.tweens.add({
      targets: this.phaseHudContainer,
      scaleX: { from: 1.2, to: 1 },
      scaleY: { from: 1.2, to: 1 },
      duration: 200,
      ease: "Sine.easeOut",
    });
    if (flowHint !== undefined) {
      this.setPhaseFlowHint(flowHint, flowHintColor);
    }
  }

  private setPhaseFromHint(hint: { text: string; color: string }): void {
    this.setPhaseFlowHint(hint.text, hint.color);
  }

  private setPhaseFlowHint(text: string, color: string = "#9fb0c2"): void {
    if (!text) {
      this.phaseFlowHint.setVisible(false);
      this.phaseFlowHint.setText("");
      return;
    }
    const w = this.scale.width;
    this.phaseFlowHint.setStyle({
      font: `600 ${PHASE_FLOW_HINT_FONT_PX}px ${FONT}`,
      color,
      stroke: PHASE_FLOW_HINT_STROKE,
      strokeThickness: 3,
      align: "center",
      wordWrap: {
        width: w * PHASE_FLOW_HINT_WORD_WRAP_FRAC,
        useAdvancedWrap: true,
      },
    });
    this.phaseFlowHint.setText(text);
    this.phaseFlowHint.setVisible(true);
  }

  private clearSlots(): void {
    this.stopNextInputSlotHint();
    const all = this.kSlots.concat(this.pSlots);
    for (const s of all) {
      s.underlay.setFillStyle(PAL.slotBg, 0.98);
      s.themeTint.setFillStyle(0xffffff, 0);
      s.themeTint.setAlpha(0);
      s.border.setFillStyle();
      s.border.setStrokeStyle(2, PAL.slotStroke, 1);
      s.border.setBlendMode(Phaser.BlendModes.NORMAL);
      s.root.setScale(1);
      s.root.setAlpha(1);
      s.icon.setText("").setVisible(false);
      s.label
        .setFontSize(KAIJU_SLOT_FONT_PX)
        .setText("")
        .setVisible(false)
        .setAlpha(1)
        .setColor("#e6edf3");
      this.reflowSlotLabelZab(s);
    }
  }

  private enableButtons(on: boolean): void {
    for (const b of this.btns) {
      const pal = this.buttonThemePalette(b.action);
      if (on) {
        b.container.setInteractive({ useHandCursor: true });
        b.bg.setFillStyle(pal.on, 1);
      } else {
        b.container.disableInteractive();
        b.bg.setFillStyle(pal.off, 0.5);
      }
    }
  }

  private showMessage(msg: string): void {
    this.msgLabel.setText(msg);
    this.layoutZabutonBehindText(this.msgLabel, this.msgZab, ZABUTON_PAD);
    this.msgHudContainer.setAlpha(1);
    this.tweens.add({
      targets: this.msgHudContainer,
      alpha: 0,
      delay: 300,
      duration: 500,
    });
  }

  /* ============================================================ */
  /*  Effects                                                       */
  /* ============================================================ */

  /**
   * Freeze-frame for "big impact" events: only tweens are paused.
   * We intentionally do **not** set `this.time.paused` — pausing the
   * global Time.Clock also freezes the `time.addEvent` that drives
   * resolve ticks, so every hit-stop (CLASH, etc.) shoves the next
   * `pulseBeat` late and the combat rhythm desyncs from the metronome.
   *
   * Camera shake keeps running; hit-stop is visual/tween-only.
   */
  private applyHitStop(duration: number): void {
    if (this.hitStopActive) return;
    if (this.phase !== GamePhase.RESOLUTION) return;

    this.hitStopActive = true;
    this.tweens.pauseAll();

    this.hitStopResumeHandle = window.setTimeout(() => {
      this.hitStopResumeHandle = null;
      // The scene may have been shut down or restarted while frozen.
      if (!this.scene.isActive()) return;
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

  /** Remove the red vignette, stop its pulse, and end any gauge shake. */
  private clearHeatAlert(): void {
    this.heatAlertTween?.stop();
    this.heatAlertTween = undefined;
    this.heatVignette.setVisible(false).setAlpha(0);
    this.stopHeatGaugeShake();
  }

  // ================================================================
  //  Heat gauge shake
  // ================================================================

  /**
   * Start a looping left–right oscillation on the heat gauge container.
   * Called when heat crosses into the danger zone (≥ HEAT_DANGER).
   * Idempotent — second calls while already shaking are no-ops.
   */
  private startHeatGaugeShake(): void {
    if (this.heatShakeTween) return;
    this.heatShakeTween = this.tweens.add({
      targets: this.heatGaugeContainer,
      x: { from: this.heatGaugeRestX - 2, to: this.heatGaugeRestX + 2 },
      duration: 65,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  /**
   * Stop the gauge shake and snap the container back to its rest position.
   * Safe to call even when no shake is active.
   */
  private stopHeatGaugeShake(): void {
    if (!this.heatShakeTween) return;
    this.heatShakeTween.stop();
    this.heatShakeTween = undefined;
    if (this.heatGaugeContainer?.active) {
      this.heatGaugeContainer.setPosition(
        this.heatGaugeRestX,
        this.heatGaugeRestY,
      );
    }
  }

  // ================================================================
  //  Cockpit chrome (divider + frame)
  // ================================================================

  /**
   * Decorative divider between the combat area (top) and the control
   * deck (bottom). The division line at H * 0.515 is purely visual —
   * no game logic reads from it.
   */
  private buildCockpitChrome(W: number, H: number): void {
    const divY = H * 0.515;
    const g = this.add.graphics().setDepth(DEPTH.heatVignette - 5);

    // Main rule
    g.lineStyle(1, 0x1e3050, 0.85);
    g.lineBetween(W * 0.04, divY, W * 0.96, divY);

    // Corner accent marks
    g.fillStyle(0x1e3050, 0.7);
    g.fillRect(W * 0.04, divY - 1, 18, 3);
    g.fillRect(W * 0.96 - 18, divY - 1, 18, 3);
    g.fillRect(W * 0.04, divY - 1, 3, 6);
    g.fillRect(W * 0.96 - 3, divY - 1, 3, 6);
  }

  // ================================================================
  //  Monitor overlay (vignette + scanlines) — topmost visual layer
  // ================================================================

  /**
   * Draws a permanent CRT-monitor illusion on top of all gameplay UI.
   * Uses Phaser.GameObjects.Graphics with fillGradientStyle for the
   * vignette and repeated 1-px rectangles for the scanline pattern.
   *
   * Depth 95 sits above the heat vignette (90) but below the
   * game-over overlay (100) so the GO screen always reads clearly.
   */
  private buildMonitorOverlay(W: number, H: number): void {
    const g = this.add.graphics().setDepth(95);

    // ---- Vignette (dark edges, bright centre) ----
    // Top fade: opaque at top, transparent at 40 % down.
    g.fillGradientStyle(0x000000, 0x000000, 0x000000, 0x000000, 0.5, 0.5, 0, 0);
    g.fillRect(0, 0, W, H * 0.4);
    // Bottom fade
    g.fillGradientStyle(0x000000, 0x000000, 0x000000, 0x000000, 0, 0, 0.5, 0.5);
    g.fillRect(0, H * 0.6, W, H * 0.4);
    // Left fade
    g.fillGradientStyle(0x000000, 0x000000, 0x000000, 0x000000, 0.4, 0, 0.4, 0);
    g.fillRect(0, 0, W * 0.16, H);
    // Right fade
    g.fillGradientStyle(0x000000, 0x000000, 0x000000, 0x000000, 0, 0.4, 0, 0.4);
    g.fillRect(W * 0.84, 0, W * 0.16, H);

    // ---- Scanlines ----
    // Very thin horizontal lines every 4 px at alpha 0.05 — barely
    // visible but add texture that reads as a CRT screen up close.
    g.fillStyle(0x000000, 0.05);
    for (let y = 0; y < H; y += 4) {
      g.fillRect(0, y, W, 1);
    }
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
    this.layoutScoreHud();
    this.phaseFlowHint.setPosition(size.width / 2, 50);
    this.phaseFlowHint.setStyle({
      wordWrap: {
        width: size.width * PHASE_FLOW_HINT_WORD_WRAP_FRAC,
        useAdvancedWrap: true,
      },
    });
    this.controlGuideText.setStyle({
      ...this.hudLineTextStyle(11, "#b8c0ce", "600"),
      align: "center",
      wordWrap: { width: size.width * 0.88, useAdvancedWrap: true },
    });
    this.layoutControlGuideZab();
    const H = size.height;
    const W = size.width;
    const by = H * 0.855;
    this.bossFinisherHint?.setPosition(W / 2, by - 58);
    this.bossFinisherHint?.setStyle({
      ...this.hudLineTextStyle(13, "#ffdd77", "900"),
      align: "center",
      lineSpacing: 4,
      wordWrap: { width: W * 0.92, useAdvancedWrap: true },
    });
    this.controlGuideContainer.setPosition(
      size.width / 2,
      H * 0.855 + ACTION_BUTTON_H / 2 + 20,
    );
    this.msgHudContainer.setPosition(size.width / 2, size.height * 0.53);
    if (this.msgLabel.text) {
      this.layoutZabutonBehindText(this.msgLabel, this.msgZab, ZABUTON_PAD);
    }
    this.syncEmergencyLayout(size.width, size.height);
  }
}
