import { describe, expect, it } from "vitest";
import { MARKETS } from "../markets";
import { createReplayArchive, EventRecorder, validateReplayArchive, type ReplayArchiveV3 } from "../recorder";
import type { NormalizedEvent } from "../types";

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

describe("replay archive integrity", () => {
  it("produces deterministic manifests for the same event stream", () => {
    const left = createReplayArchive(MARKETS.BTC, "1m", EVENTS, 5_000);
    const right = createReplayArchive(MARKETS.BTC, "1m", EVENTS, 5_000);
    expect(left).toEqual(right);
    expect(left.eventCount).toBe(2);
    expect(left.eventHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(left.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => validateReplayArchive(left)).not.toThrow();
  });

  it("rejects a modified event payload", () => {
    const archive = createReplayArchive(MARKETS.BTC, "1m", EVENTS, 5_000);
    const corrupted = structuredClone(archive) as ReplayArchiveV3;
    const first = corrupted.events[0];
    if (first.type !== "trade") throw new Error("fixture error");
    first.payload.price = 999;
    expect(() => validateReplayArchive(corrupted)).toThrow(/event integrity hash mismatch/);
  });

  it("rejects modified venue or instrument metadata", () => {
    const archive = createReplayArchive(MARKETS.BTC, "1m", EVENTS, 5_000);
    const corrupted = structuredClone(archive) as ReplayArchiveV3;
    corrupted.market = { ...corrupted.market, venue: "Untrusted venue" };
    expect(() => validateReplayArchive(corrupted)).toThrow(/manifest integrity hash mismatch/);
  });

  it("rejects mixed-instrument event streams", () => {
    const mixed: NormalizedEvent[] = [
      ...EVENTS,
      { ...EVENTS[1], id: "wrong-market", market: "BTCPERP" },
    ];
    expect(() => createReplayArchive(MARKETS.BTC, "1m", mixed, 5_000)).toThrow(/mixed instruments/);
    expect(() => new EventRecorder().importJson(JSON.stringify({ format: "veilflow-session-v2", events: mixed }))).toThrow(/mixed instruments/);
  });

  it("round-trips v3 archives and remains backward compatible", () => {
    const recorder = new EventRecorder();
    EVENTS.forEach((event) => recorder.append(event));
    const raw = recorder.exportJson(MARKETS.BTC, "1m");
    const imported = new EventRecorder().importJson(raw);
    expect(imported).toEqual(EVENTS);

    const legacy = JSON.stringify({ format: "veilflow-session-v2", events: EVENTS });
    expect(new EventRecorder().importJson(legacy)).toEqual(EVENTS);
  });
});
