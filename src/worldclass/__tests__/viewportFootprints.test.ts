import { describe, expect, it } from "vitest";
import { mergeRanges, mergeViewportFootprints, rangeCovered, viewportRequestRange } from "../useViewportFootprints";
import type { Candle, FootprintCandle } from "../types";

function candles(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    time: index * 60_000,
    endTime: index * 60_000 + 59_999,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
  }));
}

function footprint(time: number): FootprintCandle {
  return {
    time,
    endTime: time + 59_999,
    rows: [],
    totalBidVolume: 0,
    totalAskVolume: 0,
    totalVolume: 0,
    delta: 0,
    maxDelta: 0,
    minDelta: 0,
    tradeCount: 0,
    quality: "full",
    priceStep: 1,
  };
}

describe("viewport footprint loading", () => {
  it("prefetches one viewport backward and half a viewport forward", () => {
    const all = candles(500);
    const visible = all.slice(200, 280);
    expect(viewportRequestRange(all, visible)).toEqual({
      startTime: all[120].time,
      endTime: all[319].endTime,
    });
  });

  it("clamps prefetch at the newest history boundary", () => {
    const all = candles(500);
    const visible = all.slice(420);
    expect(viewportRequestRange(all, visible)).toEqual({
      startTime: all[340].time,
      endTime: all[499].endTime,
    });
  });

  it("merges overlapping loaded ranges and detects full coverage", () => {
    const merged = mergeRanges([{ startTime: 100, endTime: 200 }], { startTime: 180, endTime: 300 });
    expect(merged).toEqual([{ startTime: 100, endTime: 300 }]);
    expect(rangeCovered(merged, { startTime: 125, endTime: 275 })).toBe(true);
    expect(rangeCovered(merged, { startTime: 50, endTime: 275 })).toBe(false);
  });

  it("keeps the viewport footprint cache bounded around the requested focus", () => {
    const current = Array.from({ length: 900 }, (_, index) => footprint(index * 60_000));
    const incoming = Array.from({ length: 100 }, (_, index) => footprint((900 + index) * 60_000));
    const focus = { startTime: 900 * 60_000, endTime: 999 * 60_000 + 59_999 };
    const merged = mergeViewportFootprints(current, incoming, focus, 200);
    expect(merged).toHaveLength(200);
    expect(merged.at(-1)?.time).toBe(999 * 60_000);
    expect(merged[0].time).toBeGreaterThanOrEqual(800 * 60_000);
  });
});
