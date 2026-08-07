import { describe, expect, it } from "vitest";
import {
  QualityTimeline,
  calculateCrossVenue,
  canonicalQuality,
  reconcileVolumes,
  validateProvenance,
  weakestQuality,
} from "../platform";

describe("canonical platform quality", () => {
  it("maps legacy states without overstating completeness", () => {
    expect(canonicalQuality("full")).toBe("FULL");
    expect(canonicalQuality("full", true)).toBe("REPLAY FULL");
    expect(canonicalQuality("live-partial")).toBe("LIVE PARTIAL");
    expect(canonicalQuality("aggregate-only")).toBe("AGGREGATE ONLY");
    expect(canonicalQuality("proxy")).toBe("UNAVAILABLE");
    expect(weakestQuality(["FULL", "STALE", "LIVE PARTIAL"])).toBe("STALE");
  });

  it("requires evidence for quality improvements", () => {
    const timeline = new QualityTimeline("GAPPED");
    expect(() => timeline.transition("FULL", "resynchronized")).toThrow(/requires evidence/);
    expect(timeline.transition("FULL", "resynchronized", 100, "snapshot 42 reconciled")?.to).toBe("FULL");
    expect(timeline.transition("STALE", "heartbeat expired", 200)?.from).toBe("FULL");
    expect(timeline.snapshot()).toHaveLength(2);
  });

  it("reconciles derived and source volume", () => {
    expect(reconcileVolumes(99, 100, 0.02).passed).toBe(true);
    expect(reconcileVolumes(96, 100, 0.03).passed).toBe(false);
    expect(reconcileVolumes(0, 0).ratio).toBe(1);
  });

  it("rejects full provenance without complete evidence", () => {
    const errors = validateProvenance({
      venue: "Binance",
      productType: "spot",
      symbol: "BTC/USDT",
      venueSymbol: "BTCUSDT",
      sourceTimestamp: 100,
      receiveTimestamp: 110,
      dataAgeMs: 5,
      quality: "FULL",
      calculationId: "session-cvd",
      calculationVersion: "1.0.0",
      completeness: 0.9,
      reconciliation: { derivedVolume: 90, sourceVolume: 100, ratio: 0.9, difference: -10, tolerance: 0.03, passed: false },
    });
    expect(errors).toContain("full quality requires complete coverage");
    expect(errors).toContain("full quality requires passing reconciliation");
  });
});

describe("cross venue analytics", () => {
  it("conserves venue volume and CVD", () => {
    const result = calculateCrossVenue([
      { venue: "Binance", price: 100, buyVolume: 60, sellVolume: 40, bidLiquidity: 100, askLiquidity: 80, quality: "FULL" },
      { venue: "Coinbase", price: 101, buyVolume: 20, sellVolume: 30, bidLiquidity: 50, askLiquidity: 50, quality: "FULL" },
      { venue: "OKX", price: 99, buyVolume: 25, sellVolume: 25, bidLiquidity: 25, askLiquidity: 25, quality: "LIVE PARTIAL" },
    ]);
    expect(result.totalVolume).toBe(200);
    expect(result.consolidatedCvd).toBe(10);
    expect(Object.values(result.venueShare).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1);
    expect(result.quality).toBe("LIVE PARTIAL");
    expect(result.priceDivergenceBps).toBeGreaterThan(0);
    expect(result.liquidityFragmentation).toBeGreaterThan(0);
  });
});
