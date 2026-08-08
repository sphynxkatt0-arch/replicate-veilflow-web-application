import { describe, expect, it } from "vitest";
import { FootprintAccumulator } from "../footprint";
import { MARKETS } from "../markets";
import { appendLiveTrade } from "../useMarketEngine";
import { recentLargeTradeInput } from "../useLargeTradeAnalysis";
import type { Candle, Trade } from "../types";

function trade(index: number, exchangeTime = 1_000 + index): Trade {
  return {
    id: `trade-${index}`,
    exchangeTime,
    receiveTime: exchangeTime + 1,
    price: 100 + index * 0.0001,
    size: 1,
    side: index % 2 ? "sell" : "buy",
    notional: 100,
    sequence: index,
    source: "live",
  };
}

describe("live-path bounded buffers", () => {
  it("deduplicates in O(1)-style set lookup and trims trades in batches", () => {
    const trades: Trade[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < 27_500; index += 1) {
      expect(appendLiveTrade(trades, seen, trade(index))).toBe(true);
    }

    expect(trades.length).toBeLessThanOrEqual(27_000);
    expect(seen.size).toBe(trades.length);
    const latest = trades.at(-1)!;
    expect(appendLiveTrade(trades, seen, latest)).toBe(false);
    expect(seen.size).toBe(trades.length);
  });

  it("bounds large-order worker messages to the latest 3000 executions", () => {
    const trades = Array.from({ length: 12_000 }, (_, index) => trade(index));
    const recent = recentLargeTradeInput(trades);
    expect(recent).toHaveLength(3_000);
    expect(recent[0].id).toBe("trade-9000");
    expect(recent.at(-1)?.id).toBe("trade-11999");
  });
});

describe("footprint snapshot cache", () => {
  it("reuses untouched historical footprints and invalidates only the changed candle", () => {
    const start = Date.UTC(2026, 7, 7, 10, 0, 0);
    const candles: Candle[] = [
      { time: start, endTime: start + 59_999, open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { time: start + 60_000, endTime: start + 119_999, open: 100, high: 102, low: 100, close: 101, volume: 2 },
    ];
    const firstTrade = { ...trade(1, start + 10_000), price: 100, notional: 100 };
    const secondTrade = { ...trade(2, start + 70_000), price: 101, notional: 101 };
    const accumulator = new FootprintAccumulator(MARKETS.BTC, "1m");
    accumulator.reset(candles, [firstTrade, secondTrade], {
      source: "binance-aggtrades",
      startTime: start,
      endTime: start + 70_000,
      contiguous: true,
      eventCount: 2,
    }, start);

    const first = accumulator.snapshot(start + 80_000);
    const second = accumulator.snapshot(start + 80_000);
    expect(second.footprints[0]).toBe(first.footprints[0]);
    expect(second.footprints[1]).toBe(first.footprints[1]);

    accumulator.ingestTrade({ ...trade(3, start + 75_000), price: 101.5, notional: 101.5 });
    const third = accumulator.snapshot(start + 80_000);
    expect(third.footprints[0]).toBe(second.footprints[0]);
    expect(third.footprints[1]).not.toBe(second.footprints[1]);
  });
});
