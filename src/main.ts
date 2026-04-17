import Phaser from "phaser";

import { BootScene } from "./scenes/BootScene";
import { MainScene } from "./scenes/MainScene";
import { PreloaderScene } from "./scenes/PreloaderScene";
import { getGameScaleConfig } from "./utils/safeArea";

/**
 * Logical design resolution; with Scale.RESIZE the canvas follows the host while
 * layout code uses scale.width / scale.height for responsive placement.
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
    scene: [BootScene, PreloaderScene, MainScene],
  });
}

createGame();
