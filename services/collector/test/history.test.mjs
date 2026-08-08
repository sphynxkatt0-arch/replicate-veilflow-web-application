import assert from "node:assert/strict";
import test from "node:test";
import {
  collectBinanceAggTrades,
  inspectAggTradeContinuity,
  mapBinanceAggTradeEvent,
  parseTime,
} from "../history.mjs";

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const DATA = [
  { a: 10, T: 100, p: "100", q: "1", f: 1000, l: 1000, m: false },
  { a: 11, T: 200, p: "101", q: "2", f: 1001, l: 1001, m: true },
  { a: 12, T: 300, p: "102", q: "3", f: 1002, l: 1002, m: false },
  { a: 13, T: 1100, p: "103", q: "4", f: 1003, l: 1003, m: true },
  { a: 14, T: 1200, p: "104", q: "5", f: 1004, l: 1004, m: false },
];

test("collectBinanceAggTrades paginates inside windows without duplicates", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed);
    const limit = Number(parsed.searchParams.get("limit"));
    const fromId = parsed.searchParams.get("fromId");
    if (fromId !== null) {
      const id = Number(fromId);
      return response(DATA.filter((row) => row.a >= id).slice(0, limit));
    }
    const start = Number(parsed.searchParams.get("startTime"));
    const end = Number(parsed.searchParams.get("endTime"));
    return response(DATA.filter((row) => row.T >= start && row.T <= end).slice(0, limit));
  };

  const result = await collectBinanceAggTrades({
    symbol: "BTCUSDT",
    startTime: 1,
    endTime: 1999,
    pageSize: 2,
    windowMs: 1000,
    fetchImpl,
  });

  assert.deepEqual(result.rows.map((row) => row.a), [10, 11, 12, 13, 14]);
  assert.equal(result.contiguous, true);
  assert.equal(result.gaps.length, 0);
  assert.ok(calls.some((url) => url.searchParams.get("fromId") === "12"));
  assert.ok(calls.some((url) => url.searchParams.get("startTime") === "1001"));
});

test("inspectAggTradeContinuity makes missing execution IDs explicit", () => {
  const result = inspectAggTradeContinuity([DATA[0], DATA[2]]);
  assert.equal(result.contiguous, false);
  assert.deepEqual(result.gaps, [{ expected: 11, received: 12, exchangeTime: 300 }]);
});

test("mapBinanceAggTradeEvent preserves aggressor side and provenance", () => {
  const buy = mapBinanceAggTradeEvent(DATA[0], { venueSymbol: "BTCUSDT", symbol: "BTC/USDT", productType: "spot" });
  const sell = mapBinanceAggTradeEvent(DATA[1], { venueSymbol: "BTCUSDT", symbol: "BTC/USDT", productType: "spot" });
  assert.equal(buy.eventType, "trade");
  assert.equal(buy.payload.side, "buy");
  assert.equal(sell.payload.side, "sell");
  assert.equal(sell.payload.source, "binance-aggtrades-history");
  assert.equal(sell.sequence, "11");
});

test("parseTime accepts milliseconds and ISO timestamps", () => {
  assert.equal(parseTime("1234", 0), 1234);
  assert.equal(parseTime("1970-01-01T00:00:02.000Z", 0), 2000);
  assert.equal(parseTime(undefined, 99), 99);
});
