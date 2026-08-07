import { describe, expect, it } from "vitest";
import { MARKETS } from "../markets";
import { createReplayArchive, EventRecorder, reduceReplay, validateReplayArchive, type ReplayArchiveV4 } from "../recorder";
import type { MarketState, NormalizedEvent } from "../types";

const EVENTS: NormalizedEvent[] = [
  {
    id: "trade-1",
    type: "trade",
    market: "BTC",
    exchangeTime: 1_000,
    receiveTime: 1_010,
    payload: {
      id: "1",
      exchangeTime: 1_000,
      receiveTime: 1_010,
      price: 100,
      size: 2,
      side: "buy",
      notional: 200,
      sequence: 1,
      source: "live",
    },
  },
  {
    id: "trade-2",
    type: "trade",
    market: "BTC",
    exchangeTime: 1_100,
    receiveTime: 1_110,
    payload: {
      id: "2",
      exchangeTime: 1_100,
      receiveTime: 1_110,
      price: 101,
      size: 1,
      side: "sell",
      notional: 101,
      sequence: 2,
      source: "live",
    },
  },
];

const BASE_STATE: MarketState = {
  market: MARKETS.BTC,
  timeframe: "1m",
  candles: [],
  trades: [],
  footprints: [],
  footprintCoverage: { quality: "aggregate-only", source: "none", contiguous: true, eventCount: 0, detail: "fixture" },
  book: null,
  metrics: { timestamp: 0, quality: "unavailable" },
  analytics: { dataQuality: "unavailable" },
  status: "closed",
  statusDetail: "fixture",
  lastEventAt: 0,
  eventRate: 0,
  eventLagMs: 0,
};

describe("replay archive integrity", () => {
  it("produces deterministic manifests and state hashes", () => {
    const left = createReplayArchive(MARKETS.BTC, "1m", EVENTS, 5_000);
    const right = createReplayArchive(MARKETS.BTC, "1m", EVENTS, 5_000);
    expect(left).toEqual(right);
    expect(left.format).toBe("veilflow-session-v4");
    expect(left.eventCount).toBe(2);
    expect(left.eventHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(left.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(left.analyticsOutputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(left.checkpoints[0].stateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => validateReplayArchive(left)).not.toThrow();
  });

  it("rejects a modified event payload", () => {
    const archive = createReplayArchive(MARKETS.BTC, "1m", EVENTS, 5_000);
    const corrupted = structuredClone(archive) as ReplayArchiveV4;
    const first = corrupted.events[0];
    if (first.type !== "trade") throw new Error("fixture error");
    first.payload.price = 999;
    expect(() => validateReplayArchive(corrupted)).toThrow(/event integrity hash mismatch/);
  });

  it("rejects modified venue or instrument metadata", () => {
    const archive = createReplayArchive(MARKETS.BTC, "1m", EVENTS, 5_000);
    const corrupted = structuredClone(archive) as ReplayArchiveV4;
    corrupted.market = { ...corrupted.market, venue: "Untrusted venue" };
    expect(() => validateReplayArchive(corrupted)).toThrow(/manifest integrity hash mismatch/);
  });

  it("rejects modified checkpoint state", () => {
    const archive = createReplayArchive(MARKETS.BTC, "1m", EVENTS, 5_000);
    const corrupted = structuredClone(archive) as ReplayArchiveV4;
    corrupted.checkpoints[0].stateHash = "sha256:bad";
    expect(() => validateReplayArchive(corrupted)).toThrow(/manifest integrity hash mismatch|checkpoint 0 integrity mismatch/);
  });

  it("rejects mixed-instrument event streams", () => {
    const mixed: NormalizedEvent[] = [
      ...EVENTS,
      { ...EVENTS[1], id: "wrong-market", market: "BTCPERP" },
    ];
    expect(() => createReplayArchive(MARKETS.BTC, "1m", mixed, 5_000)).toThrow(/mixed instruments/);
    expect(() => new EventRecorder().importJson(JSON.stringify({ format: "veilflow-session-v2", events: mixed }))).toThrow(/mixed instruments/);
  });

  it("seeks through a large stream with deterministic checkpoint output", () => {
    const events = Array.from({ length: 6_100 }, (_, index): NormalizedEvent => ({
      id: `trade-${index}`,
      type: "trade",
      market: "BTC",
      exchangeTime: 10_000 + index,
      receiveTime: 10_001 + index,
      payload: {
        id: String(index), exchangeTime: 10_000 + index, receiveTime: 10_001 + index,
        price: 100 + index / 10_000, size: 1, side: index % 2 ? "sell" : "buy", notional: 100, sequence: index, source: "live",
      },
    }));
    const archive = createReplayArchive(MARKETS.BTC, "1m", events, 5_000);
    expect(archive.checkpoints).toHaveLength(2);
    const first = reduceReplay(BASE_STATE, { mode: "events", playing: false, speed: 1, cursor: 5_499, events });
    const second = reduceReplay(BASE_STATE, { mode: "events", playing: false, speed: 1, cursor: 5_499, events });
    expect(first).toEqual(second);
    expect(first.trades).toHaveLength(5_500);
    expect(first.lastEventAt).toBe(15_499);
  });

  it("round-trips v4 archives and remains backward compatible", () => {
    const recorder = new EventRecorder();
    EVENTS.forEach((event) => recorder.append(event));
    const raw = recorder.exportJson(MARKETS.BTC, "1m");
    const imported = new EventRecorder().importJson(raw);
    expect(imported).toEqual(EVENTS);

    const legacy = JSON.stringify({ format: "veilflow-session-v2", events: EVENTS });
    expect(new EventRecorder().importJson(legacy)).toEqual(EVENTS);
  });
});
