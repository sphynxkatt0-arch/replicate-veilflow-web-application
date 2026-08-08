import { describe, expect, it } from "vitest";
import { collectorManifestMatchesMarket, collectorRequestWindow, parseCollectorFootprint } from "../collectorClient";
import { MARKETS } from "../markets";
import type { Candle } from "../types";

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

describe("collector session routing", () => {
  it("requires venue, symbol, and product type to match", () => {
    expect(collectorManifestMatchesMarket({ id: "ok", venue: "binance", venueSymbol: "BTCUSDT", productType: "spot" }, MARKETS.BTC)).toBe(true);
    expect(collectorManifestMatchesMarket({ id: "wrong-venue", venue: "hyperliquid", venueSymbol: "BTCUSDT", productType: "spot" }, MARKETS.BTC)).toBe(false);
    expect(collectorManifestMatchesMarket({ id: "wrong-product", venue: "binance", venueSymbol: "BTCUSDT", productType: "perpetual" }, MARKETS.BTC)).toBe(false);
  });

  it("routes Hyperliquid proxy instruments to perpetual collector sessions", () => {
    expect(collectorManifestMatchesMarket({ id: "hl", venue: "hyperliquid", venueSymbol: MARKETS.NQ.providerSymbol, productType: "perpetual" }, MARKETS.NQ)).toBe(true);
    expect(collectorManifestMatchesMarket({ id: "hl-wrong", venue: "binance", venueSymbol: MARKETS.NQ.providerSymbol, productType: "perpetual" }, MARKETS.NQ)).toBe(false);
  });

  it("bounds the initial collector payload to the latest 160 candles", () => {
    const rows = candles(1_000);
    const range = collectorRequestWindow(rows);
    expect(range?.startTime).toBe(rows[840].time);
    expect(range?.endTime).toBe(rows[999].endTime);
  });

  it("honors an explicit viewport range and clamps it to available candles", () => {
    const rows = candles(500);
    expect(collectorRequestWindow(rows, { startTime: rows[100].time, endTime: rows[220].endTime })).toEqual({
      startTime: rows[100].time,
      endTime: rows[220].endTime,
    });
    expect(collectorRequestWindow(rows, { startTime: -1_000, endTime: rows[50].endTime })).toEqual({
      startTime: rows[0].time,
      endTime: rows[50].endTime,
    });
  });

  it("preserves trusted unfinished-auction evidence from server footprints", () => {
    const parsed = parseCollectorFootprint({
      time: 0,
      endTime: 59_999,
      priceStep: 1,
      quality: "FULL",
      totalBidVolume: 2,
      totalAskVolume: 3,
      totalVolume: 5,
      delta: 1,
      maxDelta: 1,
      minDelta: 1,
      tradeCount: 2,
      unfinishedHigh: true,
      unfinishedHighPrice: 102,
      unfinishedLow: false,
      rows: [{ price: 102, bidVolume: 2, askVolume: 3, totalVolume: 5, delta: 1, tradeCount: 2, bidTrades: 1, askTrades: 1 }],
    });
    expect(parsed?.unfinishedHigh).toBe(true);
    expect(parsed?.unfinishedHighPrice).toBe(102);
    expect(parsed?.unfinishedLow).toBe(false);
  });

  it("drops unfinished-auction claims when server footprint quality is not trusted", () => {
    const parsed = parseCollectorFootprint({
      time: 0,
      endTime: 59_999,
      priceStep: 1,
      quality: "GAPPED",
      unfinishedHigh: true,
      unfinishedHighPrice: 102,
      rows: [{ price: 102, bidVolume: 2, askVolume: 3 }],
    });
    expect(parsed?.quality).toBe("gapped");
    expect(parsed?.unfinishedHigh).toBeUndefined();
    expect(parsed?.unfinishedHighPrice).toBeUndefined();
  });
});
