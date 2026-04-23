import Phaser from "phaser";

/**
 * Loads the static art assets used by the rest of the game.
 *
 * Kept lightweight on purpose: anything we add here runs synchronously
 * before the first MainScene frame, so keep uploads small (favor PNG
 * with tight alpha channels) or split them into lazy scenes later.
 */
export class PreloaderScene extends Phaser.Scene {
  constructor() {
    super("PreloaderScene");
  }

  preload(): void {
    // Player mech — flat-vector illustration sourced from Midjourney.
    // See docs/midjourney-mech-prompts.md (gitignored) for the exact prompt
    // and regeneration notes.
    this.load.image("mech-player", "assets/images/mech-player.png");

    // Future: JSON levels, audio banks, kaiju sprite sheets, etc.
  }

  create(): void {
    this.scene.start("MainScene");
  }
}
