export type SymbolKey = "BTC" | "NQ" | "ES";
export type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
export type ProviderName = "Binance" | "Hyperliquid";

export interface MarketDefinition {
  key: SymbolKey;
  label: string;
  shortLabel: string;
  provider: ProviderName;
  providerSymbol: string;
  description: string;
  priceDecimals: number;
  quantityDecimals: number;
  dex?: string;
}

export interface Candle {
  time: number;
  endTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume?: number;
  sellVolume?: number;
  trades?: number;
}

export interface BookLevel {
  price: number;
  size: number;
  orders?: number;
}

export interface OrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
  time: number;
}

export interface Trade {
  id: string;
  time: number;
  price: number;
  size: number;
  side: "buy" | "sell";
}

export interface MarketMetrics {
  markPrice?: number;
  oraclePrice?: number;
  fundingRate?: number;
  openInterest?: number;
  dayVolume?: number;
}

export interface HistoricalSnapshot {
  candles: Candle[];
  book: OrderBook;
  metrics: MarketMetrics;
}

export interface StreamHandlers {
  onCandle: (candle: Candle) => void;
  onBook: (book: OrderBook) => void;
  onTrades: (trades: Trade[]) => void;
  onMetrics?: (metrics: MarketMetrics) => void;
  onState: (state: "connecting" | "live" | "reconnecting" | "closed", detail?: string) => void;
}

export interface StreamController {
  close: () => void;
}

export const MARKETS: Record<SymbolKey, MarketDefinition> = {
  BTC: {
    key: "BTC",
    label: "BTC / USDT",
    shortLabel: "BTC",
    provider: "Binance",
    providerSymbol: "BTCUSDT",
    description: "Binance BTCUSDT spot · real trades, order book and aggressor volume",
    priceDecimals: 1,
    quantityDecimals: 5,
  },
  NQ: {
    key: "NQ",
    label: "Nasdaq-100 proxy",
    shortLabel: "NQ",
    provider: "Hyperliquid",
    providerSymbol: "xyz:XYZ100",
    dex: "xyz",
    description: "Hyperliquid Trade[XYZ] XYZ100 perpetual proxy · not CME NQ",
    priceDecimals: 1,
    quantityDecimals: 4,
  },
  ES: {
    key: "ES",
    label: "S&P 500 proxy",
    shortLabel: "ES",
    provider: "Hyperliquid",
    providerSymbol: "xyz:SP500",
    dex: "xyz",
    description: "Hyperliquid Trade[XYZ] SP500 perpetual proxy · not CME ES",
    priceDecimals: 2,
    quantityDecimals: 4,
  },
};

export const TIMEFRAMES: Timeframe[] = ["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"];

const BINANCE_REST_HOSTS = [
  "https://api.binance.com/api/v3",
  "https://api1.binance.com/api/v3",
  "https://data-api.binance.vision/api/v3",
];
const BINANCE_WS_HOSTS = [
  "wss://stream.binance.com:9443/stream",
  "wss://stream.binance.com:443/stream",
];
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
const HYPERLIQUID_WS = "wss://api.hyperliquid.xyz/ws";

export function timeframeMs(timeframe: Timeframe): number {
  const unit = timeframe.slice(-1);
  const count = Number(timeframe.slice(0, -1));
  if (unit === "m") return count * 60_000;
  if (unit === "h") return count * 3_600_000;
  return count * 86_400_000;
}

function numberOr(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 12_000): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = init.signal;
  const abortFromExternal = () => controller.abort();
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromExternal);
  }
}

async function fetchBinance<T>(path: string, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (const host of BINANCE_REST_HOSTS) {
    try {
      return await fetchJson<T>(`${host}${path}`, { signal });
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Binance REST request failed");
}

type BinanceKline = [number, string, string, string, string, string, number, string, number, string, string, string];

function mapBinanceKline(row: BinanceKline): Candle {
  const volume = numberOr(row[5]);
  const buyVolume = numberOr(row[9]);
  return {
    time: row[0],
    endTime: row[6],
    open: numberOr(row[1]),
    high: numberOr(row[2]),
    low: numberOr(row[3]),
    close: numberOr(row[4]),
    volume,
    buyVolume,
    sellVolume: Math.max(0, volume - buyVolume),
    trades: row[8],
  };
}

interface BinanceDepth {
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
}

function mapBookSide(levels: Array<[string, string]>, side: "bid" | "ask"): BookLevel[] {
  const merged = new Map<number, number>();
  for (const [rawPrice, rawSize] of levels) {
    const price = numberOr(rawPrice);
    const size = numberOr(rawSize);
    if (!(price > 0) || !(size > 0)) continue;
    merged.set(price, (merged.get(price) ?? 0) + size);
  }
  return Array.from(merged.entries())
    .map(([price, size]) => ({ price, size }))
    .sort((a, b) => side === "bid" ? b.price - a.price : a.price - b.price);
}

async function fetchBinanceCandleHistory(
  market: MarketDefinition,
  timeframe: Timeframe,
  limit: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const target = Math.max(1, Math.min(5000, limit));
  const rows: BinanceKline[] = [];
  let endTime: number | undefined;

  while (rows.length < target) {
    const pageLimit = Math.min(1000, target - rows.length);
    const endTimeQuery = endTime === undefined ? "" : `&endTime=${endTime}`;
    const page = await fetchBinance<BinanceKline[]>(
      `/klines?symbol=${market.providerSymbol}&interval=${timeframe}&limit=${pageLimit}${endTimeQuery}`,
      signal,
    );
    if (page.length === 0) break;
    rows.unshift(...page);
    endTime = page[0][0] - 1;
    if (page.length < pageLimit) break;
  }
  return rows.slice(-target).map(mapBinanceKline);
}

async function loadBinanceSnapshot(
  market: MarketDefinition,
  timeframe: Timeframe,
  limit: number,
  signal?: AbortSignal,
): Promise<HistoricalSnapshot> {
  const [candles, depth, ticker] = await Promise.all([
    fetchBinanceCandleHistory(market, timeframe, limit, signal),
    fetchBinance<BinanceDepth>(`/depth?symbol=${market.providerSymbol}&limit=100`, signal),
    fetchBinance<{ lastPrice: string; volume: string }>(`/ticker/24hr?symbol=${market.providerSymbol}`, signal),
  ]);
  return {
    candles,
    book: {
      bids: mapBookSide(depth.bids, "bid"),
      asks: mapBookSide(depth.asks, "ask"),
      time: Date.now(),
    },
    metrics: { markPrice: numberOr(ticker.lastPrice), dayVolume: numberOr(ticker.volume) },
  };
}

interface HyperliquidCandle {
  t: number;
  T: number;
  s: string;
  i: string;
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  n: number;
}

interface HyperliquidBook {
  coin: string;
  time: number;
  levels: [Array<{ px: string; sz: string; n: number }>, Array<{ px: string; sz: string; n: number }>];
}

interface HyperliquidUniverseItem { name: string }
interface HyperliquidAssetContext {
  markPx?: string;
  oraclePx?: string;
  funding?: string;
  openInterest?: string;
  dayNtlVlm?: string;
}
type HyperliquidMetaAndContexts = [{ universe: HyperliquidUniverseItem[] }, HyperliquidAssetContext[]];

async function hyperliquidInfo<T>(payload: unknown, signal?: AbortSignal): Promise<T> {
  return fetchJson<T>(HYPERLIQUID_INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  }, 15_000);
}

function mapHyperliquidCandle(candle: HyperliquidCandle): Candle {
  return {
    time: candle.t,
    endTime: candle.T,
    open: numberOr(candle.o),
    high: numberOr(candle.h),
    low: numberOr(candle.l),
    close: numberOr(candle.c),
    volume: numberOr(candle.v),
    trades: candle.n,
  };
}

function mapHyperliquidBook(book: HyperliquidBook): OrderBook {
  const mapSide = (levels: Array<{ px: string; sz: string; n: number }>, side: "bid" | "ask"): BookLevel[] =>
    levels
      .map((level) => ({ price: numberOr(level.px), size: numberOr(level.sz), orders: level.n }))
      .filter((level) => level.price > 0 && level.size > 0)
      .sort((a, b) => side === "bid" ? b.price - a.price : a.price - b.price);
  return {
    bids: mapSide(book.levels[0] ?? [], "bid"),
    asks: mapSide(book.levels[1] ?? [], "ask"),
    time: book.time || Date.now(),
  };
}

function findHyperliquidContext(market: MarketDefinition, response: HyperliquidMetaAndContexts): MarketMetrics {
  const [meta, contexts] = response;
  const shortName = market.providerSymbol.split(":").at(-1) ?? market.providerSymbol;
  const index = meta.universe.findIndex((item) => item.name === market.providerSymbol || item.name === shortName);
  const context = index >= 0 ? contexts[index] : undefined;
  return context ? {
    markPrice: optionalNumber(context.markPx),
    oraclePrice: optionalNumber(context.oraclePx),
    fundingRate: optionalNumber(context.funding),
    openInterest: optionalNumber(context.openInterest),
    dayVolume: optionalNumber(context.dayNtlVlm),
  } : {};
}

async function fetchHyperliquidCandleHistory(
  market: MarketDefinition,
  timeframe: Timeframe,
  limit: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const target = Math.max(1, Math.min(5000, limit));
  const interval = timeframeMs(timeframe);
  const rows: HyperliquidCandle[] = [];
  let endTime = Date.now();
  const maxPages = Math.ceil(target / 500) + 2;

  for (let pageNumber = 0; pageNumber < maxPages && rows.length < target; pageNumber += 1) {
    const pageLimit = Math.min(500, target - rows.length);
    const startTime = endTime - interval * (pageLimit + 3);
    const page = await hyperliquidInfo<HyperliquidCandle[]>({
      type: "candleSnapshot",
      req: { coin: market.providerSymbol, interval: timeframe, startTime, endTime },
    }, signal);
    if (page.length === 0) break;
    const sorted = page.slice().sort((a, b) => a.t - b.t);
    rows.unshift(...sorted);
    endTime = sorted[0].t - 1;
  }

  return Array.from(new Map(rows.map((row) => [row.t, row])).values())
    .sort((a, b) => a.t - b.t)
    .slice(-target)
    .map(mapHyperliquidCandle);
}

async function loadHyperliquidSnapshot(
  market: MarketDefinition,
  timeframe: Timeframe,
  limit: number,
  signal?: AbortSignal,
): Promise<HistoricalSnapshot> {
  const [candles, book, contexts] = await Promise.all([
    fetchHyperliquidCandleHistory(market, timeframe, limit, signal),
    hyperliquidInfo<HyperliquidBook>({ type: "l2Book", coin: market.providerSymbol }, signal),
    hyperliquidInfo<HyperliquidMetaAndContexts>({ type: "metaAndAssetCtxs", dex: market.dex ?? "" }, signal),
  ]);
  return { candles, book: mapHyperliquidBook(book), metrics: findHyperliquidContext(market, contexts) };
}

export async function loadMarketSnapshot(
  market: MarketDefinition,
  timeframe: Timeframe,
  limit: number,
  signal?: AbortSignal,
): Promise<HistoricalSnapshot> {
  return market.provider === "Binance"
    ? loadBinanceSnapshot(market, timeframe, limit, signal)
    : loadHyperliquidSnapshot(market, timeframe, limit, signal);
}

function createReconnectingSocket(
  urlFactory: (attempt: number) => string,
  onOpen: (socket: WebSocket) => void,
  onMessage: (event: MessageEvent<string>) => void,
  onState: StreamHandlers["onState"],
): StreamController {
  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let retryTimer: number | null = null;
  let heartbeatTimer: number | null = null;
  let stableTimer: number | null = null;

  const clearTimers = () => {
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
    if (stableTimer !== null) window.clearTimeout(stableTimer);
    retryTimer = heartbeatTimer = stableTimer = null;
  };

  const connect = () => {
    if (closed) return;
    onState(attempt === 0 ? "connecting" : "reconnecting", attempt === 0 ? "opening stream" : `attempt ${attempt + 1}`);
    const url = urlFactory(attempt);
    try {
      socket = new WebSocket(url);
    } catch {
      attempt += 1;
      retryTimer = window.setTimeout(connect, 1000);
      return;
    }

    socket.onopen = () => {
      onState("live", "streaming");
      onOpen(socket as WebSocket);
      stableTimer = window.setTimeout(() => { attempt = 0; }, 10_000);
      heartbeatTimer = window.setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN && url.includes("hyperliquid")) {
          socket.send(JSON.stringify({ method: "ping" }));
        }
      }, 25_000);
    };
    socket.onmessage = onMessage;
    socket.onerror = () => onState("reconnecting", "transport error");
    socket.onclose = () => {
      clearTimers();
      if (closed) {
        onState("closed");
        return;
      }
      attempt += 1;
      const delay = Math.min(15_000, 700 * 2 ** Math.min(attempt, 5));
      onState("reconnecting", `retry in ${Math.max(1, Math.round(delay / 1000))}s`);
      retryTimer = window.setTimeout(connect, delay);
    };
  };

  connect();
  return {
    close: () => {
      closed = true;
      clearTimers();
      socket?.close(1000, "component unmounted");
      socket = null;
    },
  };
}

function streamBinance(market: MarketDefinition, timeframe: Timeframe, handlers: StreamHandlers): StreamController {
  const symbol = market.providerSymbol.toLowerCase();
  const streams = [`${symbol}@kline_${timeframe}`, `${symbol}@aggTrade`, `${symbol}@depth20@100ms`].join("/");

  return createReconnectingSocket(
    (attempt) => `${BINANCE_WS_HOSTS[attempt % BINANCE_WS_HOSTS.length]}?streams=${streams}`,
    () => undefined,
    (event) => {
      try {
        const envelope = JSON.parse(event.data) as { stream?: string; data?: Record<string, unknown> };
        const payload = envelope.data ?? {};
        const eventType = payload.e;
        if (eventType === "kline") {
          const kline = payload.k as Record<string, unknown>;
          const volume = numberOr(kline.v);
          const buyVolume = numberOr(kline.V);
          handlers.onCandle({
            time: numberOr(kline.t),
            endTime: numberOr(kline.T),
            open: numberOr(kline.o),
            high: numberOr(kline.h),
            low: numberOr(kline.l),
            close: numberOr(kline.c),
            volume,
            buyVolume,
            sellVolume: Math.max(0, volume - buyVolume),
            trades: numberOr(kline.n),
          });
        } else if (eventType === "aggTrade") {
          handlers.onTrades([{
            id: String(payload.a ?? `${payload.T}-${payload.p}`),
            time: numberOr(payload.T),
            price: numberOr(payload.p),
            size: numberOr(payload.q),
            side: payload.m ? "sell" : "buy",
          }]);
        } else if (eventType === "depthUpdate" || envelope.stream?.includes("@depth")) {
          handlers.onBook({
            bids: mapBookSide(((payload.b ?? payload.bids) as Array<[string, string]>) ?? [], "bid"),
            asks: mapBookSide(((payload.a ?? payload.asks) as Array<[string, string]>) ?? [], "ask"),
            time: numberOr(payload.E, Date.now()),
          });
        }
      } catch (error) {
        console.warn("Ignored malformed Binance message", error);
      }
    },
    handlers.onState,
  );
}

function streamHyperliquid(market: MarketDefinition, timeframe: Timeframe, handlers: StreamHandlers): StreamController {
  return createReconnectingSocket(
    () => HYPERLIQUID_WS,
    (socket) => {
      const subscriptions = [
        { type: "candle", coin: market.providerSymbol, interval: timeframe },
        { type: "trades", coin: market.providerSymbol },
        { type: "l2Book", coin: market.providerSymbol },
      ];
      subscriptions.forEach((subscription) => socket.send(JSON.stringify({ method: "subscribe", subscription })));
    },
    (event) => {
      try {
        const message = JSON.parse(event.data) as { channel?: string; data?: unknown };
        if (message.channel === "candle") {
          const rows = Array.isArray(message.data) ? message.data : [message.data];
          const latest = rows.at(-1) as HyperliquidCandle | undefined;
          if (latest) handlers.onCandle(mapHyperliquidCandle(latest));
        } else if (message.channel === "trades") {
          const rows = (message.data as Array<Record<string, unknown>>) ?? [];
          handlers.onTrades(rows.map((trade) => ({
            id: `${market.providerSymbol}-${trade.time}-${String(trade.tid ?? `${trade.px}-${trade.sz}`)}`,
            time: numberOr(trade.time),
            price: numberOr(trade.px),
            size: numberOr(trade.sz),
            side: trade.side === "B" ? "buy" : "sell",
          })));
        } else if (message.channel === "l2Book") {
          handlers.onBook(mapHyperliquidBook(message.data as HyperliquidBook));
        }
      } catch (error) {
        console.warn("Ignored malformed Hyperliquid message", error);
      }
    },
    handlers.onState,
  );
}

export function streamMarket(
  market: MarketDefinition,
  timeframe: Timeframe,
  handlers: StreamHandlers,
): StreamController {
  return market.provider === "Binance"
    ? streamBinance(market, timeframe, handlers)
    : streamHyperliquid(market, timeframe, handlers);
}

export function mergeCandle(candles: Candle[], incoming: Candle, maxLength = 2000): Candle[] {
  const next = candles.slice();
  const index = next.findIndex((candle) => candle.time === incoming.time);
  if (index >= 0) next[index] = { ...next[index], ...incoming };
  else {
    next.push(incoming);
    next.sort((a, b) => a.time - b.time);
  }
  return next.slice(-maxLength);
}

export function formatCompact(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}
