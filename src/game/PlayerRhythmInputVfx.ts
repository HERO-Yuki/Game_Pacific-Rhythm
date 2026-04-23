import Phaser from "phaser";
import { audio } from "../audio/AudioManager";
import { type RhythmInputTiming } from "../config/rhythmAndEmergency";

const FONT_UI = "system-ui, 'Segoe UI', sans-serif";
const DELA = '"Dela Gothic One", Impact, "Arial Black", sans-serif';
const PLAYER_PAN = 0.5;

export interface PlayerRhythmVfxDepths {
  readonly rhythmInputBack: number;
  readonly rhythmInputPraise: number;
  readonly sparks: number;
}

/**
 * “Juice” for programming-phase timing: gold PERFECT / modest GOOD, particles,
 * and layered SFX. Factored out of `MainScene` for testability and clarity.
 */
export class PlayerRhythmInputVfx {
  private readonly scene: Phaser.Scene;
  private readonly d: PlayerRhythmVfxDepths;

  constructor(scene: Phaser.Scene, depths: PlayerRhythmVfxDepths) {
    this.scene = scene;
    this.d = depths;
  }

  spawnForTiming(
    timing: RhythmInputTiming,
    x: number,
    y: number,
    slotSize: number,
  ): void {
    if (timing === "PERFECT") {
      this.spawnPerfect(x, y, slotSize);
    } else {
      this.spawnGood(x, y, slotSize);
    }
  }

  private spawnPerfect(x: number, y: number, slotSize: number): void {
    const ring = this.scene.add
      .circle(x, y, 14, 0xffcc22, 0.72)
      .setDepth(this.d.rhythmInputBack)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.scene.tweens.add({
      targets: ring,
      scale: { from: 0.32, to: 2.85 },
      alpha: { from: 0.95, to: 0 },
      duration: 410,
      ease: "Cubic.easeOut",
      onComplete: () => ring.destroy(),
    });
    const burst = this.scene.add
      .circle(x, y, 10, 0xfff0aa, 0.45)
      .setDepth(this.d.rhythmInputBack + 1)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.scene.tweens.add({
      targets: burst,
      scale: { from: 0.18, to: 3.4 },
      alpha: { from: 0.85, to: 0 },
      duration: 480,
      ease: "Quart.easeOut",
      onComplete: () => burst.destroy(),
    });
    const praise = this.scene.add
      .text(x, y - slotSize * 0.7, "PERFECT!!", {
        fontFamily: DELA,
        fontSize: "38px",
        color: "#ffee55",
        stroke: "#3a1a00",
        strokeThickness: 8,
      })
      .setOrigin(0.5)
      .setDepth(this.d.rhythmInputPraise)
      .setScale(0.12)
      .setAlpha(0);
    this.scene.tweens.add({
      targets: praise,
      scale: 1.05,
      alpha: 1,
      duration: 480,
      ease: "Back.easeOut",
      onComplete: () => {
        this.scene.tweens.add({
          targets: praise,
          alpha: 0,
          y: praise.y - 22,
          duration: 300,
          ease: "Sine.easeIn",
          delay: 150,
          onComplete: () => praise.destroy(),
        });
      },
    });
    audio.playClick({ pan: PLAYER_PAN, volume: 0.68 });
    audio.playSpecial({ pan: PLAYER_PAN, volume: 0.92 });
  }

  private spawnGood(x: number, y: number, slotSize: number): void {
    this.emitSmallGoodSparks(x, y);
    const g = this.scene.add
      .text(x, y + slotSize * 0.45, "GOOD", {
        font: `700 15px ${FONT_UI}`,
        color: "#eef4fc",
        stroke: "#000000",
        strokeThickness: 5,
      })
      .setOrigin(0.5)
      .setDepth(this.d.rhythmInputPraise)
      .setAlpha(0);
    this.scene.tweens.add({
      targets: g,
      alpha: 0.82,
      duration: 100,
      onComplete: () => {
        this.scene.tweens.add({
          targets: g,
          alpha: 0,
          duration: 240,
          delay: 100,
          onComplete: () => g.destroy(),
        });
      },
    });
    audio.playClick({ pan: PLAYER_PAN, volume: 0.5 });
  }

  private emitSmallGoodSparks(x: number, y: number): void {
    const emitter = this.scene.add.particles(x, y, "spark", {
      speed: { min: 32, max: 120 },
      angle: { min: 0, max: 360 },
      scale: { start: 1.0, end: 0 },
      tint: 0xffffff,
      lifespan: 300,
      quantity: 7,
      emitting: false,
    });
    emitter.setDepth(this.d.sparks);
    emitter.explode(7);
    this.scene.time.delayedCall(400, () => emitter.destroy());
  }
}
