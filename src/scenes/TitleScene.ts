import Phaser from "phaser";

import {
  DIFFICULTY_CONFIGS,
  DIFFICULTY_ORDER,
  type Difficulty,
} from "../config/difficulty";
import { audio } from "../audio/AudioManager";
import { notifyWavedashLoadComplete } from "../utils/wavedash";

/* ===================================================================
 *  TitleScene — "Mech OS Boot Sequence"
 *
 *  Visual layers (back → front):
 *    1. Background fill #0b0f14
 *    2. Giant mech silhouette (alpha 0.15, centred)
 *    3. Edge vignette (dark strip corners)
 *    4. ADD-blend glow copies of title text
 *    5. Title / sub-title
 *    6. Terminal boot-log (sequential reveal)
 *    7. Difficulty selector pills (staggered reveal)
 *    8. [ ENGAGE ] button  ← 60 BPM beat pulse
 *    9. Footer key hints
 * =================================================================== */

// =====================================================================
//  Constants
// =====================================================================

/** Base 60 BPM — matches normal / wave-1 endless tempo in `difficulty.ts`. */
const BEAT_MS = DIFFICULTY_CONFIGS.normal.beatMs;

const FONT_DELA = '"Dela Gothic One", Impact, "Arial Black", sans-serif';
const FONT_MONO = "'Courier New', Courier, monospace";
const FONT_UI = "system-ui, 'Segoe UI', sans-serif";

/** Terminal boot log. Each line fades in sequentially. */
const BOOT_LOG: ReadonlyArray<{ text: string; color: string }> = [
  { text: "> PACIFIC RHYTHM OS  v0.1.0", color: "#3a4a3a" },
  { text: "> COMBAT SUBSYSTEMS      [OK]", color: "#2a5a2a" },
  { text: "> KAIJU DETECTION ARRAY  [OK]", color: "#2a5a2a" },
  { text: "> WEAPON INTERFACE       [OK]", color: "#2a5a2a" },
  { text: "> RHYTHM CORE            [ARMED]", color: "#7a6600" },
  { text: "> SELECT OPERATION MODE  ------", color: "#5a5a6a" },
];

/** ms between each boot-log line appearing */
const LOG_LINE_DELAY_MS = 130;

/** Total ms before UI elements (difficulty / engage) become visible */
const UI_REVEAL_DELAY_MS = 200 + BOOT_LOG.length * LOG_LINE_DELAY_MS + 180;

/**
 * Phaser 3 does not run hit tests on `alpha: 0` game objects, so a fully
 * transparent button never receives the pointer. Use a tiny non-zero
 * alpha until the reveal tweens start (visually identical to invisible).
 */
const HIT_ALPHA = 0.01;

/** Extra padding (logical px) around pill / ENGAGE hit areas for easier pointing. */
const HIT_PAD_PILL = 8;
const HIT_PAD_ENGAGE = 12;

// =====================================================================
//  Scene
// =====================================================================

export class TitleScene extends Phaser.Scene {
  private selectedIndex = 1; // default: NORMAL

  private diffButtons: Array<{
    diff: Difficulty;
    container: Phaser.GameObjects.Container;
    bg: Phaser.GameObjects.Rectangle;
    label: Phaser.GameObjects.Text;
  }> = [];

  private engageContainer!: Phaser.GameObjects.Container;
  private engageBg!: Phaser.GameObjects.Rectangle;
  private engageGlow!: Phaser.GameObjects.Rectangle;

  private beatTimer?: Phaser.Time.TimerEvent;
  private starting = false;
  private bgmStarted = false;

  /**
   * Every Text rendered in DelaGothicOne is collected here.
   * fonts.ready fires updateText() to swap the fallback face out.
   */
  private delaGothicTexts: Phaser.GameObjects.Text[] = [];

  /** Keys registered for the title menu; cleared in `shutdown` so a return to this scene replays `addKey` cleanly. */
  private titleKeyboardKeys: Phaser.Input.Keyboard.Key[] = [];

  /** Focus the game canvas on pointer (embeds and browsers often ignore key events until the canvas is focused). */
  private focusCanvasOnPointer = (): void => {
    this.game.canvas?.focus();
  };

  constructor() {
    super("TitleScene");
  }

  // ================================================================
  //  Lifecycle
  // ================================================================

  create(): void {
    const W = this.scale.width;
    const H = this.scale.height;

    // Coming from `MainScene` (GAME OVER fade / handoff), a non‑1 time scale
    // or a half-finished camera fade can leave this scene inert. Normalise
    // before building UI so tweens, beat timer, and BGM schedule run.
    this.time.timeScale = 1;
    this.tweens.timeScale = 1;
    this.cameras.main.resetFX();
    this.cameras.main.setAlpha(1);
    this.cameras.main.setBackgroundColor(0x0b0f14);

    this.buildBackground(W, H);
    this.buildTitleGlow(W);
    this.buildTitle(W);
    this.buildBootLog(W, H);
    this.buildDifficultySelector(W, H);
    this.buildEngageButton(W, H);
    this.buildFooter(W, H);

    this.refreshSelection();
    this.setupCanvasKeyboardFocus();
    this.setupKeyboard();
    this.startBeatTimer();
    this.tryStartBgm();

    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready
        .then(() => {
          for (const t of this.delaGothicTexts) {
            if (t?.active) t.updateText();
          }
        })
        .catch(() => void 0);
    }

    notifyWavedashLoadComplete();
  }

  shutdown(): void {
    this.beatTimer?.remove();
    audio.stopTitleBgm();
    this.bgmStarted = false;
    this.clearTitleKeyboard();
    this.input.off("pointerdown", this.focusCanvasOnPointer);
  }

  // ================================================================
  //  Build — Background
  // ================================================================

  private buildBackground(W: number, H: number): void {
    // ---- Mech silhouette ----------------------------------------
    // Centred on the canvas, large enough to dominate the background,
    // alpha dimmed to 0.15 so it reads as a ghost / shadow presence.
    const sz = Math.min(W * 0.52, H * 0.82);
    this.add
      .image(W / 2, H * 0.46, "mech-player")
      .setDisplaySize(sz, sz)
      .setAlpha(0.15);

    // ---- Edge vignette ------------------------------------------
    // Four dark strips (top / bottom / left / right) focus attention
    // on the centre and reinforce the "narrow monitor" aesthetic.
    const vx = W * 0.22;
    const vy = H * 0.18;
    const va = 0.62;
    this.add.rectangle(0, H / 2, vx, H, 0x000000, va).setOrigin(0, 0.5);
    this.add.rectangle(W, H / 2, vx, H, 0x000000, va).setOrigin(1, 0.5);
    this.add.rectangle(W / 2, 0, W, vy, 0x000000, va).setOrigin(0.5, 0);
    this.add.rectangle(W / 2, H, W, vy, 0x000000, va).setOrigin(0.5, 1);

    // ---- Horizontal accent lines --------------------------------
    // Thin rules that evoke a CRT grid / military HUD border.
    const lineColor = 0x1a2540;
    for (const y of [H * 0.11, H * 0.89]) {
      this.add.rectangle(W / 2, y, W * 0.88, 1, lineColor, 0.8).setOrigin(0.5);
    }

    // ---- System-status corner text ------------------------------
    this.add
      .text(22, 10, "[ PACIFIC RHYTHM OS ]", {
        fontFamily: FONT_MONO,
        fontSize: "9px",
        color: "#1e2e1e",
      })
      .setOrigin(0, 0);

    // Blinking status dot (top-right)
    const dot = this.add
      .rectangle(W - 18, 14, 5, 5, 0x22aa22, 0.9)
      .setOrigin(0.5);
    this.tweens.add({
      targets: dot,
      alpha: { from: 0.9, to: 0.15 },
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  // ================================================================
  //  Build — Title glow + title text
  // ================================================================

  /**
   * Two semi-transparent ADD-blend copies of the title text create a
   * "phosphor glow" halo without requiring a shader or render texture.
   */
  private buildTitleGlow(W: number): void {
    const glowLayers = [
      { scale: 1.1, alpha: 0.12 },
      { scale: 1.04, alpha: 0.2 },
    ];
    for (const g of glowLayers) {
      this.add
        .text(W / 2, 60, "PACIFIC RHYTHM", {
          fontFamily: FONT_DELA,
          fontSize: "48px",
          color: "#ff5533",
        })
        .setOrigin(0.5, 0)
        .setScale(g.scale)
        .setAlpha(g.alpha)
        .setBlendMode(Phaser.BlendModes.ADD);
    }
  }

  private buildTitle(W: number): void {
    // Main title text — white with a warm drop-shadow.
    const title = this.add
      .text(W / 2, 60, "PACIFIC RHYTHM", {
        fontFamily: FONT_DELA,
        fontSize: "48px",
        color: "#e6edf3",
      })
      .setOrigin(0.5, 0)
      .setShadow(0, 0, "#ff4422", 16, false, true);

    this.delaGothicTexts.push(title);

    // 60 BPM heartbeat (matches the game's base tempo).
    this.tweens.add({
      targets: title,
      scale: { from: 1, to: 1.022 },
      duration: 500,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    // Sub-title — high contrast + ADD glow (same idea as the main title)
    const subY = 110;
    const subGlow: ReadonlyArray<{ scale: number; alpha: number }> = [
      { scale: 1.12, alpha: 0.14 },
      { scale: 1.04, alpha: 0.22 },
    ];
    for (const g of subGlow) {
      this.add
        .text(W / 2, subY, "ROBOT vs KAIJU", {
          fontFamily: FONT_DELA,
          fontSize: "22px",
          color: "#ff7744",
        })
        .setOrigin(0.5, 0)
        .setScale(g.scale)
        .setAlpha(g.alpha)
        .setBlendMode(Phaser.BlendModes.ADD);
    }
    const subTitle = this.add
      .text(W / 2, subY, "ROBOT vs KAIJU", {
        fontFamily: FONT_DELA,
        fontSize: "22px",
        color: "#e8f0f8",
        stroke: "#0b0f14",
        strokeThickness: 5,
      })
      .setOrigin(0.5, 0)
      .setShadow(0, 2, "#000000", 8, true, true);
    this.delaGothicTexts.push(subTitle);
  }

  // ================================================================
  //  Build — OS boot log
  // ================================================================

  private buildBootLog(W: number, H: number): void {
    const startY = H * 0.27;
    const lineH = 20;
    // Left-aligned at ~10 % from the left edge.
    const logX = W * 0.1;

    BOOT_LOG.forEach((line, i) => {
      const t = this.add
        .text(logX - 10, startY + i * lineH, line.text, {
          fontFamily: FONT_MONO,
          fontSize: "10px",
          color: line.color,
        })
        .setOrigin(0, 0)
        .setAlpha(0);

      // Each line slides in slightly from the left
      this.time.delayedCall(200 + i * LOG_LINE_DELAY_MS, () => {
        if (!t.active) return;
        this.tweens.add({
          targets: t,
          alpha: 1,
          x: logX,
          duration: 160,
          ease: "Sine.easeOut",
        });
      });
    });

    // Blinking cursor at the end of the last boot-log line
    const cursorY = startY + (BOOT_LOG.length - 1) * lineH;
    const cursor = this.add
      .text(logX + 210, cursorY, "_", {
        fontFamily: FONT_MONO,
        fontSize: "10px",
        color: "#5a6a5a",
      })
      .setOrigin(0, 0)
      .setAlpha(0);

    this.time.delayedCall(200 + (BOOT_LOG.length - 1) * LOG_LINE_DELAY_MS + 180, () => {
      if (!cursor.active) return;
      cursor.setAlpha(1);
      this.tweens.add({
        targets: cursor,
        alpha: { from: 1, to: 0 },
        duration: 550,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    });
  }

  // ================================================================
  //  Build — Difficulty selector
  // ================================================================

  private buildDifficultySelector(W: number, H: number): void {
    const selectorY = H * 0.59;
    const btnW = 116;
    const btnH = 38;
    const hitW = btnW + HIT_PAD_PILL * 2;
    const hitH = btnH + HIT_PAD_PILL * 2;
    const gap = 10;
    const totalW =
      DIFFICULTY_ORDER.length * btnW + (DIFFICULTY_ORDER.length - 1) * gap;
    const startCX = W / 2 - totalW / 2 + btnW / 2;

    // Section label above the difficulty pills
    const modeLabel = this.add
      .text(W / 2, selectorY - 30, "SELECT DIFFICULTY", {
        fontFamily: FONT_DELA,
        fontSize: "15px",
        color: "#c8d8f0",
        stroke: "#0b0f14",
        strokeThickness: 4,
      })
      .setOrigin(0.5, 1)
      .setAlpha(0)
      .setShadow(0, 2, "#000000", 6, true, true);
    this.delaGothicTexts.push(modeLabel);

    this.time.delayedCall(UI_REVEAL_DELAY_MS, () => {
      if (modeLabel.active) {
        this.tweens.add({ targets: modeLabel, alpha: 1, duration: 280 });
      }
    });

    this.diffButtons = [];

    DIFFICULTY_ORDER.forEach((diff, i) => {
      const cfg = DIFFICULTY_CONFIGS[diff];
      const cx = startCX + i * (btnW + gap);

      const bg = this.add
        .rectangle(0, 0, btnW, btnH, 0x1a1f2e)
        .setStrokeStyle(1, 0x3d4663);

      const labelTxt = this.add
        .text(0, 0, cfg.label, {
          fontFamily: FONT_DELA,
          fontSize: "15px",
          color: "#e6edf3",
        })
        .setOrigin(0.5, 0.5);
      this.delaGothicTexts.push(labelTxt);

      const ctr = this.add
        .container(cx, selectorY, [bg, labelTxt])
        .setSize(btnW, btnH)
        .setAlpha(HIT_ALPHA)
        .setDepth(50);

      ctr.setInteractive({
        hitArea: new Phaser.Geom.Rectangle(
          -hitW / 2,
          -hitH / 2,
          hitW,
          hitH,
        ),
        hitAreaCallback: Phaser.Geom.Rectangle.Contains,
        useHandCursor: true,
      });

      ctr.on("pointerover", () => {
        if (this.starting) return;
        this.selectedIndex = i;
        this.refreshSelection();
      });
      ctr.on("pointerdown", () => {
        if (this.starting) return;
        this.selectedIndex = i;
        audio.playClick();
        this.refreshSelection();
      });

      // Stagger appearance: each pill slides up from below
      this.time.delayedCall(UI_REVEAL_DELAY_MS + i * 70, () => {
        if (!ctr.active) return;
        ctr.y = selectorY + 16;
        this.tweens.add({
          targets: ctr,
          alpha: 1,
          y: selectorY,
          duration: 280,
          ease: "Back.easeOut",
        });
      });

      this.diffButtons.push({ diff, container: ctr, bg, label: labelTxt });
    });
  }

  // ================================================================
  //  Build — ENGAGE button
  // ================================================================

  private buildEngageButton(W: number, H: number): void {
    const by = H * 0.77;
    const bw = 270;
    const bh = 60;

    // Glow aura behind the button (ADD-blend rectangle)
    this.engageGlow = this.add
      .rectangle(W / 2, by, bw + 40, bh + 40, 0xff4400, 0.14)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setDepth(40)
      .setAlpha(0);

    // Button background
    this.engageBg = this.add
      .rectangle(0, 0, bw, bh, 0x5c1800)
      .setStrokeStyle(2, 0xff6600);

    // Main label
    const engageLabel = this.add
      .text(0, -2, "[ ENGAGE ]", {
        fontFamily: FONT_DELA,
        fontSize: "30px",
        color: "#ff8833",
      })
      .setOrigin(0.5);
    this.delaGothicTexts.push(engageLabel);

    // Sub-hint text below the button (not inside the container hit area)
    const subLabel = this.add
      .text(W / 2, by + bh / 2 + 12, "ENTER · SPACE · CLICK", {
        fontFamily: FONT_MONO,
        fontSize: "9px",
        color: "#3a2810",
      })
      .setOrigin(0.5, 0)
      .setAlpha(0);

    // Assemble container
    this.engageContainer = this.add
      .container(W / 2, by, [this.engageBg, engageLabel])
      .setSize(bw, bh)
      .setAlpha(HIT_ALPHA)
      .setDepth(50);

    const eHitW = bw + HIT_PAD_ENGAGE * 2;
    const eHitH = bh + HIT_PAD_ENGAGE * 2;
    this.engageContainer.setInteractive({
      hitArea: new Phaser.Geom.Rectangle(
        -eHitW / 2,
        -eHitH / 2,
        eHitW,
        eHitH,
      ),
      hitAreaCallback: Phaser.Geom.Rectangle.Contains,
      useHandCursor: true,
    });

    this.engageContainer
      .on("pointerover", () => {
        if (!this.starting) {
          this.engageBg
            .setFillStyle(0x7a2a00)
            .setStrokeStyle(2, 0xffaa44);
        }
      })
      .on("pointerout", () => {
        if (!this.starting) {
          this.engageBg
            .setFillStyle(0x5c1800)
            .setStrokeStyle(2, 0xff6600);
        }
      })
      .on("pointerdown", () => {
        if (!this.starting) this.engage();
      });

    // Dramatic scale-in reveal
    const revealDelay = UI_REVEAL_DELAY_MS + DIFFICULTY_ORDER.length * 70 + 100;
    this.time.delayedCall(revealDelay, () => {
      if (!this.engageContainer.active) return;
      this.engageContainer.setScale(0.6);
      this.tweens.add({
        targets: this.engageContainer,
        alpha: 1,
        scale: 1,
        duration: 440,
        ease: "Back.easeOut",
      });
      this.tweens.add({
        targets: [this.engageGlow, subLabel],
        alpha: 1,
        duration: 440,
      });
    });
  }

  // ================================================================
  //  Build — Footer
  // ================================================================

  private buildFooter(W: number, H: number): void {
    this.add
      .text(
        W / 2,
        H - 24,
        "\u2190 \u2192 / A D / \u2191 \u2193  DIFF     1-3  SLOT     ENTER / SPACE  ENGAGE  (CLICK)",
        {
          fontFamily: FONT_UI,
          fontSize: "11px",
          color: "#242a36",
        },
      )
      .setOrigin(0.5);

    this.add
      .text(W / 2, H - 9, "Pacific Rhythm \u00B7 Gamedev.js Jam 2026", {
        fontFamily: FONT_UI,
        fontSize: "9px",
        color: "#1c2230",
      })
      .setOrigin(0.5);
  }

  // ================================================================
  //  Beat timer — 60 BPM pulse
  // ================================================================

  private startBeatTimer(): void {
    this.beatTimer = this.time.addEvent({
      delay: BEAT_MS,
      loop: true,
      callback: this.onBeat,
      callbackScope: this,
    });
  }

  /**
   * Fires every 1000 ms (60 BPM).
   * Plays a beat SFX (if audio is live) and scales the ENGAGE button
   * up then back to simulate a physical pulse matching the game tempo.
   */
  private onBeat(): void {
    if (this.starting) return;

    // Audio — only if the context has been unlocked by a user gesture
    if (audio.isContextRunning()) audio.playBeat();

    if (!this.engageContainer?.active) return;

    // Kill any in-progress scale tween so pulses don't stack
    this.tweens.killTweensOf(this.engageContainer);
    this.tweens.add({
      targets: this.engageContainer,
      scale: { from: 1.055, to: 1 },
      duration: 420,
      ease: "Sine.easeOut",
    });

    // Stroke colour flash
    this.engageBg.setStrokeStyle(2, 0xffaa44);
    this.time.delayedCall(130, () => {
      if (this.engageBg?.active && !this.starting) {
        this.engageBg.setStrokeStyle(2, 0xff6600);
      }
    });

    // Glow intensity pulse
    if (this.engageGlow?.active) {
      this.tweens.killTweensOf(this.engageGlow);
      this.tweens.add({
        targets: this.engageGlow,
        alpha: { from: 0.32, to: 0.14 },
        duration: 520,
        ease: "Sine.easeOut",
      });
    }
  }

  // ================================================================
  //  Keyboard
  // ================================================================

  /**
   * Embeds and most browsers only deliver `keydown` to the focused
   * element. Make the canvas focusable and follow the first pointer
   * on the game so the same pattern as `MainScene` input works
   * (`addKey` + `on("down")`).
   */
  private setupCanvasKeyboardFocus(): void {
    const canvas = this.game.canvas;
    if (canvas) {
      canvas.setAttribute("tabindex", "0");
      canvas.style.outline = "none";
    }
    this.input.on("pointerdown", this.focusCanvasOnPointer);
  }

  private clearTitleKeyboard(): void {
    const kb = this.input.keyboard;
    if (!kb) return;
    for (const key of this.titleKeyboardKeys) {
      key.removeAllListeners();
      kb.removeKey(key, true);
    }
    this.titleKeyboardKeys.length = 0;
  }

  private setupKeyboard(): void {
    const kb = this.input.keyboard;
    if (!kb) return;

    kb.addCapture(
      "UP,DOWN,LEFT,RIGHT,W,A,S,D,SPACE,ENTER,ONE,TWO,THREE",
    );

    const K = Phaser.Input.Keyboard.KeyCodes;
    const track = (key: Phaser.Input.Keyboard.Key) => {
      this.titleKeyboardKeys.push(key);
    };
    const bind = (code: number, fn: () => void) => {
      const key = kb.addKey(code);
      key.on("down", fn);
      track(key);
    };

    const movePrev = () => {
      this.moveDiff(-1);
    };
    const moveNext = () => {
      this.moveDiff(1);
    };

    bind(K.UP, movePrev);
    bind(K.W, movePrev);
    bind(K.LEFT, movePrev);
    bind(K.A, movePrev);
    bind(K.DOWN, moveNext);
    bind(K.S, moveNext);
    bind(K.RIGHT, moveNext);
    bind(K.D, moveNext);

    bind(K.ENTER, () => {
      this.engage();
    });
    bind(K.SPACE, () => {
      this.engage();
    });

    bind(K.ONE, () => {
      this.selectDifficultyByIndex(0);
    });
    bind(K.TWO, () => {
      this.selectDifficultyByIndex(1);
    });
    bind(K.THREE, () => {
      this.selectDifficultyByIndex(2);
    });
  }

  private selectDifficultyByIndex(i: number): void {
    if (this.starting) return;
    const n = this.diffButtons.length;
    if (i < 0 || i >= n) return;
    this.selectedIndex = i;
    audio.playClick();
    this.refreshSelection();
  }

  private moveDiff(delta: number): void {
    if (this.starting) return;
    const n = this.diffButtons.length;
    this.selectedIndex = (this.selectedIndex + delta + n) % n;
    audio.playClick();
    this.refreshSelection();
  }

  // ================================================================
  //  Selection state
  // ================================================================

  private refreshSelection(): void {
    this.diffButtons.forEach((b, i) => {
      const sel = i === this.selectedIndex;
      b.bg
        .setFillStyle(sel ? 0x2a354e : 0x1a1f2e)
        .setStrokeStyle(sel ? 2 : 1, sel ? 0xffcc00 : 0x3d4663);
      b.label.setColor(sel ? "#ffe066" : "#e6edf3");
    });
  }

  // ================================================================
  //  ENGAGE — dramatic transition sequence
  // ================================================================

  private engage(): void {
    if (this.starting) return;
    this.starting = true;

    // Stop the beat timer so no more pulses interfere with the transition
    this.beatTimer?.remove();

    const diff: Difficulty =
      this.diffButtons[this.selectedIndex]?.diff ?? "normal";

    // Unlock audio and kill BGM
    audio.unlock();
    audio.stopTitleBgm();

    // 1. Heavy SFX — rising sawtooth charge + discharge crackle
    audio.playSpecial();

    // 2. Button sink
    this.tweens.add({
      targets: this.engageContainer,
      scale: 0.9,
      duration: 80,
      ease: "Cubic.easeIn",
    });

    // 3. Camera shake — violent, matching "mech booting up"
    this.cameras.main.shake(300, 0.05);

    // 4. White flash — bright, brief, decisive
    this.cameras.main.flash(200, 255, 255, 255);

    // 5. Immediate scene handoff ~300 ms after the flash peak
    this.time.delayedCall(300, () => {
      this.scene.start("MainScene", { difficulty: diff });
    });
  }

  // ================================================================
  //  BGM
  // ================================================================

  private tryStartBgm(): void {
    if (this.bgmStarted) return;

    if (audio.isContextRunning()) {
      this.bgmStarted = true;
      audio.startTitleBgm();
      return;
    }

    const onGesture = (): void => {
      if (this.bgmStarted) return;
      this.bgmStarted = true;
      audio.unlock();
      audio.startTitleBgm();
    };

    this.input.once("pointerdown", onGesture);
    this.input.keyboard?.once("keydown", onGesture);
  }
}
