import Phaser from "phaser";

import {
  DIFFICULTY_CONFIGS,
  DIFFICULTY_ORDER,
  type Difficulty,
} from "../config/difficulty";
import { audio } from "../audio/AudioManager";
import { formatBestSummary } from "../utils/records";
import { notifyWavedashLoadComplete } from "../utils/wavedash";

/**
 * Title / main-menu scene.
 *
 * Responsible for difficulty selection, best-record preview, and the
 * single pulsing-title moment that sets the "serious mech game" tone
 * before the player ever sees the main combat loop.
 *
 * No game state lives here — everything we collect (difficulty) is
 * forwarded to MainScene via `scene.start("MainScene", { difficulty })`.
 * All gameplay numbers come from `src/config/difficulty.ts` so tuning
 * run length is a pure config edit.
 */
export class TitleScene extends Phaser.Scene {
  private selectedIndex = 1; // default to NORMAL
  private buttons: Array<{
    diff: Difficulty;
    container: Phaser.GameObjects.Container;
    bg: Phaser.GameObjects.Rectangle;
    label: Phaser.GameObjects.Text;
    best: Phaser.GameObjects.Text;
    tagline: Phaser.GameObjects.Text;
  }> = [];
  private titleText?: Phaser.GameObjects.Text;
  private starting = false;
  private bgmStarted = false;

  constructor() {
    super("TitleScene");
  }

  create(): void {
    const W = this.scale.width;
    const H = this.scale.height;
    this.cameras.main.setBackgroundColor(0x0b0f14);

    this.buildTitle(W, H);
    this.buildButtons(W, H);
    this.buildFooter(W, H);
    this.refreshSelection();

    this.setupKeyboard();
    this.startHeartbeat();
    this.tryStartBgm();

    // Dela Gothic One ships via the <link> in index.html but the
    // browser may finish loading the font *after* Phaser has rasterised
    // the title canvas. Forcing a text refresh on fonts.ready swaps the
    // fallback (Impact / Arial Black) out for the real typeface once it
    // arrives — without this, the title stays in the fallback forever
    // on cold-start networks.
    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready
        .then(() => {
          if (this.titleText && this.titleText.active) {
            this.titleText.updateText();
          }
        })
        .catch(() => void 0);
    }

    notifyWavedashLoadComplete();
  }

  // ================================================================
  //  Build
  // ================================================================

  private buildTitle(W: number, _H: number): void {
    this.titleText = this.add
      .text(W / 2, 64, "PACIFIC RHYTHM", {
        fontFamily: '"Dela Gothic One", Impact, "Arial Black", sans-serif',
        fontSize: "46px",
        color: "#e6edf3",
      })
      .setOrigin(0.5, 0)
      .setShadow(0, 2, "#ff4444", 10, false, true);

    this.add
      .text(W / 2, 118, "ROBOT vs KAIJU", {
        fontFamily: "system-ui, 'Segoe UI', sans-serif",
        fontSize: "15px",
        color: "#8b949e",
      })
      .setOrigin(0.5, 0);
  }

  private buildButtons(W: number, _H: number): void {
    const bw = 360;
    const bh = 46;
    const gap = 76;
    const firstY = 190;
    const cx = W / 2;

    DIFFICULTY_ORDER.forEach((diff, i) => {
      const cfg = DIFFICULTY_CONFIGS[diff];
      const y = firstY + i * gap;

      const bg = this.add
        .rectangle(0, 0, bw, bh, 0x1a1f2e)
        .setStrokeStyle(2, 0x3d4663);
      const label = this.add
        .text(-bw / 2 + 20, 0, cfg.label, {
          fontFamily: '"Dela Gothic One", Impact, "Arial Black", sans-serif',
          fontSize: "22px",
          color: "#e6edf3",
        })
        .setOrigin(0, 0.5);
      const best = this.add
        .text(bw / 2 - 20, 0, formatBestSummary(diff), {
          fontFamily: "system-ui, 'Segoe UI', sans-serif",
          fontSize: "13px",
          color: "#8b949e",
        })
        .setOrigin(1, 0.5);
      const tagline = this.add
        .text(0, bh / 2 + 12, cfg.tagline, {
          fontFamily: "system-ui, 'Segoe UI', sans-serif",
          fontSize: "11px",
          color: "#6e7681",
        })
        .setOrigin(0.5, 0);

      const container = this.add.container(cx, y, [bg, label, best, tagline]);
      container.setSize(bw, bh);
      container.setInteractive(
        new Phaser.Geom.Rectangle(-bw / 2, -bh / 2, bw, bh),
        Phaser.Geom.Rectangle.Contains,
      );
      container.on("pointerover", () => {
        this.selectedIndex = i;
        this.refreshSelection();
      });
      container.on("pointerdown", () => {
        this.selectedIndex = i;
        this.confirm();
      });

      this.buttons.push({ diff, container, bg, label, best, tagline });
    });
  }

  private buildFooter(W: number, H: number): void {
    this.add
      .text(
        W / 2,
        H - 40,
        "\u2191 \u2193 / W S    SELECT        ENTER / SPACE / CLICK    START",
        {
          fontFamily: "system-ui, 'Segoe UI', sans-serif",
          fontSize: "12px",
          color: "#6e7681",
        },
      )
      .setOrigin(0.5);
    this.add
      .text(W / 2, H - 20, "Pacific Rhythm \u00B7 Gamedev.js Jam 2026", {
        fontFamily: "system-ui, 'Segoe UI', sans-serif",
        fontSize: "10px",
        color: "#4b5363",
      })
      .setOrigin(0.5);
  }

  // ================================================================
  //  Interaction
  // ================================================================

  private setupKeyboard(): void {
    const kb = this.input.keyboard;
    if (!kb) return;
    // Capture the nav keys so arrow keys don't scroll the host page
    // when the canvas is embedded (YouTube Playables, itch, etc.).
    kb.addCapture([
      Phaser.Input.Keyboard.KeyCodes.UP,
      Phaser.Input.Keyboard.KeyCodes.DOWN,
      Phaser.Input.Keyboard.KeyCodes.W,
      Phaser.Input.Keyboard.KeyCodes.S,
      Phaser.Input.Keyboard.KeyCodes.SPACE,
      Phaser.Input.Keyboard.KeyCodes.ENTER,
    ]);
    kb.on("keydown-UP", () => this.move(-1));
    kb.on("keydown-W", () => this.move(-1));
    kb.on("keydown-DOWN", () => this.move(1));
    kb.on("keydown-S", () => this.move(1));
    kb.on("keydown-ENTER", () => this.confirm());
    kb.on("keydown-SPACE", () => this.confirm());
  }

  private move(delta: number): void {
    const n = this.buttons.length;
    this.selectedIndex = (this.selectedIndex + delta + n) % n;
    this.refreshSelection();
  }

  private refreshSelection(): void {
    this.buttons.forEach((b, i) => {
      const selected = i === this.selectedIndex;
      b.bg
        .setFillStyle(selected ? 0x2a354e : 0x1a1f2e)
        .setStrokeStyle(selected ? 2 : 1, selected ? 0xffcc00 : 0x3d4663);
      b.label.setColor(selected ? "#ffe066" : "#e6edf3");
    });
  }

  private confirm(): void {
    if (this.starting) return;
    this.starting = true;
    const btn = this.buttons[this.selectedIndex];
    if (!btn) return;
    const diff: Difficulty = btn.diff;
    audio.stopTitleBgm();
    // Short fade-to-black transition so the tonal shift from the
    // menu to the combat arena feels intentional.
    this.cameras.main.fadeOut(260, 0, 0, 0);
    this.cameras.main.once(
      Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE,
      () => {
        this.scene.start("MainScene", { difficulty: diff });
      },
    );
  }

  shutdown(): void {
    audio.stopTitleBgm();
    this.bgmStarted = false;
  }

  // ================================================================
  //  BGM
  // ================================================================

  /**
   * Starts the title BGM as soon as the AudioContext is running.
   * If it is still suspended (autoplay policy), defers to the first
   * pointer or key event — whichever fires first.
   */
  private tryStartBgm(): void {
    if (this.bgmStarted) return;

    // AudioContext already running (e.g. returning from MainScene).
    if (audio.isContextRunning()) {
      this.bgmStarted = true;
      audio.startTitleBgm();
      return;
    }

    // Defer until the first user gesture unlocks the AudioContext.
    const onGesture = (): void => {
      if (this.bgmStarted) return;
      this.bgmStarted = true;
      audio.unlock();
      audio.startTitleBgm();
    };

    this.input.once("pointerdown", onGesture);
    this.input.keyboard?.once("keydown", onGesture);
  }

  // ================================================================
  //  VFX
  // ================================================================

  /**
   * Subtle heartbeat pulse on the title, tied to 60 BPM so the player
   * internalises the tempo before they ever reach the combat loop.
   * We drive it with a yoyo tween rather than an audio callback so no
   * AudioContext gesture unlock is needed on the title screen.
   */
  private startHeartbeat(): void {
    if (!this.titleText) return;
    this.tweens.add({
      targets: this.titleText,
      scale: { from: 1, to: 1.035 },
      duration: 500,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }
}
