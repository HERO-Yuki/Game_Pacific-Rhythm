/**
 * English sub-line under READING / PROGRAM / RESOLUTION (jam-facing UI).
 * Colours are tuned in `MainScene` — strings stay here for copy edits.
 */

export const PHASE_FLOW = {
  readingLabel: {
    text: "Top row: reveal the kaiju's moves",
    color: "#d4a878" as const,
  },
  programLabel: {
    text: "Lower row: program your mech with the buttons",
    color: "#7dd4a8" as const,
  },
  resolutionIntro: {
    text: "Each step: enemy telegraph, then your mech responds",
    color: "#cc9988" as const,
  },
} as const;

export function phaseFlowKaijuBeat(b: number, seqLen: number) {
  return {
    text: `Kaiju ${b + 1}/${seqLen} — read top row (yours is next)`,
    color: "#e8b896" as const,
  };
}

export function phaseFlowPlayerInput(pIdx: number, seqLen: number) {
  return {
    text: `⏩ You ${pIdx + 1}/${seqLen} — set your mech on the beat`,
    color: "#8fe8c0" as const,
  };
}

export function phaseFlowTelegraph(stepIdx: number, seqLen: number) {
  return {
    text: `Enemy telegraph (${stepIdx + 1}/${seqLen})`,
    color: "#ffaa88" as const,
  };
}

export function phaseFlowPlayerResolve(stepIdx: number, seqLen: number) {
  return {
    text: `⏩ You resolve (${stepIdx + 1}/${seqLen})`,
    color: "#88e8cc" as const,
  };
}
