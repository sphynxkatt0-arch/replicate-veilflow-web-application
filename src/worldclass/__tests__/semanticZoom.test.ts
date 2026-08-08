import { describe, expect, it } from "vitest";
import { resolveFootprintSemanticZoom, semanticDisplayStep } from "../semanticZoom";

describe("footprint semantic zoom", () => {
  it("uses macro candles when footprint columns are too narrow", () => {
    const semantic = resolveFootprintSemanticZoom(24);
    expect(semantic.level).toBe("macro");
    expect(semantic.showRows).toBe(false);
    expect(semantic.showNumbers).toBe(false);
  });

  it("uses compact footprint for medium-width bars", () => {
    const semantic = resolveFootprintSemanticZoom(48);
    expect(semantic.level).toBe("compact");
    expect(semantic.showRows).toBe(true);
    expect(semantic.showNumbers).toBe(false);
    expect(semantic.showPoc).toBe(true);
    expect(semantic.showDelta).toBe(true);
  });

  it("uses full Bid x Ask footprint only at readable widths", () => {
    const semantic = resolveFootprintSemanticZoom(84);
    expect(semantic.level).toBe("full");
    expect(semantic.showNumbers).toBe(true);
    expect(semantic.minRowPx).toBe(12);
    expect(semantic.maxRowPx).toBe(16);
  });

  it("regroups price levels to the semantic row-height target without reducing native resolution", () => {
    const compact = resolveFootprintSemanticZoom(48);
    const full = resolveFootprintSemanticZoom(84);
    expect(semanticDisplayStep(0.1, 2, compact)).toBe(0.4);
    expect(semanticDisplayStep(0.1, 2, full)).toBe(0.7);
    expect(semanticDisplayStep(0.1, 20, full)).toBe(0.1);
  });
});
