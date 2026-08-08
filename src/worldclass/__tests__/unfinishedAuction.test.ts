import { describe, expect, it } from "vitest";
import { buildUnfinishedAuctionLevels } from "../unfinishedAuction";
import type { Candle, FootprintCandle } from "../types";

function candle(time: number, low: number, high: number): Candle {
  return { time, endTime: time + 59_999, open: low, high, low, close: high, volume: 1 };
}

function footprint(time: number, fields: Partial<FootprintCandle>): FootprintCandle {
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
    ...fields,
  };
}

describe("unfinished auction level lifecycle", () => {
  it("extends an unresolved high auction to the latest candle", () => {
    const candles = [candle(0, 99, 102), candle(60_000, 95, 101), candle(120_000, 96, 101.5)];
    const levels = buildUnfinishedAuctionLevels([
      footprint(0, { unfinishedHigh: true, unfinishedHighPrice: 102 }),
    ], candles);
    expect(levels).toHaveLength(1);
    expect(levels[0].resolved).toBe(false);
    expect(levels[0].endTime).toBe(179_999);
  });

  it("ends a level on the first later candle that revisits its price", () => {
    const candles = [candle(0, 99, 102), candle(60_000, 95, 101), candle(120_000, 101.5, 102.5), candle(180_000, 90, 110)];
    const levels = buildUnfinishedAuctionLevels([
      footprint(0, { unfinishedHigh: true, unfinishedHighPrice: 102 }),
    ], candles);
    expect(levels[0].resolved).toBe(true);
    expect(levels[0].resolvedAt).toBe(120_000);
    expect(levels[0].endTime).toBe(120_000);
  });

  it("tracks high and low auctions independently and ignores unconfirmed fields", () => {
    const candles = [candle(0, 99, 102), candle(60_000, 100, 101)];
    const levels = buildUnfinishedAuctionLevels([
      footprint(0, { unfinishedHigh: true, unfinishedHighPrice: 102, unfinishedLow: true, unfinishedLowPrice: 99 }),
      footprint(60_000, { quality: "gapped", unfinishedHigh: undefined, unfinishedHighPrice: undefined }),
    ], candles);
    expect(levels.map((level) => level.side).sort()).toEqual(["high", "low"]);
    expect(levels.every((level) => level.resolved === false)).toBe(true);
  });
});
