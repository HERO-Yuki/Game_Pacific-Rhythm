import Phaser from "phaser";
import { notifyWavedashLoadComplete } from "../utils/wavedash";

/* ===================================================================
 *  Pacific Rhythm — core game scene
 *
 *  BPM-60 rhythm sequencer battle driven by beat-count timing.
 *  Rhythm phase uses update() with elapsed / beatLength instead of
 *  frame-rate-dependent timers, ensuring consistent rhythm across
 *  all hardware. Player input is accepted within a ±200 ms window
 *  centred on each beat.
 *
 *  Flow: Rhythm (8 beats: foreshadow + program) → Resolution → loop
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
  RHYTHM_ENEMY,
  RHYTHM_PLAYER,
  RESOLUTION,
  GAME_OVER,
}

// ======================== Constants ========================

const RHYTHM_MS = 1000;
const RESOLVE_MS = 500;
const INPUT_WINDOW_MS = 200;
const SEQ_LEN = 4;
const TOTAL_BEATS = SEQ_LEN * 2;

const HP_INIT = { player: 100, enemy: 100 } as const;
const OVERHEAT_THRESHOLD = 100;
const OVERHEAT_STREAK_LIMIT = 3;

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
  enemy: 0xcc3333,
  player: 0x3366cc,
  slotBg: 0x1a1f2e,
  slotStroke: 0x3d4663,
  highlight: 0xffcc00,
  btnOn: 0x2a2f3e,
  btnHover: 0x3a4f6e,
  btnOff: 0x181c24,
  hpGreen: 0x44cc44,
  heatOrange: 0xff6600,
  heatRed: 0xff0000,
  cursor: 0x00ffcc,
  miss: 0xff4444,
} as const;

const ACT_COL: Record<ActionType, number> = {
  [ActionType.ATTACK]: 0xff4444,
  [ActionType.GUARD]: 0x4488ff,
  [ActionType.COOL]: 0x44cccc,
  [ActionType.SPECIAL]: 0xcc44ff,
  [ActionType.IDLE]: 0x666666,
};

const ACT_SHORT: Record<ActionType, string> = {
  [ActionType.ATTACK]: "ATK",
  [ActionType.GUARD]: "GRD",
  [ActionType.COOL]: "COL",
  [ActionType.SPECIAL]: "SPL",
  [ActionType.IDLE]: "IDL",
};

const ENEMY_POOL: ActionType[] = [
  ActionType.ATTACK,
  ActionType.GUARD,
  ActionType.IDLE,
];

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
    enemyHit: 0xff6666,
    enemyBlock: 0xffffff,
    enemySpecial: 0xff44ff,
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
  private enemyHP = HP_INIT.enemy;
  private score = 0;
  private ohStreak = 0;
  private phase = GamePhase.RHYTHM_ENEMY;
  private enemySeq: ActionType[] = [];
  private playerSeq: ActionType[] = [];

  /* ---------- beat-count rhythm state ---------- */
  private rhythmStartTime = 0;
  private lastProcessedBeat = -1;
  private rhythmEnded = false;
  private buttonsReady = false;

  /* ---------- UI refs ---------- */
  private enemyRect!: Phaser.GameObjects.Rectangle;
  private playerRect!: Phaser.GameObjects.Rectangle;
  private enemyHPText!: Phaser.GameObjects.Text;
  private playerHPText!: Phaser.GameObjects.Text;
  private playerHeatText!: Phaser.GameObjects.Text;
  private enemyHPBar!: Phaser.GameObjects.Rectangle;
  private playerHPBar!: Phaser.GameObjects.Rectangle;
  private playerHeatBar!: Phaser.GameObjects.Rectangle;
  private eSlots: SlotUI[] = [];
  private pSlots: SlotUI[] = [];
  private btns: BtnUI[] = [];
  private phaseLabel!: Phaser.GameObjects.Text;
  private scoreLabel!: Phaser.GameObjects.Text;
  private msgLabel!: Phaser.GameObjects.Text;
  private goLayer!: Phaser.GameObjects.Container;
  private goScoreText!: Phaser.GameObjects.Text;
  private barMaxW = 0;

  /* rhythm UI */
  private rhythmCursor!: Phaser.GameObjects.Rectangle;
  private timingBar!: Phaser.GameObjects.Rectangle;
  private beatFlash!: Phaser.GameObjects.Rectangle;
  private slotSz = 56;

  /** Cached once after buildUI; avoids per-beat allocation. */
  private bounceTargets: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super("MainScene");
  }

  /* ============================================================ */
  /*  Lifecycle                                                     */
  /* ============================================================ */

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

    this.scale.on("resize", this.onResize, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () =>
      this.scale.off("resize", this.onResize, this),
    );

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
    this.enemyHP = HP_INIT.enemy;
    this.score = 0;
    this.ohStreak = 0;
    this.phase = GamePhase.RHYTHM_ENEMY;
    this.enemySeq = [];
    this.playerSeq = [];
    this.rhythmStartTime = 0;
    this.lastProcessedBeat = -1;
    this.rhythmEnded = false;
    this.buttonsReady = false;
  }

  private isRhythmPhase(): boolean {
    return (
      this.phase === GamePhase.RHYTHM_ENEMY ||
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
    this.scoreLabel = this.txt(W - 20, 16, "SCORE: 0", 15, "#6e7681").setOrigin(
      1,
      0,
    );
    this.msgLabel = this.txt(W / 2, H * 0.47, "", 16, "#ffcc00")
      .setOrigin(0.5)
      .setAlpha(0);

    this.buildCharacters(W, H);
    this.buildSequencer(W, H);
    this.buildRhythmIndicators(W, H);
    this.buildButtons(W, H);
    this.buildGameOver(W, H);
  }

  private buildCharacters(W: number, H: number): void {
    const cy = H * 0.22;
    const sz = Math.min(80, W * 0.085);
    this.barMaxW = sz * 1.6;
    const barH = 7;
    const barGap = 14;

    const ex = W * 0.25;
    this.enemyRect = this.add.rectangle(ex, cy, sz, sz, PAL.enemy);
    this.add
      .rectangle(ex, cy - sz / 2 - barGap, this.barMaxW, barH, 0x222222)
      .setOrigin(0.5);
    this.enemyHPBar = this.add
      .rectangle(
        ex - this.barMaxW / 2,
        cy - sz / 2 - barGap,
        this.barMaxW,
        barH,
        PAL.hpGreen,
      )
      .setOrigin(0, 0.5);
    this.enemyHPText = this.txt(
      ex,
      cy - sz / 2 - barGap - barH,
      "",
      13,
      "#44cc44",
    ).setOrigin(0.5, 1);
    this.txt(ex, cy + sz / 2 + 8, "ENEMY", 11, "#cc3333").setOrigin(0.5, 0);

    const px = W * 0.75;
    this.playerRect = this.add.rectangle(px, cy, sz, sz, PAL.player);
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
      "ENEMY",
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

    this.eSlots = [];
    this.pSlots = [];

    for (let i = 0; i < SEQ_LEN; i++) {
      const esx =
        mid - sep - groupW + this.slotSz / 2 + i * (this.slotSz + gap);
      const psx = mid + sep + this.slotSz / 2 + i * (this.slotSz + gap);
      this.txt(esx, y - this.slotSz / 2 - 4, `${i + 1}`, 9, "#4a5568").setOrigin(
        0.5,
        1,
      );
      this.txt(psx, y - this.slotSz / 2 - 4, `${i + 1}`, 9, "#4a5568").setOrigin(
        0.5,
        1,
      );
      this.eSlots.push(this.makeSlot(esx, y, this.slotSz));
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
    this.rhythmCursor.setVisible(false).setDepth(10);

    this.timingBar = this.add.rectangle(
      0,
      seqY + sz / 2 - 2,
      sz,
      3,
      PAL.cursor,
      0.8,
    );
    this.timingBar.setOrigin(0, 0.5);
    this.timingBar.setVisible(false).setDepth(10);

    this.beatFlash = this.add.rectangle(
      W / 2,
      seqY - sz / 2 - 26,
      W * 0.6,
      2,
      PAL.cursor,
      0,
    );
    this.beatFlash.setDepth(10);
  }

  private buildButtons(W: number, H: number): void {
    const by = H * 0.8;
    const acts: ActionType[] = [
      ActionType.ATTACK,
      ActionType.GUARD,
      ActionType.COOL,
      ActionType.SPECIAL,
    ];
    const bw = Math.min(120, W * 0.13);
    const bh = 40;
    const totalW = acts.length * bw + (acts.length - 1) * 12;
    const x0 = (W - totalW) / 2 + bw / 2;

    this.btns = [];
    for (let i = 0; i < acts.length; i++) {
      const action = acts[i];
      const bx = x0 + i * (bw + 12);

      const bg = this.add
        .rectangle(0, 0, bw, bh, PAL.btnOn)
        .setStrokeStyle(2, ACT_COL[action]);
      const lbl = this.txt(0, 0, action, 13, "#e6edf3").setOrigin(0.5);

      const ctr = this.add.container(bx, by, [bg, lbl]).setSize(bw, bh);
      ctr
        .setInteractive({ useHandCursor: true })
        .on("pointerover", () => {
          if (this.buttonsReady) bg.setFillStyle(PAL.btnHover);
        })
        .on("pointerout", () => {
          bg.setFillStyle(this.buttonsReady ? PAL.btnOn : PAL.btnOff);
        })
        .on("pointerdown", () => this.onActionClick(action));

      this.btns.push({ container: ctr, bg, action });
    }

    this.txt(
      W / 2,
      by + bh / 2 + 14,
      "Press in rhythm to program your sequence!",
      11,
      "#4a5568",
    ).setOrigin(0.5, 0);
  }

  private buildGameOver(W: number, H: number): void {
    const dim = this.add
      .rectangle(0, 0, W, H, 0x000000, 0.8)
      .setOrigin(0);
    const title = this.add
      .text(W / 2, H / 2 - 40, "GAME OVER", {
        fontFamily: FONT,
        fontSize: "42px",
        color: "#ff4444",
        fontStyle: "bold",
      })
      .setOrigin(0.5);
    this.goScoreText = this.txt(W / 2, H / 2 + 16, "", 22, "#e6edf3").setOrigin(
      0.5,
    );
    const hint = this.txt(
      W / 2,
      H / 2 + 56,
      "Click to Restart",
      14,
      "#8b949e",
    ).setOrigin(0.5);
    this.goLayer = this.add.container(0, 0, [
      dim,
      title,
      this.goScoreText,
      hint,
    ]);
    this.goLayer.setVisible(false).setDepth(100);
    dim.setInteractive().on("pointerdown", () => {
      if (this.phase === GamePhase.GAME_OVER) this.scene.restart();
    });
  }

  /** Builds the cached array of objects that bounce on every beat. */
  private cacheBounceTargets(): void {
    this.bounceTargets = [
      this.enemyRect,
      this.playerRect,
      this.phaseLabel,
      this.scoreLabel,
      ...this.btns.map((b) => b.container),
    ];
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
    this.enemyHP = HP_INIT.enemy;
    this.enemyRect.setAlpha(1).setScale(1);
    this.refreshHUD();
    this.startRhythmSequence();
  }

  /* ---- Rhythm phase (Foreshadow + Programming, 8 beats) ---- */

  private startRhythmSequence(): void {
    this.phase = GamePhase.RHYTHM_ENEMY;
    this.setPhaseDisplay("\u266a READING", "#ffcc00");
    this.clearSlots();
    this.enableButtons(false);
    this.buttonsReady = false;

    this.enemySeq = Array.from({ length: SEQ_LEN }, () =>
      Phaser.Math.RND.pick(ENEMY_POOL),
    );
    this.playerSeq = Array.from({ length: SEQ_LEN }, () => ActionType.IDLE);
    this.rhythmEnded = false;

    this.rhythmStartTime = this.time.now + RHYTHM_MS;
    this.lastProcessedBeat = -1;

    this.rhythmCursor.setPosition(this.eSlots[0].bg.x, this.eSlots[0].bg.y);

    console.log(
      "[Rhythm] Enemy:",
      this.enemySeq.map((a) => ACT_SHORT[a]).join(" "),
    );
  }

  private onRhythmBeat(beat: number): void {
    this.pulseBeat();

    const prevPIdx = beat - SEQ_LEN - 1;
    if (prevPIdx >= 0 && prevPIdx < SEQ_LEN) {
      this.finalizeSlotInput(prevPIdx);
    }

    if (beat < SEQ_LEN) {
      this.revealEnemySlot(beat);
      this.rhythmCursor.setVisible(true);
      this.moveCursorTo(this.eSlots[beat]);
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

    this.time.delayedCall(Math.round(RHYTHM_MS * 0.5), () => {
      if (this.phase !== GamePhase.GAME_OVER) this.startResolve();
    });
  }

  /* ---- Rhythm helpers ---- */

  private revealEnemySlot(i: number): void {
    const action = this.enemySeq[i];
    const s = this.eSlots[i];
    s.bg.setFillStyle(ACT_COL[action], 0.5);
    s.border.setStrokeStyle(2, ACT_COL[action]);
    s.label.setText(ACT_SHORT[action]);
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
    s.border.setStrokeStyle(2, ACT_COL[action]);
    s.label.setText(ACT_SHORT[action]).setColor("#e6edf3");

    this.tweens.add({
      targets: s.bg,
      scaleX: { from: 0.8, to: 1 },
      scaleY: { from: 0.8, to: 1 },
      duration: 120,
      ease: "Back.easeOut",
    });
  }

  private pulseBeat(): void {
    this.beatFlash.setAlpha(0.7);
    this.tweens.add({
      targets: this.beatFlash,
      alpha: 0,
      duration: 250,
      ease: "Sine.easeOut",
    });

    for (const obj of this.bounceTargets) {
      this.tweens.add({
        targets: obj,
        scaleX: 1.05,
        scaleY: 1.05,
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
      "[Resolve] E:",
      this.enemySeq.join(" "),
      "| P:",
      this.playerSeq.join(" "),
    );

    let step = 0;
    this.time.addEvent({
      delay: RESOLVE_MS,
      repeat: SEQ_LEN - 1,
      callback: () => {
        if (this.phase !== GamePhase.RESOLUTION) return;
        this.resolveStep(step);
        step++;
      },
    });
  }

  private resolveStep(i: number): void {
    this.highlightStep(i);

    let pAct = this.playerSeq[i];
    const eAct = this.enemySeq[i];

    if (this.playerHeat >= OVERHEAT_THRESHOLD) {
      this.ohStreak++;
      console.log(`[Step ${i}] OVERHEAT streak=${this.ohStreak}`);
      pAct = ActionType.IDLE;
      const s = this.pSlots[i];
      s.label.setText("OH!");
      s.bg.setFillStyle(PAL.heatRed, 0.7);
      if (this.ohStreak >= OVERHEAT_STREAK_LIMIT) {
        this.endGame("MELTDOWN");
        return;
      }
    } else {
      this.ohStreak = 0;
    }

    this.executeCombat(pAct, eAct, i);
    this.playerHeat = Math.max(0, this.playerHeat);
    this.refreshHUD();

    if (this.enemyHP <= 0) {
      this.onWaveWin();
      return;
    }
    if (this.playerHP <= 0) {
      this.endGame("DESTROYED");
      return;
    }

    if (i >= SEQ_LEN - 1) {
      this.time.delayedCall(Math.round(RESOLVE_MS * 1.5), () => {
        if (this.phase === GamePhase.RESOLUTION) this.startRhythmSequence();
      });
    }
  }

  /* ============================================================ */
  /*  Combat                                                        */
  /* ============================================================ */

  private executeCombat(
    pAct: ActionType,
    eAct: ActionType,
    step: number,
  ): void {
    let msg: string;
    const eR = this.enemyRect;
    const pR = this.playerRect;

    switch (pAct) {
      case ActionType.ATTACK:
        this.playerHeat += HEAT_DELTA.attack;
        if (eAct === ActionType.ATTACK) {
          this.enemyHP -= DMG.clash;
          this.playerHP -= DMG.clash;
          msg = "CLASH! Both -10";
          this.popText(eR, `-${DMG.clash}`, VFX.pop.damage);
          this.popText(pR, `-${DMG.clash}`, VFX.pop.damage);
          this.emitSparks((eR.x + pR.x) / 2, eR.y, VFX.spark.hit);
          this.flash(eR, VFX.flash.enemyHit);
          this.flash(pR, VFX.flash.playerHit);
          this.shake(120, 200);
        } else if (eAct === ActionType.GUARD) {
          msg = "BLOCKED!";
          this.emitSparks(eR.x, eR.y, VFX.spark.block);
          this.flash(eR, VFX.flash.enemyBlock);
          this.shake(30, 80);
        } else {
          this.enemyHP -= DMG.attack;
          msg = `HIT! Enemy -${DMG.attack}`;
          this.popText(eR, `-${DMG.attack}`, VFX.pop.damage);
          this.emitSparks(eR.x, eR.y, VFX.spark.hit);
          this.flash(eR, VFX.flash.enemyHit);
          this.shake(60, 140);
        }
        break;

      case ActionType.GUARD:
        if (eAct === ActionType.ATTACK) {
          msg = "GUARDED!";
          this.emitSparks(pR.x, pR.y, VFX.spark.block);
          this.flash(pR, VFX.flash.playerGuard);
          this.shake(30, 80);
        } else {
          msg = "\u2014";
        }
        break;

      case ActionType.COOL:
        this.playerHeat += HEAT_DELTA.cool;
        if (eAct === ActionType.ATTACK) {
          this.playerHP -= DMG.coolVulnerable;
          msg = `VULNERABLE! Player -${DMG.coolVulnerable}`;
          this.popText(pR, `-${DMG.coolVulnerable}`, VFX.pop.damage);
          this.emitSparks(pR.x, pR.y, VFX.spark.crit);
          this.flash(pR, VFX.flash.playerHit);
          this.shake(180, 250);
        } else {
          msg = "COOLING\u2026";
          this.popText(pR, "COOL", VFX.pop.cool);
          this.flash(pR, VFX.flash.playerCool);
        }
        break;

      case ActionType.SPECIAL:
        this.playerHeat += HEAT_DELTA.special;
        if (eAct === ActionType.GUARD) {
          this.enemyHP -= DMG.specialVsGuard;
          msg = `BREAK! Enemy -${DMG.specialVsGuard}`;
          this.popText(eR, `-${DMG.specialVsGuard}`, VFX.pop.special);
        } else {
          this.enemyHP -= DMG.special;
          msg = `SPECIAL! Enemy -${DMG.special}`;
          this.popText(eR, `-${DMG.special}`, VFX.pop.special);
        }
        this.emitSparks(eR.x, eR.y, VFX.spark.special);
        this.flash(eR, VFX.flash.enemySpecial);
        this.shake(200, 300);
        break;

      default:
        if (eAct === ActionType.ATTACK) {
          this.playerHP -= DMG.attack;
          msg = `HIT! Player -${DMG.attack}`;
          this.popText(pR, `-${DMG.attack}`, VFX.pop.damage);
          this.emitSparks(pR.x, pR.y, VFX.spark.hit);
          this.flash(pR, VFX.flash.playerHit);
          this.shake(60, 140);
        } else {
          msg = "\u2014";
        }
        break;
    }

    console.log(`[Step ${step}] P:${pAct} vs E:${eAct} \u2192 ${msg}`);
    this.showMessage(msg);
  }

  /* ============================================================ */
  /*  Win / Lose                                                    */
  /* ============================================================ */

  private onWaveWin(): void {
    // Stay in RESOLUTION during the blink animation to prevent
    // updateRhythm from running with stale timing state.
    this.score++;
    this.scoreLabel.setText(`SCORE: ${this.score}`);
    console.log(`[Wave] Defeated! Score: ${this.score}`);

    this.tweens.add({
      targets: this.enemyRect,
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
    this.setPhaseDisplay("GAME OVER", "#ff4444");
    console.log(`[GameOver] ${reason} | Score: ${this.score}`);

    this.goScoreText.setText(`Score: ${this.score}  \u2014 ${reason}`);
    this.goLayer.setVisible(true).setAlpha(0);
    this.tweens.add({ targets: this.goLayer, alpha: 1, duration: 600 });
  }

  /* ============================================================ */
  /*  HUD helpers                                                   */
  /* ============================================================ */

  private refreshHUD(): void {
    const eh = Math.max(0, this.enemyHP);
    const ph = Math.max(0, this.playerHP);
    const ht = Math.max(0, this.playerHeat);

    this.enemyHPText.setText(`HP ${eh}`);
    this.enemyHPBar.displayWidth = this.barMaxW * (eh / HP_INIT.enemy);

    this.playerHPText.setText(`HP ${ph}`);
    this.playerHPBar.displayWidth = this.barMaxW * (ph / HP_INIT.player);

    this.playerHeatText.setText(`HEAT ${ht}`);
    this.playerHeatBar.displayWidth =
      this.barMaxW * Math.min(1, ht / OVERHEAT_THRESHOLD);

    if (ht >= OVERHEAT_THRESHOLD) {
      this.playerHeatBar.setFillStyle(PAL.heatRed);
      this.playerHeatText.setColor("#ff0000");
    } else if (ht >= 70) {
      this.playerHeatBar.setFillStyle(0xff4400);
      this.playerHeatText.setColor("#ff4400");
    } else {
      this.playerHeatBar.setFillStyle(PAL.heatOrange);
      this.playerHeatText.setColor("#ff6600");
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
    const all = this.eSlots.concat(this.pSlots);
    for (const s of all) {
      s.bg.setFillStyle(PAL.slotBg).setAlpha(1).setScale(1);
      s.border.setFillStyle();
      s.border.setStrokeStyle(2, PAL.slotStroke);
      s.border.setScale(1);
      s.label.setText("").setAlpha(1).setColor("#e6edf3");
    }
  }

  private highlightStep(idx: number): void {
    for (let i = 0; i < SEQ_LEN; i++) {
      const a = i === idx ? 1 : 0.3;
      this.eSlots[i].bg.setAlpha(a);
      this.eSlots[i].label.setAlpha(a);
      this.pSlots[i].bg.setAlpha(a);
      this.pSlots[i].label.setAlpha(a);
    }
    this.eSlots[idx].border.setStrokeStyle(3, PAL.highlight);
    this.pSlots[idx].border.setStrokeStyle(3, PAL.highlight);
  }

  private enableButtons(on: boolean): void {
    for (const b of this.btns) {
      if (on) {
        b.container.setInteractive({ useHandCursor: true });
        b.bg.setFillStyle(PAL.btnOn).setAlpha(1);
      } else {
        b.container.disableInteractive();
        b.bg.setFillStyle(PAL.btnOff).setAlpha(0.5);
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

  private shake(intensity: number, duration = 140): void {
    this.cameras.main.shake(duration, intensity / 10000);
  }

  private flash(rect: Phaser.GameObjects.Rectangle, color: number): void {
    const orig = rect === this.enemyRect ? PAL.enemy : PAL.player;
    rect.setFillStyle(color);
    this.time.delayedCall(120, () => rect.setFillStyle(orig));
  }

  private popText(
    target: Phaser.GameObjects.Rectangle,
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
      .setDepth(50);

    this.tweens.add({
      targets: t,
      y: startY - 44,
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
    emitter.setDepth(40);
    emitter.explode(14);
    this.time.delayedCall(600, () => emitter.destroy());
  }

  /* ============================================================ */
  /*  Resize                                                        */
  /* ============================================================ */

  private onResize(size: Phaser.Structs.Size): void {
    this.cameras.main.setViewport(0, 0, size.width, size.height);
  }
}
