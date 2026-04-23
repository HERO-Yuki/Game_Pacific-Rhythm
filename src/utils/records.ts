/**
 * Persistent best-record storage for each difficulty tier.
 *
 * We key everything under a single `STORAGE_KEY` so one JSON read/write
 * per commit keeps localStorage tidy, and an accidental quota error
 * never corrupts half of the user's profile. All public helpers are
 * guarded against:
 *
 *   - Missing `localStorage` (private-mode Safari, embedded iframes
 *     with disabled storage).
 *   - Malformed JSON left over from older builds.
 *   - Quota errors on write (we swallow them; a lost record is better
 *     than a thrown exception during a celebration overlay).
 *
 * Keeping persistence out of the Scene means MainScene never has to
 * care about try/catches, and the TitleScene can render records with
 * a single synchronous call.
 */
import type { Difficulty } from "../config/difficulty";

/** Best stats for a completed EASY or NORMAL run. */
export interface TimedClearRecord {
  /** Wall-clock milliseconds from first wave to final kill. */
  readonly timeMs: number;
}

/** Best stats for an ENDLESS run — saved every time any field grows. */
export interface EndlessRecord {
  readonly waves: number;
  readonly bosses: number;
  readonly gigas: number;
}

interface StoredBlob {
  readonly easy?: TimedClearRecord;
  readonly normal?: TimedClearRecord;
  readonly endless?: EndlessRecord;
}

const STORAGE_KEY = "pacificRhythm:bestRecords:v1";

function safeGetStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    const s = window.localStorage;
    // Access the length property so disabled storage throws up-front
    // instead of pretending to succeed then failing on setItem.
    void s.length;
    return s;
  } catch {
    return null;
  }
}

function readBlob(): StoredBlob {
  const s = safeGetStorage();
  if (!s) return {};
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as StoredBlob;
    return {};
  } catch {
    return {};
  }
}

function writeBlob(blob: StoredBlob): void {
  const s = safeGetStorage();
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(blob));
  } catch {
    // Quota or serialization error — intentionally swallowed so the
    // score screen never throws while celebrating a new best.
  }
}

/* ---------------- Timed (EASY / NORMAL) ---------------- */

export function loadTimedRecord(
  diff: "easy" | "normal",
): TimedClearRecord | null {
  const blob = readBlob();
  const rec = blob[diff];
  if (!rec || typeof rec.timeMs !== "number" || rec.timeMs <= 0) return null;
  return { timeMs: rec.timeMs };
}

/**
 * Persist the clear time for EASY / NORMAL. Returns `true` if the new
 * time is a best (i.e. strictly faster than the current record, or if
 * no record exists yet) so the UI can tag it with "NEW BEST".
 */
export function saveTimedRecord(
  diff: "easy" | "normal",
  timeMs: number,
): boolean {
  if (!(timeMs > 0)) return false;
  const blob = readBlob();
  const existing = blob[diff];
  const isBest = !existing || timeMs < existing.timeMs;
  if (!isBest) return false;
  writeBlob({ ...blob, [diff]: { timeMs } });
  return true;
}

/* ---------------- Endless ---------------- */

export function loadEndlessRecord(): EndlessRecord | null {
  const blob = readBlob();
  const rec = blob.endless;
  if (!rec) return null;
  return {
    waves: rec.waves | 0,
    bosses: rec.bosses | 0,
    gigas: rec.gigas | 0,
  };
}

/**
 * Persist the end-of-run ENDLESS stats, keeping the best value per
 * field independently (so a long run that defeated fewer bosses
 * doesn't erase a shorter run with more bosses). Returns `true`
 * if *any* field improved so the UI can tag the result accordingly.
 */
export function saveEndlessRecord(run: EndlessRecord): boolean {
  const blob = readBlob();
  const prev = blob.endless ?? { waves: 0, bosses: 0, gigas: 0 };
  const next: EndlessRecord = {
    waves: Math.max(prev.waves, run.waves | 0),
    bosses: Math.max(prev.bosses, run.bosses | 0),
    gigas: Math.max(prev.gigas, run.gigas | 0),
  };
  const improved =
    next.waves !== prev.waves ||
    next.bosses !== prev.bosses ||
    next.gigas !== prev.gigas;
  if (!improved) return false;
  writeBlob({ ...blob, endless: next });
  return true;
}

/* ---------------- Helpers for UI ---------------- */

/** Format milliseconds as `m:ss`. Used on the title + clear screens. */
export function formatTime(timeMs: number): string {
  const totalSeconds = Math.max(0, Math.round(timeMs / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * One-line summary of the current best for a difficulty — "—" when no
 * record exists. Used beneath the title-screen difficulty buttons.
 */
export function formatBestSummary(diff: Difficulty): string {
  if (diff === "endless") {
    const r = loadEndlessRecord();
    if (!r) return "BEST: —";
    return `BEST: W${r.waves} · B${r.bosses} · G${r.gigas}`;
  }
  const r = loadTimedRecord(diff);
  if (!r) return "BEST: —";
  return `BEST: ${formatTime(r.timeMs)}`;
}
