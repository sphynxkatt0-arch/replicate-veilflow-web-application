import assert from "node:assert/strict";
import test from "node:test";
import { buildFootprints, eventsToCsv } from "../api.mjs";
import { normalizedEvent } from "../core.mjs";

function trade(id, time, price, size, side) {
  return normalizedEvent({ id, venue: "binance", productType: "spot", symbol: "BTC/USDT", venueSymbol: "BTCUSDT", eventType: "trade", exchangeTimestamp: time, receiveTimestamp: time + 1, sequence: id, quality: "FULL", payload: { price, size, side } });
}

test("historical footprint API conserves price-level volume", () => {
  const events = [
    trade("1", 1_000, 100, 2, "buy"),
    trade("2", 2_000, 100, 1, "sell"),
    trade("3", 3_000, 101, 3, "buy"),
  ];
  const footprints = buildFootprints(events, "1m", 1);
  assert.equal(footprints.length, 1);
  assert.equal(footprints[0].totalBidVolume, 1);
  assert.equal(footprints[0].totalAskVolume, 5);
  assert.equal(footprints[0].totalVolume, 6);
  assert.equal(footprints[0].delta, 4);
  assert.equal(footprints[0].pocPrice, 101);
});

test("CSV export preserves the normalized payload", () => {
  const csv = eventsToCsv([trade("1", 1_000, 100, 2, "buy")]);
  assert.match(csv, /eventType/);
  assert.match(csv, /trade/);
  assert.match(csv, /BTCUSDT/);
  assert.match(csv, /"\{"/);
});
