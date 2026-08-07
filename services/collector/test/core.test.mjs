import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileEventLog, LocalBook, SequenceValidator, normalizedEvent, sha256 } from "../core.mjs";

function trade(id, sequence, time = Number(sequence) * 100) {
  return normalizedEvent({
    id,
    venue: "binance",
    productType: "spot",
    symbol: "BTC/USDT",
    venueSymbol: "BTCUSDT",
    eventType: "trade",
    exchangeTimestamp: time,
    receiveTimestamp: time + 5,
    sequence,
    quality: "FULL",
    payload: { price: 100, size: 1, side: "buy" },
  });
}

test("sequence validator rejects duplicates and reorders bounded events", () => {
  const validator = new SequenceValidator({ maxReorder: 4 });
  assert.deepEqual(validator.accept(trade("1", 1)).ready.map((event) => event.id), ["1"]);
  assert.equal(validator.accept(trade("3", 3)).status, "buffered");
  const bridged = validator.accept(trade("2", 2));
  assert.deepEqual(bridged.ready.map((event) => event.id), ["2", "3"]);
  assert.equal(validator.accept(trade("dup", 3)).status, "duplicate");
});

test("local book deletes zero levels and never remains crossed", () => {
  const book = new LocalBook();
  book.snapshot({ bids: [[100, 2], [99, 1]], asks: [[101, 2], [102, 1]] }, 1);
  const updated = book.update({ bids: [[100, 0], [102, 1]], asks: [[101, 1]] }, 2);
  assert.equal(updated.bids.some((level) => level.price === 100), false);
  assert.ok(!updated.bids[0] || !updated.asks[0] || updated.bids[0].price < updated.asks[0].price);
});

test("append-only session verifies event and manifest hashes", async () => {
  const root = await mkdtemp(join(tmpdir(), "veilflow-"));
  const log = new FileEventLog(root);
  const session = await log.createSession({ id: "golden", venue: "binance", venueSymbol: "BTCUSDT", symbol: "BTC/USDT", productType: "spot" });
  await log.append(session.id, [trade("1", 1), trade("2", 2)]);
  await log.checkpoint(session.id, { price: 100 }, 1, 200);
  const manifest = await log.finalize(session.id, sha256({ delta: 2 }));
  assert.equal(manifest.eventCount, 2);
  assert.equal((await log.verify(session.id)).passed, true);
  const raw = await readFile(log.eventsPath(session.id), "utf8");
  assert.equal(raw.trim().split("\n").length, 2);
});
