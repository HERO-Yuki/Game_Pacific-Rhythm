/**
 * Loads Google "Material Icons" (classic) for Canvas / Phaser `Text` PUA glyphs.
 * Call before first paint so `fillText` does not cache fallback tofu.
 */
export function loadMaterialIconsFont(sizePx = 40): Promise<readonly FontFace[]> {
  if (typeof document === "undefined" || !document.fonts?.load) {
    return Promise.resolve([]);
  }
  return document.fonts.load(`${sizePx}px "Material Icons"`);
}
