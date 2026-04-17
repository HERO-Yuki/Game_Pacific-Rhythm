declare global {
  interface Window {
    WavedashJS?: {
      loadComplete: () => void;
      updateLoadProgressZeroToOne?: (progress: number) => void;
      loadScript?: (src: string) => Promise<void>;
      getUser?: () => unknown;
    };
  }
}

let loadCompleteNotified = false;

export function isWavedashRuntime(): boolean {
  return typeof window !== "undefined" && !!window.WavedashJS;
}

/**
 * On Wavedash, call once after the first meaningful frame / scene is ready (custom engine contract).
 */
export function notifyWavedashLoadComplete(): void {
  if (loadCompleteNotified || typeof window === "undefined") {
    return;
  }
  loadCompleteNotified = true;
  window.WavedashJS?.loadComplete?.();
}
