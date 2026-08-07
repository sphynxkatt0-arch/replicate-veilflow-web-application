import { describe, expect, it } from "vitest";
import golden from "../golden/session-v1.json";
import {
  aggregateTradesToFootprints,
  buildSessionProfile,
  calculateLiquidityRegime,
  calculateOpeningRange,
  calculateSpotPerpetual,
  calculateVolatilityRegime,
  clusterLiquidations,
  deriveAuctionSignals,
} from "../researchAnalytics";
import type { Candle, FootprintCandle, OrderBook, Trade } from "../types";

const trades = golden.trades as Trade[];

describe("versioned golden research session", () => {
  it("rebuilds identical footprint totals and deltas", () => {
    const footprints = aggregateTradesToFootprints(trades, golden.instrument.timeframeMs, golden.instrument.tickSize);
    expect(footprints).toHaveLength(golden.expected.footprintCount);
    expect(footprints.reduce((sum, footprint) => sum + footprint.totalVolume, 0)).toBe(golden.expected.totalVolume);
    expect(footprints.reduce((sum, footprint) => sum + footprint.delta, 0)).toBe(golden.expected.totalDelta);
    expect(footprints[0].totalVolume).toBe(golden.expected.firstCandleVolume);
    expect(footprints[0].delta).toBe(golden.expected.firstCandleDelta);
    expect(footprints[1].totalVolume).toBe(golden.expected.secondCandleVolume);
    expect(footprints[1].delta).toBe(golden.expected.secondCandleDelta);
  });

  it("preserves total volume under every supported regrouping", () => {
    for (const tickSize of [0.5, 1, 2, 5]) {
      const footprints = aggregateTradesToFootprints(trades, 60_000, tickSize);
      expect(footprints.reduce((sum, footprint) => sum + footprint.totalVolume, 0)).toBe(10);
      expect(footprints.reduce((sum, footprint) => sum + footprint.delta, 0)).toBe(0);
    }
  });
});

describe("session and auction analytics", () => {
  const footprint: FootprintCandle = {
    time: 0,
    endTime: 59_999,
    rows: [
      { price: 102, bidVolume: 1, askVolume: 1, totalVolume: 2, delta: 0, tradeCount: 2, bidTrades: 1, askTrades: 1, bidImbalance: false, askImbalance: false, stackedBid: false, stackedAsk: false, inValueArea: false },
      { price: 101, bidVolume: 1, askVolume: 8, totalVolume: 9, delta: 7, tradeCount: 3, bidTrades: 1, askTrades: 2, bidImbalance: false, askImbalance: true, stackedBid: false, stackedAsk: true, inValueArea: true },
      { price: 100, bidVolume: 8, askVolume: 1, totalVolume: 9, delta: -7, tradeCount: 3, bidTrades: 2, askTrades: 1, bidImbalance: true, askImbalance: false, stackedBid: true, stackedAsk: false, inValueArea: true },
      { price: 99, bidVolume: 0, askVolume: 0.1, totalVolume: 0.1, delta: 0.1, tradeCount: 1, bidTrades: 0, askTrades: 1, bidImbalance: false, askImbalance: false, stackedBid: false, stackedAsk: false, inValueArea: false },
    ],
    totalBidVolume: 10,
    totalAskVolume: 10.1,
    totalVolume: 20.1,
    delta: 0.1,
    maxDelta: 7,
    minDelta: -7,
    tradeCount: 9,
    pocPrice: 101,
    valueAreaHigh: 101,
    valueAreaLow: 100,
    quality: "full",
    priceStep: 1,
  };

  it("detects unfinished auctions, zero prints, and trapped candidates", () => {
    const signals = deriveAuctionSignals(footprint);
    expect(signals.zeroPrints).toContain(99);
    expect(signals.unfinishedHigh).toBe(true);
    expect(signals.trapped.map((item) => item.side).sort()).toEqual(["buyers", "sellers"]);
  });

  it("creates deterministic profile nodes and POC", () => {
    const profile = buildSessionProfile([footprint, footprint]);
    expect(profile.totalVolume).toBeCloseTo(40.2);
    expect(profile.totalDelta).toBeCloseTo(0.2);
    expect(profile.poc).toBe(101);
    expect(profile.rows.some((row) => row.kind === "HVN")).toBe(true);
    expect(profile.rows.some((row) => row.kind === "LVN")).toBe(true);
  });
});

describe("regimes and cross-market research", () => {
  const candles: Candle[] = Array.from({ length: 30 }, (_, index) => ({
    time: index * 60_000,
    endTime: (index + 1) * 60_000 - 1,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
    volume: 10 + index,
  }));

  it("calculates a complete opening range and volatility regime", () => {
    const opening = calculateOpeningRange(candles, 15);
    expect(opening.complete).toBe(true);
    expect(opening.high).toBe(116);
    expect(opening.low).toBe(99);
    const volatility = calculateVolatilityRegime(candles, 10);
    expect(volatility.regime).not.toBe("UNAVAILABLE");
    expect(volatility.atr).toBeGreaterThan(0);
  });

  it("classifies synchronized and crossed liquidity", () => {
    const book: OrderBook = {
      bids: [{ price: 100, size: 10 }, { price: 99, size: 8 }],
      asks: [{ price: 101, size: 9 }, { price: 102, size: 8 }],
      exchangeTime: 1,
      receiveTime: 2,
      quality: "full",
    };
    expect(calculateLiquidityRegime(book).regime).toBe("NORMAL");
    expect(calculateLiquidityRegime({ ...book, bids: [{ price: 102, size: 1 }] }).regime).toBe("DISLOCATED");
  });

  it("detects spot-led, perp-led, and crowded regimes", () => {
    expect(calculateSpotPerpetual(100, 101, 100, -20).regime).toBe("SPOT-LED");
    expect(calculateSpotPerpetual(100, 101, 10, 100, 0.001, 5).regime).toBe("CROWDED-LONG");
    expect(calculateSpotPerpetual(100, 99, -10, -100, -0.001, 5).regime).toBe("CROWDED-SHORT");
  });

  it("clusters adjacent liquidation prints without losing notional", () => {
    const liquidations: Trade[] = [
      { id: "1", exchangeTime: 1_000, receiveTime: 1_001, price: 100, size: 1, side: "sell", notional: 100 },
      { id: "2", exchangeTime: 2_000, receiveTime: 2_001, price: 100.05, size: 2, side: "sell", notional: 200.1 },
      { id: "3", exchangeTime: 20_000, receiveTime: 20_001, price: 101, size: 1, side: "buy", notional: 101 },
    ];
    const clusters = clusterLiquidations(liquidations, 5_000, 10);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].count).toBe(2);
    expect(clusters.reduce((sum, cluster) => sum + cluster.notional, 0)).toBeCloseTo(liquidations.reduce((sum, trade) => sum + trade.notional, 0));
  });
});
