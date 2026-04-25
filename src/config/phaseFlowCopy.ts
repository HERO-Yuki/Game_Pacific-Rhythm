/**
 * Phase sub-line (under READING / PROGRAM / RESOLUTION) and related colours.
 * Keeps `MainScene` free of long Japanese string literals and makes tuning copy in one place.
 */

export const PHASE_FLOW = {
  readingLabel: { text: "上段：怪獣の行動をめくる", color: "#d4a878" as const },
  programLabel: { text: "下段：ロボの行動をボタンで入力", color: "#7dd4a8" as const },
  resolutionIntro: {
    text: "各ステップ：怪獣の予告 → あなたのロボが続く",
    color: "#cc9988" as const,
  },
} as const;

export function phaseFlowKaijuBeat(b: number, seqLen: number) {
  return {
    text: `怪獣 [${b + 1}/${seqLen}] 読取 — 下段はまだ先`,
    color: "#e8b896" as const,
  };
}

export function phaseFlowPlayerInput(pIdx: number, seqLen: number) {
  return {
    text: `⏩ ロボ [${pIdx + 1}/${seqLen}] 入力中 — プログラムに反映`,
    color: "#8fe8c0" as const,
  };
}

export function phaseFlowTelegraph(stepIdx: number, seqLen: number) {
  return {
    text: `相手：予告（${stepIdx + 1}/${seqLen}）`,
    color: "#ffaa88" as const,
  };
}

export function phaseFlowPlayerResolve(stepIdx: number, seqLen: number) {
  return {
    text: `⏩ あなた：ロボのプログラム発動（${stepIdx + 1}/${seqLen}）`,
    color: "#88e8cc" as const,
  };
}
