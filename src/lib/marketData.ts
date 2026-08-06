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
    description: "Bitcoin spot market on Binance",
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
    description: "Trade[XYZ] XYZ100 perpetual on Hyperliquid; not a CME NQ contract",
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
    description: "Trade[XYZ] SP500 perpetual on Hyperliquid; not a CME ES contract",
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

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs = 12_000): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = init.signal;
  const abortFromExternal = () => controller.abort();
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
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

type BinanceKline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];

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
  bids: [string, string][];
  asks: [string, string][];
}

function mapBookSide(levels: Array<[string, string]>): BookLevel[] {
  return levels
    .map(([price, size]) => ({ price: numberOr(price), size: numberOr(size) }))
    .filter((level) => level.price > 0 && level.size > 0);
}

async function loadBinanceSnapshot(
  market: MarketDefinition,
  timeframe: Timeframe,
  limit: number,
  signal?: AbortSignal,
): Promise<HistoricalSnapshot> {
  const [rows, depth, ticker] = await Promise.all([
    fetchBinance<BinanceKline[]>(
      `/klines?symbol=${market.providerSymbol}&interval=${timeframe}&limit=${Math.min(1000, limit)}`,
      signal,
    ),
    fetchBinance<BinanceDepth>(`/depth?symbol=${market.providerSymbol}&limit=20`, signal),
    fetchBinance<{ lastPrice: string; volume: string }>(`/ticker/24hr?symbol=${market.providerSymbol}`, signal),
  ]);
  return {
    candles: rows.map(mapBinanceKline),
    book: { bids: mapBookSide(depth.bids), asks: mapBookSide(depth.asks), time: Date.now() },
    metrics: {
      markPrice: numberOr(ticker.lastPrice),
      dayVolume: numberOr(ticker.volume),
    },
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

interface HyperliquidUniverseItem {
  name: string;
}

interface HyperliquidAssetContext {
  markPx?: string;
  oraclePx?: string;
  funding?: string;
  openInterest?: string;
  dayNtlVlm?: string;
}

type HyperliquidMetaAndContexts = [{ universe: HyperliquidUniverseItem[] }, HyperliquidAssetContext[]];

async function hyperliquidInfo<T>(payload: unknown, signal?: AbortSignal): Promise<T> {
  return fetchJson<T>(
    HYPERLIQUID_INFO,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    },
    15_000,
  );
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
  const mapSide = (levels: Array<{ px: string; sz: string; n: number }>): BookLevel[] =>
    levels
      .map((level) => ({ price: numberOr(level.px), size: numberOr(level.sz), orders: level.n }))
      .filter((level) => level.price > 0 && level.size > 0);
  return {
    bids: mapSide(book.levels[0]),
    asks: mapSide(book.levels[1]),
    time: book.time,
  };
}

function findHyperliquidContext(
  market: MarketDefinition,
  response: HyperliquidMetaAndContexts,
): MarketMetrics {
  const [meta, contexts] = response;
  const shortName = market.providerSymbol.split(":").at(-1) ?? market.providerSymbol;
  const index = meta.universe.findIndex(
    (item) => item.name === market.providerSymbol || item.name === shortName,
  );
  const context = index >= 0 ? contexts[index] : undefined;
  return context
    ? {
        markPrice: optionalNumber(context.markPx),
        oraclePrice: optionalNumber(context.oraclePx),
        fundingRate: optionalNumber(context.funding),
        openInterest: optionalNumber(context.openInterest),
        dayVolume: optionalNumber(context.dayNtlVlm),
      }
    : {};
}

async function loadHyperliquidSnapshot(
  market: MarketDefinition,
  timeframe: Timeframe,
  limit: number,
  signal?: AbortSignal,
): Promise<HistoricalSnapshot> {
  const endTime = Date.now();
  const startTime = endTime - timeframeMs(timeframe) * Math.min(5000, limit + 20);
  const [candles, book, contexts] = await Promise.all([
    hyperliquidInfo<HyperliquidCandle[]>(
      {
        type: "candleSnapshot",
        req: { coin: market.providerSymbol, interval: timeframe, startTime, endTime },
      },
      signal,
    ),
    hyperliquidInfo<HyperliquidBook>({ type: "l2Book", coin: market.providerSymbol }, signal),
    hyperliquidInfo<HyperliquidMetaAndContexts>(
      { type: "metaAndAssetCtxs", dex: market.dex ?? "" },
      signal,
    ),
  ]);
  return {
    candles: candles.slice(-limit).map(mapHyperliquidCandle),
    book: mapHyperliquidBook(book),
    metrics: findHyperliquidContext(market, contexts),
  };
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

  const clearTimers = () => {
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
    retryTimer = null;
    heartbeatTimer = null;
  };

  const connect = () => {
    if (closed) return;
    onState(attempt === 0 ? "connecting" : "reconnecting");
    const url = urlFactory(attempt);
    socket = new WebSocket(url);
    socket.onopen = () => {
      attempt = 0;
      onState("live");
      onOpen(socket as WebSocket);
      heartbeatTimer = window.setInterval(() => {
        if (socket?.readyState === WebSocket.OPEN && url.includes("hyperliquid")) {
          socket.send(JSON.stringify({ method: "ping" }));
        }
      }, 25_000);
    };
    socket.onmessage = onMessage;
    socket.onerror = () => {
      onState("reconnecting", "WebSocket transport error");
    };
    socket.onclose = () => {
      clearTimers();
      if (closed) {
        onState("closed");
        return;
      }
      attempt += 1;
      const delay = Math.min(15_000, 800 * 2 ** Math.min(attempt, 5));
      onState("reconnecting", `retrying in ${Math.round(delay / 1000)}s`);
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

function streamBinance(
  market: MarketDefinition,
  timeframe: Timeframe,
  handlers: StreamHandlers,
): StreamController {
  const symbol = market.providerSymbol.toLowerCase();
  const streams = [
    `${symbol}@kline_${timeframe}`,
    `${symbol}@trade`,
    `${symbol}@depth20@100ms`,
  ].join("/");

  return createReconnectingSocket(
    (attempt) => `${BINANCE_WS_HOSTS[attempt % BINANCE_WS_HOSTS.length]}?streams=${streams}`,
    () => undefined,
    (event) => {
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
      } else if (eventType === "trade") {
        handlers.onTrades([
          {
            id: String(payload.t ?? `${payload.T}-${payload.p}`),
            time: numberOr(payload.T),
            price: numberOr(payload.p),
            size: numberOr(payload.q),
            side: payload.m ? "sell" : "buy",
          },
        ]);
      } else if (eventType === "depthUpdate") {
        handlers.onBook({
          bids: mapBookSide((payload.b as [string, string][]) ?? []),
          asks: mapBookSide((payload.a as [string, string][]) ?? []),
          time: numberOr(payload.E, Date.now()),
        });
      }
    },
    handlers.onState,
  );
}

function streamHyperliquid(
  market: MarketDefinition,
  timeframe: Timeframe,
  handlers: StreamHandlers,
): StreamController {
  return createReconnectingSocket(
    () => HYPERLIQUID_WS,
    (socket) => {
      const subscriptions = [
        { type: "candle", coin: market.providerSymbol, interval: timeframe },
        { type: "trades", coin: market.providerSymbol },
        { type: "l2Book", coin: market.providerSymbol },
      ];
      subscriptions.forEach((subscription) => {
        socket.send(JSON.stringify({ method: "subscribe", subscription }));
      });
    },
    (event) => {
      const message = JSON.parse(event.data) as { channel?: string; data?: unknown };
      if (message.channel === "candle") {
        handlers.onCandle(mapHyperliquidCandle(message.data as HyperliquidCandle));
      } else if (message.channel === "trades") {
        const rows = (message.data as Array<Record<string, unknown>>) ?? [];
        handlers.onTrades(
          rows.map((trade) => ({
            id: String(trade.tid ?? `${trade.time}-${trade.px}-${trade.sz}`),
            time: numberOr(trade.time),
            price: numberOr(trade.px),
            size: numberOr(trade.sz),
            side: trade.side === "B" ? "buy" : "sell",
          })),
        );
      } else if (message.channel === "l2Book") {
        handlers.onBook(mapHyperliquidBook(message.data as HyperliquidBook));
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

export function mergeCandle(candles: Candle[], incoming: Candle, maxLength = 1500): Candle[] {
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
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}
