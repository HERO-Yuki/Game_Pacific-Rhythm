import Phaser from "phaser";

export class PreloaderScene extends Phaser.Scene {
  constructor() {
    super("PreloaderScene");
  }

  preload(): void {
    // Future: load JSON levels, audio banks, sprite sheets, etc.
  }

  create(): void {
    this.scene.start("MainScene");
  }
}
