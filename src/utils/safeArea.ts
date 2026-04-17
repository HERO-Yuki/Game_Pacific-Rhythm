import Phaser from "phaser";

/**
 * Reads CSS env(safe-area-inset-*) via a disposable probe element (supported browsers only).
 */
export function readSafeAreaInsetsPx(): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  if (typeof document === "undefined") {
    return { top: 0, right: 0, bottom: 0, left: 0 };
  }

  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = [
    "position:fixed",
    "pointer-events:none",
    "visibility:hidden",
    "padding-top:env(safe-area-inset-top,0px)",
    "padding-right:env(safe-area-inset-right,0px)",
    "padding-bottom:env(safe-area-inset-bottom,0px)",
    "padding-left:env(safe-area-inset-left,0px)",
  ].join(";");

  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const top = parseFloat(cs.paddingTop) || 0;
  const right = parseFloat(cs.paddingRight) || 0;
  const bottom = parseFloat(cs.paddingBottom) || 0;
  const left = parseFloat(cs.paddingLeft) || 0;
  probe.remove();

  return { top, right, bottom, left };
}

/**
 * Scale config for embed-friendly hosts (YouTube Playables, etc.).
 * RESIZE keeps the canvas tied to the parent container as it changes size.
 */
export function getGameScaleConfig(
  width: number,
  height: number,
): Phaser.Types.Core.ScaleConfig {
  return {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width,
    height,
    parent: "app",
    expandParent: true,
    autoRound: true,
  };
}
