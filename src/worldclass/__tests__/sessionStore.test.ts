import { describe, expect, it } from "vitest";
import { MARKETS } from "../markets";
import { MemorySessionStore, createStoredSession } from "../sessionStore";
import type { NormalizedEvent } from "../types";

const event: NormalizedEvent = {
  id: "trade-1",
  type: "trade",
  market: "BTC",
  exchangeTime: 1_000,
  receiveTime: 1_005,
  payload: {
    id: "1",
    exchangeTime: 1_000,
    receiveTime: 1_005,
    price: 100,
    size: 1,
    side: "buy",
    notional: 100,
    sequence: 1,
    source: "live",
  },
};

describe("session catalogue", () => {
  it("stores, lists, reads, and deletes validated archives", async () => {
    const store = new MemorySessionStore();
    const session = createStoredSession("Golden session", MARKETS.BTC, "1m", [event], 5_000);
    await store.put(session);
    expect((await store.list())[0]).toMatchObject({ id: session.id, eventCount: 1, marketKey: "BTC" });
    expect((await store.get(session.id))?.archive.eventHash).toBe(session.eventHash);
    await store.delete(session.id);
    expect(await store.list()).toEqual([]);
  });

  it("returns defensive copies", async () => {
    const store = new MemorySessionStore();
    const session = createStoredSession("Immutable", MARKETS.BTC, "1m", [event], 5_000);
    await store.put(session);
    const loaded = await store.get(session.id);
    if (!loaded) throw new Error("missing fixture");
    loaded.name = "changed";
    expect((await store.get(session.id))?.name).toBe("Immutable");
  });
});
