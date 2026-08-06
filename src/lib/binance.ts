import type { Kline, Timeframe } from "./chartData";

const REST_HOSTS = [
  "https://data-api.binance.vision/api/v3",
  "https://api.binance.com/api/v3",
  "https://api1.binance.com/api/v3",
  "https://api2.binance.com/api/v3",
  "https://api3.binance.com/api/v3",
];

const WS_URL = "wss://stream.binance.com:9443/ws";

const TF_MS: Record<Timeframe, number> = { "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000 };

async function fetchWithFallback(path: string): Promise<unknown> {
  let lastErr: unknown;
  for (const host of REST_HOSTS) {
    try {
      const res = await fetch(`${host}${path}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("all Binance REST hosts failed");
}

/**
 * Fetch OHLCV klines from Binance's public REST API.
 * Taker-buy base volume (column 9) is used to split buy/sell volume,
 * which drives the footprint / order flow rendering.
 */
export async function fetchBinanceKlines(pair: string, timeframe: Timeframe, limit = 160): Promise<Kline[]> {
  const rows = (await fetchWithFallback(
    `/klines?symbol=${pair}&interval=${timeframe}&limit=${limit}`
  )) as unknown[][];
  return rows.map((r) => {
    const buy = Math.round(Number(r[9]));
    const sell = Math.max(0, Math.round(Number(r[5]) - Number(r[9])));
    return {
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      buyVol: buy,
      sellVol: sell,
      openTime: Number(r[0]),
      closeTime: Number(r[6]),
    };
  });
}

/** Fetch the current market price from the REST ticker endpoint. */
export async function fetchBinancePrice(pair: string): Promise<number> {
  const row = (await fetchWithFallback(`/ticker/price?symbol=${pair}`)) as { price: string };
  return Number(row.price);
}

export type LiveKline = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  buyVol: number;
  sellVol: number;
  isClosed: boolean;
};

type WSMessage = Record<string, unknown>;

function subscribeWS(stream: string, onMessage: (msg: WSMessage) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: number | undefined;

  const connect = () => {
    if (closed) return;
    try {
      ws = new WebSocket(`${WS_URL}/${stream}`);
    } catch {
      timer = window.setTimeout(connect, 2000);
      return;
    }
    ws.onopen = () => {
      retry = 0;
    };
    ws.onmessage = (ev) => {
      try {
        onMessage(JSON.parse(ev.data as string) as WSMessage);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (closed) return;
      const delay = Math.min(15000, 500 * 2 ** retry++);
      timer = window.setTimeout(connect, delay);
    };
  };

  connect();
  return () => {
    closed = true;
    if (timer !== undefined) window.clearTimeout(timer);
    ws?.close();
  };
}

/**
 * Live market data for a pair:
 * - the kline stream pushes the in-progress candle (price ticks ~1s)
 * - the trade stream splits buy/sell volume by taker aggressiveness (m)
 * Returns an unsubscribe function; the sockets auto-reconnect on drop.
 */
export function subscribeBinanceLive(
  pair: string,
  timeframe: Timeframe,
  onCandle: (k: LiveKline) => void
): () => void {
  const sym = pair.toLowerCase();
  const tfMs = TF_MS[timeframe];
  const trades = new Map<number, { buy: number; sell: number }>();

  const offKline = subscribeWS(`${sym}@kline_${timeframe}`, (msg) => {
    const k = msg.k as Record<string, unknown> | undefined;
    if (!k || typeof k !== "object") return;
    const openTime = Number(k.t);
    const agg = trades.get(openTime) ?? { buy: 0, sell: 0 };
    onCandle({
      openTime,
      open: Number(k.o),
      high: Number(k.h),
      low: Number(k.l),
      close: Number(k.c),
      buyVol: Math.round(agg.buy),
      sellVol: Math.round(agg.sell),
      isClosed: k.x === true,
    });
    if (k.x === true) trades.delete(openTime);
  });

  const offTrade = subscribeWS(`${sym}@trade`, (msg) => {
    const m = msg as { T?: number; q?: number; m?: boolean };
    const t = Number(m.T);
    const q = Number(m.q);
    if (!Number.isFinite(t) || !Number.isFinite(q)) return;
    const openTime = Math.floor(t / tfMs) * tfMs;
    const agg = trades.get(openTime) ?? { buy: 0, sell: 0 };
    if (m.m === true) agg.sell += q;
    else agg.buy += q;
    trades.set(openTime, agg);
  });

  return () => {
    offKline();
    offTrade();
  };
}
