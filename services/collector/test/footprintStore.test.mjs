import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FootprintStore, footprintCacheKey } from "../footprintStore.mjs";

test("completed footprint cache is deterministic and reusable", async () => {
  const root = await mkdtemp(join(tmpdir(), "veilflow-footprints-"));
  try {
    const store = new FootprintStore(root);
    const input = {
      sessionId: "binance-btc",
      eventHash: "sha256:events",
      timeframe: "5m",
      tickSize: 0.1,
      options: { startTime: 1_000, endTime: 301_000, imbalanceRatio: 3, minVolume: 1 },
    };
    const key = footprintCacheKey(input);
    assert.equal(key, footprintCacheKey(input));
    assert.notEqual(key, footprintCacheKey({ ...input, options: { ...input.options, endTime: 601_000 } }));

    assert.equal(await store.get(input.sessionId, key), undefined);
    const written = await store.put(input.sessionId, key, {
      payload: { outputHash: "sha256:output", footprints: [{ time: 0, delta: 7 }] },
    });
    assert.equal(written.key, key);

    const loaded = await store.get(input.sessionId, key);
    assert.equal(loaded.payload.outputHash, "sha256:output");
    assert.deepEqual(loaded.payload.footprints, [{ time: 0, delta: 7 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
