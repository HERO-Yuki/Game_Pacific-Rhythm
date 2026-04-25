import Phaser from "phaser";
import { loadMaterialIconsFont } from "../utils/loadMaterialIconsFont";

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
    // Combatant sprites — flat-vector illustrations sourced from Midjourney.
    // See docs/midjourney-{mech,kaiju}-prompts.md (gitignored) for the exact
    // prompts and regeneration notes.
    this.load.image("mech-player", "assets/images/mech-player.png");
    this.load.image("kaiju-zako", "assets/images/kaiju-zako.png");
    this.load.image("kaiju-boss", "assets/images/kaiju-boss.png");
    this.load.image("kaiju-giga", "assets/images/kaiju-giga.png");

    // Future: JSON levels, audio banks, extra rank variants, etc.
  }

  create(): void {
    // Material Icons must be ready before any Phaser Text caches PUA glyphs on
    // the canvas; otherwise ligature names / tofu can stick until refresh.
    const goTitle = (): void => {
      this.scene.start("TitleScene");
    };
    void loadMaterialIconsFont(40).then(goTitle).catch(goTitle);
  }
}
