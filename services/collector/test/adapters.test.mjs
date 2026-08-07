import assert from "node:assert/strict";
import test from "node:test";
import { VENUE_ADAPTERS } from "../adapters.mjs";

const contexts = {
  binance: { venue: "binance", venueSymbol: "BTCUSDT", symbol: "BTC/USDT", productType: "spot" },
  coinbase: { venue: "coinbase", venueSymbol: "BTC-USD", symbol: "BTC/USD", productType: "spot" },
  bybit: { venue: "bybit", venueSymbol: "BTCUSDT", symbol: "BTC/USDT", productType: "perpetual" },
  okx: { venue: "okx", venueSymbol: "BTC-USDT-SWAP", symbol: "BTC/USDT", productType: "perpetual" },
  hyperliquid: { venue: "hyperliquid", venueSymbol: "BTC", symbol: "BTC/USD", productType: "perpetual" },
  deribit: { venue: "deribit", venueSymbol: "BTC-PERPETUAL", symbol: "BTC/USD", productType: "perpetual" },
};

const fixtures = {
  binance: JSON.stringify({ stream: "btcusdt@aggTrade", data: { e: "aggTrade", a: 42, p: "100", q: "2", T: 1_000, m: false } }),
  coinbase: JSON.stringify({ channel: "market_trades", sequence_num: 4, timestamp: "1970-01-01T00:00:01.000Z", events: [{ type: "update", trades: [{ trade_id: "4", price: "100", size: "2", side: "BUY", time: "1970-01-01T00:00:01.000Z" }] }] }),
  bybit: JSON.stringify({ topic: "publicTrade.BTCUSDT", ts: 1_000, data: [{ i: "5", T: 1_000, p: "100", v: "2", S: "Buy", seq: 5 }] }),
  okx: JSON.stringify({ arg: { channel: "trades", instId: "BTC-USDT-SWAP" }, data: [{ tradeId: "6", ts: "1000", px: "100", sz: "2", side: "buy" }] }),
  hyperliquid: JSON.stringify({ channel: "trades", data: [{ tid: 7, time: 1_000, px: "100", sz: "2", side: "B" }] }),
  deribit: JSON.stringify({ params: { channel: "trades.BTC-PERPETUAL.raw", data: [{ trade_id: "8", trade_seq: 8, timestamp: 1_000, price: 100, amount: 2, direction: "buy" }] } }),
};

for (const venue of Object.keys(fixtures)) {
  test(`${venue} trade fixture normalizes to the common contract`, () => {
    const events = VENUE_ADAPTERS[venue].parse(fixtures[venue], contexts[venue]);
    assert.equal(events.length, 1);
    const event = events[0];
    assert.equal(event.eventType, "trade");
    assert.equal(event.venue, venue);
    assert.equal(event.payload.price, 100);
    assert.equal(event.payload.size, 2);
    assert.equal(event.payload.side, "buy");
    assert.equal(event.payload.notional, 200);
  });
}

test("every required venue exposes depth and trade subscriptions", () => {
  assert.deepEqual(Object.keys(VENUE_ADAPTERS).sort(), ["binance", "bybit", "coinbase", "deribit", "hyperliquid", "okx"]);
  for (const adapter of Object.values(VENUE_ADAPTERS)) {
    assert.equal(typeof adapter.wsUrl, "function");
    assert.equal(typeof adapter.parse, "function");
  }
});
