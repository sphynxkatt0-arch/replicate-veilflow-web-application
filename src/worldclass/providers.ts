import { collectorConfigured, loadCollectorFootprints } from "./collectorClient";
import { MARKETS, timeframeMs } from "./markets";
import { BinanceLocalBook, normalizeBook, type BinanceDepthSnapshot, type BinanceDepthUpdate } from "./orderBook";
import type {
  BinanceProduct,
  BookLevel,
  Candle,
  ConnectionState,
  FootprintCandle,
  MarketDefinition,
  MarketMetrics,
  OrderBook,
  Timeframe,
  Trade,
} from "./types";
import type { TradeCoverageInput } from "./footprint";

export interface Snapshot {
  candles: Candle[];
  trades: Trade[];
  tradeCoverage: TradeCoverageInput;
  footprints?: FootprintCandle[];
  book: OrderBook | null;
  metrics: MarketMetrics;
}

export interface ProviderHandlers {
  onCandle: (candle: Candle) => void;
  onTrade: (trade: Trade) => void;
  onTradeGap?: (exchangeTime: number, detail: string) => void;
  onBook: (book: OrderBook) => void;
  onMetrics: (metrics: MarketMetrics) => void;
  onState: (state: ConnectionState, detail: string) => void;
}

export interface ProviderController { close: () => void; }

interface BinanceApiConfig {
  product: BinanceProduct;
  rest: string[];
  ws: string[];
}

const BINANCE_SPOT: BinanceApiConfig = {
  product: "spot",
  rest: [
    "https://api.binance.com/api/v3",
    "https://api1.binance.com/api/v3",
    "https://data-api.binance.vision/api/v3",
  ],
  ws: ["wss://stream.binance.com:9443/stream", "wss://stream.binance.com:443/stream"],
};

const BINANCE_USDM: BinanceApiConfig = {
  product: "usdm",
  rest: ["https://fapi.binance.com/fapi/v1"],
  ws: ["wss://fstream.binance.com/stream"],
};

const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
const HYPERLIQUID_WS = "wss://api.hyperliquid.xyz/ws";
const MAX_AGG_TRADE_PAGES = 15;
const AGG_TRADE_PAGE_SIZE = 1000;

export function binanceApiConfig(market: MarketDefinition): BinanceApiConfig {
  return market.binanceProduct === "usdm" ? BINANCE_USDM : BINANCE_SPOT;
}

function numberOr(value: unknown, fallback = 0): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 12_000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const external = init.signal;
  const abort = () => controller.abort();
  external?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json() as T;
  } finally {
    window.clearTimeout(timer);
    external?.removeEventListener("abort", abort);
  }
}

async function fetchBinance<T>(market: MarketDefinition, path: string, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (const host of binanceApiConfig(market).rest) {
    try { return await fetchJson<T>(`${host}${path}`, { signal }); }
    catch (error) { lastError = error; if (signal?.aborted) throw error; }
  }
  throw lastError instanceof Error ? lastError : new Error("Binance request failed");
}

async function hyperliquidInfo<T>(payload: unknown, signal?: AbortSignal): Promise<T> {
  return fetchJson<T>(HYPERLIQUID_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  }, 15_000);
}

type BinanceKline = [number, string, string, string, string, string, number, string, number, string, string, string];
interface BinanceAggTrade { a: number; p: string; q: string; f: number; l: number; T: number; m: boolean; }

function binanceKline(row: BinanceKline): Candle {
  const volume = numberOr(row[5]);
  const buy = numberOr(row[9]);
  return {
    time: row[0], endTime: row[6], open: numberOr(row[1]), high: numberOr(row[2]), low: numberOr(row[3]), close: numberOr(row[4]),
    volume, buyVolume: buy, sellVolume: Math.max(0, volume - buy), trades: row[8],
  };
}

function mapBinanceStreamKline(raw: Record<string, unknown>): Candle {
  const volume = numberOr(raw.v);
  const buy = numberOr(raw.V);
  return {
    time: numberOr(raw.t), endTime: numberOr(raw.T), open: numberOr(raw.o), high: numberOr(raw.h), low: numberOr(raw.l), close: numberOr(raw.c),
    volume, buyVolume: buy, sellVolume: Math.max(0, volume - buy), trades: numberOr(raw.n),
  };
}

export function mapBinanceAggTrade(market: MarketDefinition, raw: BinanceAggTrade, source: Trade["source"]): Trade {
  const price = numberOr(raw.p);
  const size = numberOr(raw.q);
  return {
    id: `${market.key}-agg-${raw.a}`,
    sequence: raw.a,
    exchangeTime: raw.T,
    receiveTime: Date.now(),
    price,
    size,
    side: raw.m ? "sell" : "buy",
    notional: price * size,
    source,
  };
}

function sequencesContiguous(rows: BinanceAggTrade[]): boolean {
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].a !== rows[index - 1].a + 1) return false;
  }
  return true;
}

async function loadRecentAggTrades(
  market: MarketDefinition,
  candles: Candle[],
  timeframe: Timeframe,
  signal?: AbortSignal,
): Promise<{ trades: Trade[]; coverage: TradeCoverageInput }> {
  const latest = await fetchBinance<BinanceAggTrade[]>(market, `/aggTrades?symbol=${market.providerSymbol}&limit=${AGG_TRADE_PAGE_SIZE}`, signal);
  if (!latest.length) {
    return {
      trades: [],
      coverage: { source: "binance-aggtrades", contiguous: true, eventCount: 0, detail: "No aggregate trades returned" },
    };
  }

  const targetStart = Math.max(
    candles[Math.max(0, candles.length - 12)]?.time ?? Date.now() - timeframeMs(timeframe) * 12,
    Date.now() - 60 * 60_000,
  );
  const byId = new Map<number, BinanceAggTrade>(latest.map((row) => [row.a, row]));
  let earliestId = Math.min(...latest.map((row) => row.a));
  let earliestTime = Math.min(...latest.map((row) => row.T));
  let pageCount = 1;

  while (pageCount < MAX_AGG_TRADE_PAGES && earliestTime > targetStart && earliestId > 0) {
    const fromId = Math.max(0, earliestId - AGG_TRADE_PAGE_SIZE);
    const page = await fetchBinance<BinanceAggTrade[]>(market, `/aggTrades?symbol=${market.providerSymbol}&fromId=${fromId}&limit=${AGG_TRADE_PAGE_SIZE}`, signal);
    const older = page.filter((row) => row.a < earliestId);
    if (!older.length) break;
    older.forEach((row) => byId.set(row.a, row));
    earliestId = Math.min(...older.map((row) => row.a));
    earliestTime = Math.min(...older.map((row) => row.T));
    pageCount += 1;
  }

  const rows = [...byId.values()].sort((a, b) => a.a - b.a);
  const contiguous = sequencesContiguous(rows);
  const trades = rows.map((row) => mapBinanceAggTrade(market, row, "backfill"));
  const first = trades[0];
  const last = trades.at(-1);
  return {
    trades,
    coverage: {
      source: "binance-aggtrades",
      startTime: first?.exchangeTime,
      endTime: last?.exchangeTime,
      contiguous,
      eventCount: trades.length,
      detail: `${trades.length.toLocaleString()} contiguous aggregate trades loaded across ${pageCount} REST page${pageCount === 1 ? "" : "s"}`,
    },
  };
}

async function loadBinanceMetrics(market: MarketDefinition, signal?: AbortSignal): Promise<MarketMetrics> {
  if (market.binanceProduct === "usdm") {
    const [ticker, premium, openInterest] = await Promise.all([
      fetchBinance<{ lastPrice: string; quoteVolume: string }>(market, `/ticker/24hr?symbol=${market.providerSymbol}`, signal),
      fetchBinance<{ markPrice: string; indexPrice: string; lastFundingRate: string; time: number }>(market, `/premiumIndex?symbol=${market.providerSymbol}`, signal),
      fetchBinance<{ openInterest: string; time: number }>(market, `/openInterest?symbol=${market.providerSymbol}`, signal),
    ]);
    return {
      markPrice: numberOr(premium.markPrice, numberOr(ticker.lastPrice)),
      oraclePrice: numberOr(premium.indexPrice, NaN),
      fundingRate: numberOr(premium.lastFundingRate, NaN),
      openInterest: numberOr(openInterest.openInterest, NaN),
      dayVolume: numberOr(ticker.quoteVolume),
      dayVolumeUnit: "usd-notional",
      timestamp: premium.time || Date.now(),
      quality: "full",
    };
  }
  const ticker = await fetchBinance<{ lastPrice: string; volume: string }>(market, `/ticker/24hr?symbol=${market.providerSymbol}`, signal);
  return {
    markPrice: numberOr(ticker.lastPrice),
    dayVolume: numberOr(ticker.volume),
    dayVolumeUnit: "base",
    timestamp: Date.now(),
    quality: "full",
  };
}

async function loadBinance(market: MarketDefinition, timeframe: Timeframe, signal?: AbortSignal): Promise<Snapshot> {
  const [rows, depth, metrics] = await Promise.all([
    fetchBinance<BinanceKline[]>(market, `/klines?symbol=${market.providerSymbol}&interval=${timeframe}&limit=1000`, signal),
    fetchBinance<BinanceDepthSnapshot>(market, `/depth?symbol=${market.providerSymbol}&limit=1000`, signal),
    loadBinanceMetrics(market, signal),
  ]);
  const candles = rows.map(binanceKline);
  const serverFootprints = collectorConfigured() ? await loadCollectorFootprints(market, timeframe, candles, signal) : undefined;
  const backfill = serverFootprints ? undefined : await loadRecentAggTrades(market, candles, timeframe, signal);
  const local = new BinanceLocalBook();
  local.reset();
  local.applySnapshot(depth);
  return {
    candles,
    trades: backfill?.trades ?? [],
    tradeCoverage: serverFootprints?.coverage ?? backfill?.coverage ?? { source: "none", contiguous: true, eventCount: 0, detail: "No execution history available" },
    footprints: serverFootprints?.footprints,
    book: local.snapshot(Date.now()),
    metrics,
  };
}

interface HlCandle { t: number; T: number; o: string; h: string; l: string; c: string; v: string; n: number; }
interface HlBook { coin: string; time: number; levels: [Array<{ px: string; sz: string; n: number }>, Array<{ px: string; sz: string; n: number }>]; }
interface HlCtx { markPx?: string; oraclePx?: string; funding?: string; openInterest?: string; dayNtlVlm?: string; }
type HlMetaCtx = [{ universe: Array<{ name: string }> }, HlCtx[]];

function mapHlCandle(raw: HlCandle): Candle {
  return { time: raw.t, endTime: raw.T, open: numberOr(raw.o), high: numberOr(raw.h), low: numberOr(raw.l), close: numberOr(raw.c), volume: numberOr(raw.v), trades: raw.n };
}

function mapHlBook(raw: HlBook): OrderBook {
  const side = (levels: Array<{ px: string; sz: string; n: number }>): BookLevel[] => levels.map((level) => ({ price: numberOr(level.px), size: numberOr(level.sz), orders: level.n }));
  return normalizeBook(side(raw.levels[0] ?? []), side(raw.levels[1] ?? []), raw.time || Date.now(), "proxy", 50);
}

function mapHlMetrics(market: MarketDefinition, response: HlMetaCtx): MarketMetrics {
  const [meta, contexts] = response;
  const short = market.providerSymbol.split(":").at(-1) ?? market.providerSymbol;
  const index = meta.universe.findIndex((item) => item.name === market.providerSymbol || item.name === short);
  const ctx = index >= 0 ? contexts[index] : undefined;
  return {
    markPrice: ctx ? numberOr(ctx.markPx, NaN) : undefined,
    oraclePrice: ctx ? numberOr(ctx.oraclePx, NaN) : undefined,
    fundingRate: ctx ? numberOr(ctx.funding, NaN) : undefined,
    openInterest: ctx ? numberOr(ctx.openInterest, NaN) : undefined,
    dayVolume: ctx ? numberOr(ctx.dayNtlVlm, NaN) : undefined,
    dayVolumeUnit: "usd-notional",
    timestamp: Date.now(), quality: "proxy",
  };
}

async function loadHyperliquid(market: MarketDefinition, timeframe: Timeframe, signal?: AbortSignal): Promise<Snapshot> {
  const endTime = Date.now();
  const startTime = endTime - timeframeMs(timeframe) * 1003;
  const [candles, book, contexts] = await Promise.all([
    hyperliquidInfo<HlCandle[]>({ type: "candleSnapshot", req: { coin: market.providerSymbol, interval: timeframe, startTime, endTime } }, signal),
    hyperliquidInfo<HlBook>({ type: "l2Book", coin: market.providerSymbol }, signal),
    hyperliquidInfo<HlMetaCtx>({ type: "metaAndAssetCtxs", dex: "xyz" }, signal),
  ]);
  return {
    candles: candles.map(mapHlCandle).sort((a, b) => a.time - b.time),
    trades: [],
    tradeCoverage: { source: "hyperliquid-live", contiguous: true, eventCount: 0, detail: "Hyperliquid footprint starts from live trades after connection" },
    book: mapHlBook(book),
    metrics: mapHlMetrics(market, contexts),
  };
}

export function loadSnapshot(market: MarketDefinition, timeframe: Timeframe, signal?: AbortSignal): Promise<Snapshot> {
  return market.provider === "Binance" ? loadBinance(market, timeframe, signal) : loadHyperliquid(market, timeframe, signal);
}

function createReconnectLoop(connect: (attempt: number) => WebSocket, handlers: ProviderHandlers): ProviderController {
  let closed = false;
  let socket: WebSocket | null = null;
  let attempt = 0;
  let retry: number | null = null;
  let stable: number | null = null;

  const open = () => {
    if (closed) return;
    handlers.onState(attempt ? "reconnecting" : "connecting", attempt ? `Reconnect attempt ${attempt + 1}` : "Opening real-time stream");
    socket = connect(attempt);
    socket.addEventListener("open", () => {
      handlers.onState("syncing", "Connected; synchronizing market state");
      stable = window.setTimeout(() => { attempt = 0; }, 10_000);
    });
    socket.addEventListener("close", () => {
      if (closed) return;
      if (stable !== null) window.clearTimeout(stable);
      attempt += 1;
      const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5)) + Math.random() * 350;
      handlers.onState("reconnecting", `Stream closed; retrying in ${(delay / 1000).toFixed(1)}s`);
      retry = window.setTimeout(open, delay);
    });
    socket.addEventListener("error", () => handlers.onState("error", "WebSocket transport error"));
  };

  open();
  return { close: () => {
    closed = true;
    if (retry !== null) window.clearTimeout(retry);
    if (stable !== null) window.clearTimeout(stable);
    socket?.close();
    handlers.onState("closed", "Stream closed");
  } };
}

function streamBinance(market: MarketDefinition, timeframe: Timeframe, handlers: ProviderHandlers): ProviderController {
  const local = new BinanceLocalBook();
  let resyncing = false;
  let metricsTimer: number | null = null;
  let controller: ProviderController | null = null;
  let lastTradeSequence: number | undefined;

  const syncSnapshot = async () => {
    if (resyncing) return;
    resyncing = true;
    handlers.onState("syncing", `Synchronizing ${market.venue} local order book`);
    try {
      const snapshot = await fetchBinance<BinanceDepthSnapshot>(market, `/depth?symbol=${market.providerSymbol}&limit=1000`);
      local.applySnapshot(snapshot);
      handlers.onBook(local.snapshot(Date.now()));
      handlers.onState("live", `Synchronized at update ${local.sequence}`);
    } catch (error) {
      handlers.onState("error", error instanceof Error ? error.message : "Order-book synchronization failed");
      window.setTimeout(syncSnapshot, 1000);
    } finally { resyncing = false; }
  };

  controller = createReconnectLoop((attempt) => {
    local.reset();
    const config = binanceApiConfig(market);
    const symbol = market.providerSymbol.toLowerCase();
    const streams = `${symbol}@depth@100ms/${symbol}@aggTrade/${symbol}@kline_${timeframe}`;
    const socket = new WebSocket(`${config.ws[attempt % config.ws.length]}?streams=${streams}`);
    socket.addEventListener("open", () => void syncSnapshot());
    socket.addEventListener("message", (event) => {
      let message: { stream?: string; data?: Record<string, unknown> };
      try { message = JSON.parse(event.data) as typeof message; } catch { return; }
      const data = message.data ?? {};
      const stream = message.stream ?? "";
      if (stream.includes("@depth")) {
        const update: BinanceDepthUpdate = {
          E: numberOr(data.E, Date.now()), U: numberOr(data.U), u: numberOr(data.u), pu: data.pu === undefined ? undefined : numberOr(data.pu),
          b: (data.b as Array<[string, string]>) ?? [], a: (data.a as Array<[string, string]>) ?? [],
        };
        try {
          if (local.syncState === "buffering" || local.syncState === "syncing") local.buffer(update);
          else if (local.applyUpdate(update)) handlers.onBook(local.snapshot(update.E));
        } catch {
          local.reset();
          local.buffer(update);
          void syncSnapshot();
        }
      } else if (stream.includes("@aggTrade")) {
        const sequence = numberOr(data.a);
        const exchangeTime = numberOr(data.T, numberOr(data.E, Date.now()));
        if (lastTradeSequence !== undefined && sequence > lastTradeSequence + 1) {
          handlers.onTradeGap?.(exchangeTime, `Aggregate-trade gap: expected ${lastTradeSequence + 1}, received ${sequence}`);
        }
        if (lastTradeSequence !== undefined && sequence <= lastTradeSequence) return;
        lastTradeSequence = sequence;
        handlers.onTrade(mapBinanceAggTrade(market, {
          a: sequence,
          p: String(data.p ?? "0"),
          q: String(data.q ?? "0"),
          f: numberOr(data.f),
          l: numberOr(data.l),
          T: exchangeTime,
          m: Boolean(data.m),
        }, "live"));
      } else if (stream.includes("@kline_")) {
        const raw = data.k as Record<string, unknown> | undefined;
        if (raw) handlers.onCandle(mapBinanceStreamKline(raw));
      }
    });
    return socket;
  }, handlers);

  const pollMetrics = async () => {
    try { handlers.onMetrics(await loadBinanceMetrics(market)); }
    catch { /* streaming remains usable */ }
  };
  metricsTimer = window.setInterval(() => void pollMetrics(), 15_000);
  void pollMetrics();

  return { close: () => {
    if (metricsTimer !== null) window.clearInterval(metricsTimer);
    controller?.close();
  } };
}

function streamHyperliquid(market: MarketDefinition, timeframe: Timeframe, handlers: ProviderHandlers): ProviderController {
  let heartbeat: number | null = null;
  const controller = createReconnectLoop(() => {
    const socket = new WebSocket(HYPERLIQUID_WS);
    socket.addEventListener("open", () => {
      const subscriptions = [
        { type: "candle", coin: market.providerSymbol, interval: timeframe },
        { type: "l2Book", coin: market.providerSymbol },
        { type: "trades", coin: market.providerSymbol },
        { type: "activeAssetCtx", coin: market.providerSymbol },
      ];
      subscriptions.forEach((subscription) => socket.send(JSON.stringify({ method: "subscribe", subscription })));
      if (heartbeat !== null) window.clearInterval(heartbeat);
      heartbeat = window.setInterval(() => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ method: "ping" })), 25_000);
    });
    socket.addEventListener("message", (event) => {
      let message: { channel?: string; data?: unknown };
      try { message = JSON.parse(event.data) as typeof message; } catch { return; }
      if (message.channel === "subscriptionResponse" || message.channel === "pong") return;
      if (message.channel === "candle") {
        const raw = (Array.isArray(message.data) ? message.data.at(-1) : message.data) as HlCandle | undefined;
        if (raw) handlers.onCandle(mapHlCandle(raw));
      } else if (message.channel === "l2Book") {
        handlers.onBook(mapHlBook(message.data as HlBook));
        handlers.onState("live", "Hyperliquid snapshot stream live");
      } else if (message.channel === "trades") {
        const rows = (Array.isArray(message.data) ? message.data : []) as Array<{ coin: string; side: string; px: string; sz: string; hash: string; time: number; tid: number }>;
        for (const raw of rows) {
          const price = numberOr(raw.px); const size = numberOr(raw.sz);
          handlers.onTrade({
            id: `${raw.time}-${raw.coin}-${raw.tid}`,
            sequence: raw.tid,
            exchangeTime: raw.time,
            receiveTime: Date.now(),
            price,
            size,
            side: raw.side === "B" ? "buy" : "sell",
            notional: price * size,
            source: "live",
          });
        }
      } else if (message.channel === "activeAssetCtx") {
        const raw = message.data as { ctx?: HlCtx };
        const ctx = raw.ctx ?? {};
        handlers.onMetrics({ markPrice: numberOr(ctx.markPx, NaN), oraclePrice: numberOr(ctx.oraclePx, NaN), fundingRate: numberOr(ctx.funding, NaN), openInterest: numberOr(ctx.openInterest, NaN), dayVolume: numberOr(ctx.dayNtlVlm, NaN), dayVolumeUnit: "usd-notional", timestamp: Date.now(), quality: "proxy" });
      }
    });
    return socket;
  }, handlers);
  return { close: () => { if (heartbeat !== null) window.clearInterval(heartbeat); controller.close(); } };
}

export function streamMarket(market: MarketDefinition, timeframe: Timeframe, handlers: ProviderHandlers): ProviderController {
  return market.provider === "Binance" ? streamBinance(market, timeframe, handlers) : streamHyperliquid(market, timeframe, handlers);
}

export const DEFAULT_MARKET = MARKETS.BTC;
