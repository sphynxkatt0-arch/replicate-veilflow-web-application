import { join } from "node:path";
import { collectBinanceArchiveTrades } from "./binanceArchive.mjs";
import { FileEventLog, normalizedEvent, sha256 } from "./core.mjs";

const HOUR_MS = 60 * 60_000;
const DEFAULT_PAGE_SIZE = 1_000;
const DEFAULT_LOOKBACK_MS = 24 * HOUR_MS;

function asFiniteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number`);
  return number;
}

export function parseTime(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) throw new Error(`Invalid time value: ${value}`);
  return parsed;
}

export function binanceAggTradeEndpoint(productType = "spot") {
  return productType === "perpetual"
    ? "https://fapi.binance.com/fapi/v1/aggTrades"
    : "https://api.binance.com/api/v3/aggTrades";
}

function normalizeRawAggTrade(raw) {
  const id = asFiniteNumber(raw.a, "aggregate trade id");
  const exchangeTime = asFiniteNumber(raw.T, "aggregate trade timestamp");
  const price = asFiniteNumber(raw.p, "aggregate trade price");
  const size = asFiniteNumber(raw.q, "aggregate trade size");
  return {
    a: id,
    T: exchangeTime,
    p: price,
    q: size,
    f: raw.f === undefined ? undefined : Number(raw.f),
    l: raw.l === undefined ? undefined : Number(raw.l),
    m: Boolean(raw.m),
  };
}

async function fetchAggTradePage({ endpoint, symbol, fetchImpl, pageSize, startTime, endTime, fromId }) {
  const url = new URL(endpoint);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("limit", String(pageSize));
  if (fromId !== undefined) url.searchParams.set("fromId", String(fromId));
  else {
    url.searchParams.set("startTime", String(Math.floor(startTime)));
    url.searchParams.set("endTime", String(Math.floor(endTime)));
  }

  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    const detail = typeof response.text === "function" ? await response.text().catch(() => "") : "";
    throw new Error(`Binance aggTrades ${response.status}${detail ? `: ${detail.slice(0, 240)}` : ""}`);
  }
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error("Binance aggTrades returned a non-array payload");
  return body.map(normalizeRawAggTrade).sort((left, right) => left.a - right.a);
}

export function inspectAggTradeContinuity(rows) {
  const sorted = [...rows].sort((left, right) => left.a - right.a);
  const gaps = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (current.a > previous.a + 1) {
      gaps.push({
        expected: previous.a + 1,
        received: current.a,
        exchangeTime: current.T,
      });
    }
  }
  return {
    contiguous: gaps.length === 0,
    gaps,
    firstId: sorted[0]?.a,
    lastId: sorted.at(-1)?.a,
    firstTime: sorted[0]?.T,
    lastTime: sorted.at(-1)?.T,
  };
}

export async function collectBinanceAggTrades({
  symbol,
  productType = "spot",
  startTime,
  endTime,
  fetchImpl = globalThis.fetch,
  pageSize = DEFAULT_PAGE_SIZE,
  windowMs = HOUR_MS,
  onProgress,
} = {}) {
  if (!symbol) throw new Error("symbol is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  const start = asFiniteNumber(startTime, "startTime");
  const end = asFiniteNumber(endTime, "endTime");
  if (start <= 0 || end <= 0 || end < start) throw new Error("endTime must be greater than or equal to startTime");
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > 1_000) throw new Error("pageSize must be between 1 and 1000");
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("windowMs must be positive");

  const endpoint = binanceAggTradeEndpoint(productType);
  const byId = new Map();
  let requestCount = 0;

  for (let windowStart = start; windowStart <= end; windowStart += windowMs) {
    const windowEnd = Math.min(end, windowStart + windowMs - 1);
    let page = await fetchAggTradePage({ endpoint, symbol, fetchImpl, pageSize, startTime: windowStart, endTime: windowEnd });
    requestCount += 1;

    while (page.length) {
      for (const row of page) {
        if (row.T >= start && row.T <= end) byId.set(row.a, row);
      }
      onProgress?.({ requestCount, eventCount: byId.size, windowStart, windowEnd, lastId: page.at(-1)?.a });

      const last = page.at(-1);
      if (!last || page.length < pageSize || last.T >= windowEnd) break;

      const nextFromId = last.a + 1;
      page = await fetchAggTradePage({ endpoint, symbol, fetchImpl, pageSize, fromId: nextFromId });
      requestCount += 1;
      if (page[0]?.T > windowEnd) break;
    }
  }

  const rows = [...byId.values()]
    .filter((row) => row.T >= start && row.T <= end)
    .sort((left, right) => left.a - right.a);
  return { rows, requestCount, ...inspectAggTradeContinuity(rows) };
}

export async function collectBinanceHistoricalTrades({
  symbol,
  productType = "spot",
  startTime,
  endTime,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  onProgress,
} = {}) {
  const start = asFiniteNumber(startTime, "startTime");
  const end = asFiniteNumber(endTime, "endTime");
  const archive = await collectBinanceArchiveTrades({
    symbol,
    productType,
    startTime: start,
    endTime: end,
    fetchImpl,
    now,
    onProgress: (progress) => onProgress?.({ source: "archive", ...progress }),
  });
  const byId = new Map(archive.rows.map((row) => [row.a, row]));
  let requestCount = 0;
  const restRanges = [];

  for (const range of archive.missingRanges) {
    const rest = await collectBinanceAggTrades({
      symbol,
      productType,
      startTime: range.startTime,
      endTime: range.endTime,
      fetchImpl,
      onProgress: (progress) => onProgress?.({ source: "rest", ...progress }),
    });
    requestCount += rest.requestCount;
    for (const row of rest.rows) byId.set(row.a, row);
    restRanges.push({ ...range, requestCount: rest.requestCount, eventCount: rest.rows.length });
  }

  const rows = [...byId.values()]
    .filter((row) => row.T >= start && row.T <= end)
    .sort((left, right) => left.a - right.a);
  return {
    rows,
    requestCount,
    archiveCount: archive.archives.length,
    archives: archive.archives,
    archiveRanges: archive.coveredRanges,
    restRanges,
    ...inspectAggTradeContinuity(rows),
  };
}

export function mapBinanceAggTradeEvent(raw, context) {
  const price = Number(raw.p);
  const size = Number(raw.q);
  const productType = context.productType === "perpetual" ? "perpetual" : "spot";
  return normalizedEvent({
    id: `binance:${context.venueSymbol}:trade:${raw.a}`,
    venue: "binance",
    productType,
    symbol: context.symbol,
    venueSymbol: context.venueSymbol,
    eventType: "trade",
    exchangeTimestamp: raw.T,
    receiveTimestamp: Date.now(),
    sequence: raw.a,
    quality: "FULL",
    payload: {
      price,
      size,
      notional: price * size,
      side: raw.m ? "sell" : "buy",
      aggregateTradeId: raw.a,
      firstTradeId: raw.f,
      lastTradeId: raw.l,
      buyerWasMaker: raw.m,
      source: context.source ?? "binance-aggtrades-history",
    },
  });
}

function qualityEvent(context, gap) {
  return normalizedEvent({
    id: `binance:${context.venueSymbol}:quality:gap:${gap.expected}-${gap.received}`,
    venue: "binance",
    productType: context.productType,
    symbol: context.symbol,
    venueSymbol: context.venueSymbol,
    eventType: "quality",
    exchangeTimestamp: gap.exchangeTime,
    receiveTimestamp: Date.now(),
    sequence: gap.received,
    quality: "GAPPED",
    payload: {
      from: "FULL",
      to: "GAPPED",
      reason: "aggregate-trade sequence gap",
      expectedSequence: String(gap.expected),
      receivedSequence: String(gap.received),
    },
  });
}

export async function backfillBinanceHistory({
  dataDir,
  sessionId,
  venueSymbol,
  symbol,
  productType = "spot",
  startTime,
  endTime,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  onProgress,
} = {}) {
  const start = asFiniteNumber(startTime, "startTime");
  const end = asFiniteNumber(endTime, "endTime");
  const normalizedProduct = productType === "perpetual" ? "perpetual" : "spot";
  const context = {
    venueSymbol: String(venueSymbol || "BTCUSDT").toUpperCase(),
    symbol: String(symbol || "BTC/USDT"),
    productType: normalizedProduct,
  };

  const result = await collectBinanceHistoricalTrades({
    symbol: context.venueSymbol,
    productType: normalizedProduct,
    startTime: start,
    endTime: end,
    fetchImpl,
    now,
    onProgress,
  });
  if (!result.rows.length) throw new Error("No Binance aggregate trades were returned for the requested range");

  const source = result.archiveCount > 0 ? (result.restRanges.length ? "binance-public-archive+rest" : "binance-public-archive") : "binance-aggtrades-rest";
  const log = new FileEventLog(dataDir);
  const id = sessionId || `binance-${context.venueSymbol}-${Math.floor(start)}-${Math.floor(end)}`.toLowerCase();
  await log.createSession({
    id,
    venue: "binance",
    venueSymbol: context.venueSymbol,
    symbol: context.symbol,
    productType: normalizedProduct,
    source,
    requestedStartTime: start,
    requestedEndTime: end,
    contiguous: result.contiguous,
    sequenceGapCount: result.gaps.length,
    archiveCount: result.archiveCount,
    restRequestCount: result.requestCount,
    archives: result.archives,
  });

  const gapsByReceivedId = new Map(result.gaps.map((gap) => [gap.received, gap]));
  const events = [];
  for (const row of result.rows) {
    const gap = gapsByReceivedId.get(row.a);
    if (gap) events.push(qualityEvent(context, gap));
    events.push(mapBinanceAggTradeEvent(row, { ...context, source }));
  }
  await log.append(id, events);

  const analyticsHash = sha256({
    source,
    firstId: result.firstId,
    lastId: result.lastId,
    firstTime: result.firstTime,
    lastTime: result.lastTime,
    eventCount: result.rows.length,
    gaps: result.gaps,
    archives: result.archives.map((archive) => ({ date: archive.date, checksum: archive.checksum, eventCount: archive.eventCount })),
    restRanges: result.restRanges,
  });
  const manifest = await log.finalize(id, analyticsHash);
  return {
    sessionId: id,
    requestedStartTime: start,
    requestedEndTime: end,
    tradeCount: result.rows.length,
    requestCount: result.requestCount,
    archiveCount: result.archiveCount,
    archives: result.archives,
    restRanges: result.restRanges,
    contiguous: result.contiguous,
    gaps: result.gaps,
    firstId: result.firstId,
    lastId: result.lastId,
    firstTime: result.firstTime,
    lastTime: result.lastTime,
    manifest,
  };
}

async function main() {
  const now = Date.now();
  const lookbackHours = Number(process.env.VEILFLOW_BACKFILL_HOURS || 24);
  const fallbackStart = now - (Number.isFinite(lookbackHours) && lookbackHours > 0 ? lookbackHours * HOUR_MS : DEFAULT_LOOKBACK_MS);
  const startTime = parseTime(process.env.VEILFLOW_START_TIME, fallbackStart);
  const endTime = parseTime(process.env.VEILFLOW_END_TIME, now);
  const productType = process.env.VEILFLOW_PRODUCT_TYPE === "perpetual" ? "perpetual" : "spot";
  const venueSymbol = (process.env.VEILFLOW_VENUE_SYMBOL || "BTCUSDT").toUpperCase();
  const symbol = process.env.VEILFLOW_SYMBOL || "BTC/USDT";
  const dataDir = process.env.VEILFLOW_DATA_DIR || join(process.cwd(), ".veilflow-data");

  const result = await backfillBinanceHistory({
    dataDir,
    sessionId: process.env.VEILFLOW_SESSION_ID,
    venueSymbol,
    symbol,
    productType,
    startTime,
    endTime,
    now,
    onProgress: (progress) => {
      if (progress.source === "archive") {
        if (progress.state === "loaded") console.log(`[backfill] archive ${new Date(progress.day).toISOString().slice(0, 10)} loaded · trades=${progress.rowCount}`);
        else if (progress.state === "missing") console.log(`[backfill] archive ${new Date(progress.day).toISOString().slice(0, 10)} unavailable; REST bridge required`);
        return;
      }
      if (progress.requestCount === 1 || progress.requestCount % 25 === 0) {
        console.log(`[backfill] REST requests=${progress.requestCount} trades=${progress.eventCount} window=${new Date(progress.windowStart).toISOString()}..${new Date(progress.windowEnd).toISOString()}`);
      }
    },
  });
  console.log(JSON.stringify({
    sessionId: result.sessionId,
    tradeCount: result.tradeCount,
    archiveCount: result.archiveCount,
    restRequestCount: result.requestCount,
    contiguous: result.contiguous,
    gapCount: result.gaps.length,
    firstTime: result.firstTime,
    lastTime: result.lastTime,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
