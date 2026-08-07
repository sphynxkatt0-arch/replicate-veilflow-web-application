import type { Page } from "@playwright/test";

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000,
  "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
};

function klines(interval: string, now = Date.now()) {
  const duration = INTERVAL_MS[interval] ?? INTERVAL_MS["5m"];
  const latest = Math.floor(now / duration) * duration;
  return Array.from({ length: 60 }, (_, index) => {
    const time = latest - (59 - index) * duration;
    const open = 99_500 + index * 10;
    const close = open + (index % 2 ? -4 : 6);
    return [time, open.toFixed(2), (Math.max(open, close) + 20).toFixed(2), (Math.min(open, close) - 20).toFixed(2), close.toFixed(2), (12 + index / 10).toFixed(4), time + duration - 1, "0", 100 + index, (6 + index / 20).toFixed(4), "0", "0"];
  });
}

function trades(now = Date.now()) {
  return Array.from({ length: 100 }, (_, index) => ({
    a: 1_000 + index,
    p: (100_000 + (index % 20) * 0.5).toFixed(2),
    q: (0.01 + (index % 5) * 0.002).toFixed(4),
    f: 2_000 + index,
    l: 2_000 + index,
    T: now - (99 - index) * 1_000,
    m: index % 2 === 1,
  }));
}

export async function installDeterministicBinance(page: Page) {
  await page.route(/https:\/\/(?:api|api1|data-api|fapi)\.binance(?:\.com|\.vision)\//, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const now = Date.now();
    let body: unknown;
    if (path.endsWith("/klines")) body = klines(url.searchParams.get("interval") ?? "5m", now);
    else if (path.endsWith("/depth")) body = { lastUpdateId: 100, bids: [["99999.50", "2.4"], ["99999.00", "3.1"]], asks: [["100000.50", "2.1"], ["100001.00", "2.8"]] };
    else if (path.endsWith("/aggTrades")) body = trades(now);
    else if (path.endsWith("/ticker/24hr")) body = { lastPrice: "100000.00", volume: "19450.25", quoteVolume: "1945025000.00" };
    else if (path.endsWith("/premiumIndex")) body = { symbol: "BTCUSDT", markPrice: "100002.00", indexPrice: "99998.00", lastFundingRate: "0.0001", time: now };
    else if (path.endsWith("/openInterest")) body = { symbol: "BTCUSDT", openInterest: "24500.50", time: now };
    else body = {};
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.routeWebSocket(/wss:\/\/(?:stream|fstream)\.binance\.com(?::\d+)?\/stream/, (socket) => {
    const perpetual = socket.url().includes("fstream");
    const now = Date.now();
    const candleStart = Math.floor(now / 300_000) * 300_000;
    const messages: unknown[] = [
      { stream: "btcusdt@depth@100ms", data: { e: "depthUpdate", E: now, s: "BTCUSDT", U: 101, u: 101, ...(perpetual ? { pu: 100 } : {}), b: [["99999.50", "2.5"]], a: [["100000.50", "2.2"]] } },
      { stream: "btcusdt@aggTrade", data: { e: "aggTrade", E: now + 1, s: "BTCUSDT", a: 1_100, p: "100000.25", q: "0.025", f: 3_000, l: 3_000, T: now + 1, m: false } },
      { stream: "btcusdt@kline_5m", data: { e: "kline", E: now + 2, s: "BTCUSDT", k: { t: candleStart, T: candleStart + 299_999, s: "BTCUSDT", i: "5m", o: "99980", c: "100000.25", h: "100020", l: "99960", v: "25", n: 180, x: false, V: "14" } } },
    ];
    if (perpetual) messages.push({ stream: "btcusdt@markPrice@1s", data: { e: "markPriceUpdate", E: now + 3, s: "BTCUSDT", p: "100002.00", i: "99998.00", r: "0.0001", T: now + 28_800_000 } });
    setTimeout(() => messages.forEach((message) => socket.send(JSON.stringify(message))), 50);
  });
}
