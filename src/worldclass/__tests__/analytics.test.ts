import { describe, expect, it } from "vitest";
import { depthAnalytics, detectLargeTrades, rollingDelta, sessionCvd, sessionVwap } from "../analytics";
import type { Candle, OrderBook, Trade } from "../types";

const day = Date.UTC(2026, 7, 6);
const candles: Candle[] = [
  { time: day, endTime: day + 59_999, open: 100, high: 102, low: 99, close: 101, volume: 10, buyVolume: 7, sellVolume: 3 },
  { time: day + 60_000, endTime: day + 119_999, open: 101, high: 104, low: 100, close: 103, volume: 20, buyVolume: 8, sellVolume: 12 },
];

describe("session analytics", () => {
  it("computes zoom-independent session VWAP from full candle input", () => {
    const value = sessionVwap(candles, day + 120_000)!;
    const expected = (((102 + 99 + 101) / 3) * 10 + ((104 + 100 + 103) / 3) * 20) / 30;
    expect(value).toBeCloseTo(expected);
  });

  it("computes session CVD and reports full quality", () => {
    const result = sessionCvd(candles, [], day + 120_000);
    expect(result.value).toBe(0);
    expect(result.quality).toBe("full");
    expect(rollingDelta(candles)).toBe(0);
  });
});

describe("depth analytics", () => {
  it("computes spread, microprice and bounded imbalance", () => {
    const book: OrderBook = {
      bids: [{ price: 100, size: 3 }, { price: 99, size: 2 }],
      asks: [{ price: 101, size: 1 }, { price: 102, size: 2 }],
      exchangeTime: 1,
      receiveTime: 1,
      quality: "full",
    };
    const result = depthAnalytics(book);
    expect(result.spread).toBe(1);
    expect(result.microprice).toBeCloseTo(100.75);
    expect(Math.abs(result.weightedImbalance!)).toBeLessThanOrEqual(1);
  });
});

describe("large trade detection", () => {
  it("allows zero events when nothing exceeds the absolute floor", () => {
    const trades: Trade[] = Array.from({ length: 40 }, (_, index) => ({
      id: String(index),
      exchangeTime: day + index * 1000,
      receiveTime: day + index * 1000,
      price: 100,
      size: 1,
      side: index % 2 ? "buy" : "sell",
      notional: 100,
    }));
    const result = detectLargeTrades(trades, 50_000);
    expect(result.events).toHaveLength(0);
    expect(result.threshold).toBe(50_000);
  });

  it("detects absolute-floor big orders before the adaptive sample is warm", () => {
    const trades: Trade[] = [
      { id: "small", exchangeTime: day, receiveTime: day, price: 100, size: 1, side: "sell", notional: 100 },
      { id: "big", exchangeTime: day + 100, receiveTime: day + 100, price: 100.1, size: 800, side: "buy", notional: 80_000 },
    ];
    const result = detectLargeTrades(trades, 50_000);
    expect(result.threshold).toBe(50_000);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe("large-big");
  });

  it("detects genuine outliers without forcing a minimum count", () => {
    const trades: Trade[] = Array.from({ length: 50 }, (_, index) => ({
      id: String(index),
      exchangeTime: day + index * 1000,
      receiveTime: day + index * 1000,
      price: 100,
      size: index === 49 ? 2000 : 1,
      side: "buy",
      notional: index === 49 ? 200_000 : 100,
    }));
    const result = detectLargeTrades(trades, 50_000);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].notional).toBe(200_000);
  });
});
