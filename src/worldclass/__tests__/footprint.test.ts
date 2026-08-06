import { describe, expect, it } from "vitest";
import { buildFootprints, FootprintAccumulator, regroupFootprint } from "../footprint";
import { MARKETS } from "../markets";
import type { Candle, Trade } from "../types";

const candle: Candle = {
  time: 0,
  endTime: 59_999,
  open: 100,
  high: 102,
  low: 99,
  close: 101,
  volume: 10,
  buyVolume: 6,
  sellVolume: 4,
  trades: 4,
};

function trade(id: string, time: number, price: number, size: number, side: "buy" | "sell", sequence: number): Trade {
  return { id, exchangeTime: time, receiveTime: time + 5, price, size, side, sequence, notional: price * size, source: "backfill" };
}

describe("FootprintAccumulator", () => {
  it("maps aggressive sells to bid volume and aggressive buys to ask volume at price", () => {
    const rows = [
      trade("1", 1_000, 100.01, 4, "sell", 1),
      trade("2", 2_000, 100.04, 6, "buy", 2),
    ];
    const result = buildFootprints(MARKETS.BTC, "1m", [candle], rows, {
      source: "binance-aggtrades", startTime: 0, endTime: 60_000, contiguous: true, eventCount: rows.length,
    }, 70_000);
    const fp = result.footprints[0];
    expect(fp.totalBidVolume).toBe(4);
    expect(fp.totalAskVolume).toBe(6);
    expect(fp.delta).toBe(2);
    expect(fp.totalVolume).toBe(10);
    expect(fp.quality).toBe("full");
  });

  it("marks the first partially observed candle as live-partial", () => {
    const rows = [trade("1", 30_000, 100, 2, "buy", 10)];
    const result = buildFootprints(MARKETS.BTC, "1m", [candle], rows, {
      source: "binance-aggtrades", startTime: 30_000, endTime: 59_999, contiguous: true, eventCount: 1,
    }, 70_000);
    expect(result.footprints[0].quality).toBe("live-partial");
  });

  it("marks sequence/reconciliation failures as gapped", () => {
    const accumulator = new FootprintAccumulator(MARKETS.BTC, "1m");
    accumulator.reset([candle], [trade("1", 1_000, 100, 2, "buy", 1)], {
      source: "binance-aggtrades", startTime: 0, endTime: 59_999, contiguous: true, eventCount: 1,
    });
    accumulator.markGap(10_000);
    expect(accumulator.snapshot(70_000).footprints[0].quality).toBe("gapped");
  });

  it("calculates POC, value area, row delta, and diagonal imbalance", () => {
    const complete: Candle = { ...candle, volume: 20, buyVolume: 14, sellVolume: 6 };
    const rows = [
      trade("1", 1_000, 100.0, 1, "sell", 1),
      trade("2", 2_000, 100.0, 8, "buy", 2),
      trade("3", 3_000, 99.9, 2, "sell", 3),
      trade("4", 4_000, 99.9, 1, "buy", 4),
      trade("5", 5_000, 100.1, 3, "sell", 5),
      trade("6", 6_000, 100.1, 5, "buy", 6),
    ];
    const result = buildFootprints(MARKETS.BTC, "1m", [complete], rows, {
      source: "binance-aggtrades", startTime: 0, endTime: 60_000, contiguous: true, eventCount: rows.length,
    }, 70_000);
    const fp = result.footprints[0];
    expect(fp.pocPrice).toBe(100);
    expect(fp.valueAreaLow).toBeDefined();
    expect(fp.valueAreaHigh).toBeDefined();
    expect(fp.rows.find((row) => row.price === 100)?.askImbalance).toBe(true);
  });

  it("regroups exact tick rows without losing volume", () => {
    const complete: Candle = { ...candle, volume: 10 };
    const rows = [
      trade("1", 1_000, 100.0, 2, "sell", 1),
      trade("2", 2_000, 100.1, 3, "buy", 2),
      trade("3", 3_000, 100.2, 5, "buy", 3),
    ];
    const result = buildFootprints(MARKETS.BTC, "1m", [complete], rows, {
      source: "binance-aggtrades", startTime: 0, endTime: 60_000, contiguous: true, eventCount: rows.length,
    }, 70_000);
    const grouped = regroupFootprint(result.footprints[0], complete, 1, 3, 0);
    expect(grouped.totalVolume).toBeCloseTo(result.footprints[0].totalVolume);
    expect(grouped.rows.length).toBeLessThan(result.footprints[0].rows.length);
  });
});
