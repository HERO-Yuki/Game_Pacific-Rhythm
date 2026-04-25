import Phaser from "phaser";
import { EMERGENCY } from "../config/rhythmAndEmergency";

export interface EmergencyModeDepths {
  readonly emergencyRed: number;
  readonly emergencyVig: number;
}

/**
 * Full-screen crisis layer: radial vignette + multiply flash (no headline text).
 * Owns create/destroy so `MainScene` can stay a coordinator.
 */
export class EmergencyModeOverlay {
  private readonly scene: Phaser.Scene;
  private readonly d: EmergencyModeDepths;
  private image: Phaser.GameObjects.Image | null = null;
  private redFlash: Phaser.GameObjects.Rectangle | null = null;
  private redTimer: Phaser.Time.TimerEvent | null = null;
  private active = false;

  constructor(scene: Phaser.Scene, depths: EmergencyModeDepths) {
    this.scene = scene;
    this.d = depths;
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * @returns `false` if the vignette texture could not be created.
   */
  enter(W: number, H: number): boolean {
    if (this.active) return true;
    this.rebuildVignetteTexture(W, H);
    if (!this.scene.textures.exists(EMERGENCY.VIGNETTE_TEXTURE_KEY)) {
      return false;
    }
    this.active = true;
    this.image = this.scene.add
      .image(0, 0, EMERGENCY.VIGNETTE_TEXTURE_KEY)
      .setOrigin(0, 0)
      .setDisplaySize(W, H)
      .setScrollFactor(0)
      .setDepth(this.d.emergencyVig)
      .setAlpha(0.72);
    this.redFlash = this.scene.add
      .rectangle(0, 0, W, H, 0xff1a0a, 0.08)
      .setOrigin(0, 0)
      .setScrollFactor(0)
      .setDepth(this.d.emergencyRed)
      .setBlendMode(Phaser.BlendModes.MULTIPLY);
    this.reapplyVignettePulse(this.image);
    this.redTimer = this.scene.time.addEvent({
      delay: EMERGENCY.RED_GLITCH.intervalMs,
      loop: true,
      callback: () => {
        if (!this.redFlash?.active) return;
        this.redFlash.setAlpha(
          Phaser.Math.FloatBetween(
            EMERGENCY.RED_GLITCH.alpha.min,
            EMERGENCY.RED_GLITCH.alpha.max,
          ),
        );
      },
    });
    return true;
  }

  exit(): void {
    if (!this.active) {
      this.cleanupLoose();
      return;
    }
    this.redTimer?.remove(false);
    this.redTimer = null;
    if (this.image) {
      this.scene.tweens.killTweensOf(this.image);
    }
    if (this.redFlash) {
      this.scene.tweens.killTweensOf(this.redFlash);
    }
    this.image?.destroy();
    this.image = null;
    this.redFlash?.destroy();
    this.redFlash = null;
    if (this.scene.textures.exists(EMERGENCY.VIGNETTE_TEXTURE_KEY)) {
      this.scene.textures.remove(EMERGENCY.VIGNETTE_TEXTURE_KEY);
    }
    this.active = false;
  }

  relayout(W: number, H: number): void {
    if (!this.active) return;
    this.rebuildVignetteTexture(W, H);
    if (this.image && this.scene.textures.exists(EMERGENCY.VIGNETTE_TEXTURE_KEY)) {
      this.image.setTexture(EMERGENCY.VIGNETTE_TEXTURE_KEY);
      this.image.setDisplaySize(W, H);
      this.scene.tweens.killTweensOf(this.image);
      this.image.setAlpha(0.72);
      this.reapplyVignettePulse(this.image);
    }
    this.redFlash?.setSize(W, H);
  }

  private cleanupLoose(): void {
    this.redTimer?.remove(false);
    this.redTimer = null;
  }

  private reapplyVignettePulse(
    target: Phaser.GameObjects.Image,
  ): void {
    const p = EMERGENCY.VIG_PULSE;
    this.scene.tweens.add({
      targets: target,
      alpha: { from: p.alpha.from, to: p.alpha.to },
      duration: p.duration,
      ease: "Sine.easeInOut",
      yoyo: true,
      repeat: -1,
    });
  }

  private rebuildVignetteTexture(W: number, H: number): void {
    if (this.scene.textures.exists(EMERGENCY.VIGNETTE_TEXTURE_KEY)) {
      this.scene.textures.remove(EMERGENCY.VIGNETTE_TEXTURE_KEY);
    }
    const tex = this.scene.textures.createCanvas(
      EMERGENCY.VIGNETTE_TEXTURE_KEY,
      Math.ceil(W),
      Math.ceil(H),
    );
    if (!tex) return;
    const ctx = tex.getContext();
    if (!ctx) return;
    const cx = W / 2;
    const cy = H / 2;
    const r = Math.max(W, H) * 0.72;
    const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grd.addColorStop(0, "rgba(210, 40, 30, 0.32)");
    grd.addColorStop(0.45, "rgba(32, 0, 0, 0.58)");
    grd.addColorStop(1, "rgba(0, 0, 0, 0.95)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, W, H);
    tex.refresh();
  }
}
