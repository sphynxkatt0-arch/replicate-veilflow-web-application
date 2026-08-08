export type FootprintSemanticLevel = "macro" | "compact" | "full";

export interface FootprintSemanticZoom {
  level: FootprintSemanticLevel;
  label: "MACRO" | "COMPACT" | "FULL";
  targetRowPx: number;
  minRowPx: number;
  maxRowPx: number;
  showRows: boolean;
  showNumbers: boolean;
  showPoc: boolean;
  showDelta: boolean;
  showImbalance: boolean;
}

export function resolveFootprintSemanticZoom(xStep: number): FootprintSemanticZoom {
  if (!Number.isFinite(xStep) || xStep < 30) {
    return {
      level: "macro",
      label: "MACRO",
      targetRowPx: 0,
      minRowPx: 0,
      maxRowPx: 0,
      showRows: false,
      showNumbers: false,
      showPoc: false,
      showDelta: false,
      showImbalance: false,
    };
  }

  if (xStep < 74) {
    return {
      level: "compact",
      label: "COMPACT",
      targetRowPx: 8,
      minRowPx: 7,
      maxRowPx: 10,
      showRows: true,
      showNumbers: false,
      showPoc: true,
      showDelta: true,
      showImbalance: true,
    };
  }

  return {
    level: "full",
    label: "FULL",
    targetRowPx: 13,
    minRowPx: 12,
    maxRowPx: 16,
    showRows: true,
    showNumbers: true,
    showPoc: true,
    showDelta: true,
    showImbalance: true,
  };
}

export function semanticDisplayStep(requestedStep: number, pixelsPerRequestedStep: number, semantic: FootprintSemanticZoom): number {
  if (!Number.isFinite(requestedStep) || requestedStep <= 0) return requestedStep;
  if (!semantic.showRows) return requestedStep;
  const pixels = Math.max(0.001, Number.isFinite(pixelsPerRequestedStep) ? pixelsPerRequestedStep : 0.001);
  const multiplier = Math.max(1, Math.ceil(semantic.targetRowPx / pixels));
  return Number((requestedStep * multiplier).toPrecision(12));
}
