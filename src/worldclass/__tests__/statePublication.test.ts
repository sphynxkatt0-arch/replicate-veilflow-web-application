import { describe, expect, it } from "vitest";
import { MARKETS } from "../markets";
import {
  createPublicationDirty,
  markPublicationDirty,
  preparePublishedCollections,
  publishedCollectionsFromState,
} from "../statePublication";
import type { FootprintCandle, MarketState, Trade } from "../types";

function trade(id: string): Trade {
  return {
    id,
    exchangeTime: 1_000,
    receiveTime: 1_001,
    price: 100,
    size: 1,
    side: "buy",
    notional: 100,
  };
}

function footprint(time = 0): FootprintCandle {
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
    quality: "aggregate-only",
    priceStep: 1,
  };
}

function state(): MarketState {
  return {
    market: MARKETS.BTC,
    timeframe: "1m",
    candles: [{ time: 0, endTime: 59_999, open: 100, high: 101, low: 99, close: 100, volume: 1 }],
    trades: [trade("one")],
    footprints: [footprint()],
    footprintCoverage: {
      quality: "aggregate-only",
      source: "none",
      contiguous: true,
      eventCount: 0,
      detail: "test",
    },
    book: null,
    metrics: { timestamp: 0, quality: "unavailable" },
    analytics: { dataQuality: "full" },
    status: "live",
    statusDetail: "test",
    lastEventAt: 0,
    eventRate: 0,
    eventLagMs: 0,
  };
}

describe("market state publication", () => {
  it("reuses all large collection references for book/metrics-only publications", () => {
    const previousState = state();
    const previous = publishedCollectionsFromState(previousState);
    const model = { ...previousState, book: null, metrics: { timestamp: 1, quality: "full" as const } };
    const published = preparePublishedCollections(previous, model, createPublicationDirty(false));

    expect(published.candles).toBe(previous.candles);
    expect(published.trades).toBe(previous.trades);
    expect(published.footprints).toBe(previous.footprints);
    expect(published.footprintCoverage).toBe(previous.footprintCoverage);
  });

  it("copies only trades after a trade mutation and isolates the published snapshot", () => {
    const model = state();
    const previous = publishedCollectionsFromState(model);
    model.trades = [...model.trades, trade("two")];
    const dirty = createPublicationDirty(false);
    markPublicationDirty(dirty, { trades: true });
    const published = preparePublishedCollections(previous, model, dirty);

    expect(published.trades).not.toBe(previous.trades);
    expect(published.trades).toHaveLength(2);
    expect(published.candles).toBe(previous.candles);
    expect(published.footprints).toBe(previous.footprints);

    model.trades.push(trade("three"));
    expect(published.trades).toHaveLength(2);
  });

  it("copies candles and footprint evidence without cloning untouched trades", () => {
    const model = state();
    const previous = publishedCollectionsFromState(model);
    model.candles = [...model.candles, { time: 60_000, endTime: 119_999, open: 100, high: 102, low: 100, close: 101, volume: 2 }];
    model.footprints = [...model.footprints, footprint(60_000)];
    model.footprintCoverage = { ...model.footprintCoverage, eventCount: 2 };
    const dirty = createPublicationDirty(false);
    markPublicationDirty(dirty, { candles: true, footprints: true });
    const published = preparePublishedCollections(previous, model, dirty);

    expect(published.candles).not.toBe(previous.candles);
    expect(published.footprints).not.toBe(previous.footprints);
    expect(published.footprintCoverage).not.toBe(previous.footprintCoverage);
    expect(published.trades).toBe(previous.trades);
  });
});
