import Phaser from "phaser";

import { BootScene } from "./scenes/BootScene";
import { MainScene } from "./scenes/MainScene";
import { PreloaderScene } from "./scenes/PreloaderScene";
import { TitleScene } from "./scenes/TitleScene";
import { getGameScaleConfig } from "./utils/safeArea";

/**
 * Logical design resolution for the landscape-oriented UI (16:9).
 *
 * With Scale.FIT the internal coordinate space is fixed at this size; the
 * Scale Manager uniformly scales the canvas to fit the parent container.
 * Layout code reads scale.width / scale.height which, under FIT, always
 * returns these design dimensions — giving a stable coordinate system for
 * every platform the game ships to (YouTube Playables embeds included).
 */
const DESIGN_WIDTH = 960;
const DESIGN_HEIGHT = 540;

function createGame(): Phaser.Game {
  const parent = document.getElementById("app");
  if (!parent) {
    throw new Error("#app container not found");
  }

  return new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: "#0b0f14",
    scale: getGameScaleConfig(DESIGN_WIDTH, DESIGN_HEIGHT),
    render: {
      antialias: true,
      roundPixels: true,
      powerPreference: "high-performance",
    },
    fps: {
      target: 60,
      smoothStep: true,
    },
    scene: [BootScene, PreloaderScene, TitleScene, MainScene],
  });
}

createGame();
