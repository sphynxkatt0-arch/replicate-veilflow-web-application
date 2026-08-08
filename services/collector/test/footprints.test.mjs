import assert from "node:assert/strict";
import test from "node:test";
import { buildFootprints, footprintCoverage } from "../footprints.mjs";
import { normalizedEvent } from "../core.mjs";

function trade(id, time, price, size, side, quality = "FULL") {
  return normalizedEvent({
    id,
    venue: "binance",
    productType: "spot",
    symbol: "BTC/USDT",
    venueSymbol: "BTCUSDT",
    eventType: "trade",
    exchangeTimestamp: time,
    receiveTimestamp: time + 1,
    sequence: id,
    quality,
    payload: { price, size, side },
  });
}

function quality(id, time, to) {
  return normalizedEvent({
    id,
    venue: "binance",
    productType: "spot",
    symbol: "BTC/USDT",
    venueSymbol: "BTCUSDT",
    eventType: "quality",
    exchangeTimestamp: time,
    receiveTimestamp: time + 1,
    sequence: id,
    quality: to,
    payload: { to },
  });
}

test("server footprints expose full professional row schema", () => {
  const events = [
    trade("1", 1_000, 100, 1, "sell"),
    trade("2", 2_000, 101, 4, "buy"),
    trade("3", 3_000, 102, 8, "buy"),
    trade("4", 4_000, 103, 16, "buy"),
  ];
  const [footprint] = buildFootprints(events, "1m", 1, { imbalanceRatio: 3, minVolume: 1 });
  assert.equal(footprint.totalBidVolume, 1);
  assert.equal(footprint.totalAskVolume, 28);
  assert.equal(footprint.delta, 27);
  assert.equal(footprint.tradeCount, 4);
  assert.equal(footprint.pocPrice, 103);
  assert.equal(footprint.maxDelta, 16);
  assert.equal(footprint.minDelta, -1);
  assert.equal(footprint.priceStep, 1);
  assert.ok(footprint.rows.every((row) => typeof row.bidTrades === "number" && typeof row.askTrades === "number"));
  assert.ok(footprint.rows.some((row) => row.askImbalance));
  assert.match(footprint.hash, /^sha256:/);
});

test("quality transitions propagate into historical footprint coverage", () => {
  const events = [
    trade("1", 1_000, 100, 1, "buy"),
    quality("gap", 2_000, "GAPPED"),
    trade("3", 3_000, 101, 2, "sell", "GAPPED"),
  ];
  const footprints = buildFootprints(events, "1m", 1);
  const coverage = footprintCoverage(events, footprints, { startTime: 1_000, endTime: 3_000 });
  assert.equal(coverage.quality, "GAPPED");
  assert.equal(coverage.contiguous, false);
  assert.equal(coverage.eventCount, 2);
  assert.equal(coverage.availableStartTime, 1_000);
  assert.equal(coverage.availableEndTime, 3_000);
  assert.equal(coverage.firstSequence, "1");
  assert.equal(coverage.lastSequence, "3");
});

test("recovered quality before a requested range does not poison later coverage", () => {
  const events = [
    quality("gap", 1_000, "GAPPED"),
    quality("recover", 2_000, "FULL"),
    trade("3", 61_000, 101, 2, "buy"),
  ];
  const footprints = buildFootprints(events, "1m", 1, { startTime: 60_000, endTime: 119_999 });
  const coverage = footprintCoverage(events, footprints, { startTime: 60_000, endTime: 119_999 });
  assert.equal(footprints[0].quality, "FULL");
  assert.equal(coverage.quality, "FULL");
  assert.equal(coverage.contiguous, true);
});

test("historical range filtering does not leak trades outside the request", () => {
  const events = [
    trade("1", 1_000, 100, 1, "buy"),
    trade("2", 61_000, 101, 2, "buy"),
    trade("3", 121_000, 102, 3, "sell"),
  ];
  const footprints = buildFootprints(events, "1m", 1, { startTime: 60_000, endTime: 119_999 });
  const coverage = footprintCoverage(events, footprints, { startTime: 60_000, endTime: 119_999 });
  assert.equal(footprints.length, 1);
  assert.equal(footprints[0].time, 60_000);
  assert.equal(footprints[0].totalVolume, 2);
  assert.equal(coverage.firstSequence, "2");
  assert.equal(coverage.lastSequence, "2");
});
