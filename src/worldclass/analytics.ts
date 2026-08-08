import { sessionStartUtc } from "./markets";
import type { AnalyticsSnapshot, Candle, DataQuality, LargeTrade, OrderBook, Trade } from "./types";

export function sessionVwap(candles: Candle[], now = Date.now()): number | undefined {
  const start = sessionStartUtc(now);
  let volume = 0;
  let value = 0;
  for (const candle of candles) {
    if (candle.time < start || candle.time > now || candle.volume <= 0) continue;
    const typical = (candle.high + candle.low + candle.close) / 3;
    volume += candle.volume;
    value += typical * candle.volume;
  }
  return volume > 0 ? value / volume : undefined;
}

export function sessionCvd(candles: Candle[], trades: Trade[], now = Date.now()): { value?: number; quality: DataQuality } {
  const start = sessionStartUtc(now);
  const sessionCandles = candles.filter((candle) => candle.time >= start && candle.time <= now);
  const historicalComplete = sessionCandles.length > 0 && sessionCandles.every((candle) => candle.buyVolume !== undefined && candle.sellVolume !== undefined);
  if (historicalComplete) {
    return {
      value: sessionCandles.reduce((sum, candle) => sum + (candle.buyVolume ?? 0) - (candle.sellVolume ?? 0), 0),
      quality: "full",
    };
  }
  const sessionTrades = trades.filter((trade) => trade.exchangeTime >= start && trade.exchangeTime <= now);
  if (!sessionTrades.length) return { quality: "live-only" };
  return {
    value: sessionTrades.reduce((sum, trade) => sum + (trade.side === "buy" ? trade.size : -trade.size), 0),
    quality: "live-only",
  };
}

export function rollingDelta(candles: Candle[], bars = 200): number | undefined {
  let value = 0;
  let used = false;
  for (const candle of candles.slice(-bars)) {
    if (candle.buyVolume === undefined || candle.sellVolume === undefined) continue;
    value += candle.buyVolume - candle.sellVolume;
    used = true;
  }
  return used ? value : undefined;
}

export function depthAnalytics(book: OrderBook | null): Pick<AnalyticsSnapshot, "microprice" | "spread" | "spreadBps" | "weightedImbalance" | "buyPressure"> {
  if (!book || !book.bids.length || !book.asks.length) return {};
  const bestBid = book.bids[0];
  const bestAsk = book.asks[0];
  const spread = bestAsk.price - bestBid.price;
  const mid = (bestAsk.price + bestBid.price) / 2;
  const denominator = bestBid.size + bestAsk.size;
  const microprice = denominator > 0
    ? (bestAsk.price * bestBid.size + bestBid.price * bestAsk.size) / denominator
    : mid;

  const weighted = (levels: typeof book.bids) => levels.slice(0, 20).reduce((sum, level, index) => {
    const distanceWeight = Math.exp(-index / 6);
    return sum + level.size * level.price * distanceWeight;
  }, 0);
  const bid = weighted(book.bids);
  const ask = weighted(book.asks);
  const total = bid + ask;
  const weightedImbalance = total > 0 ? (bid - ask) / total : 0;
  return {
    microprice,
    spread,
    spreadBps: mid > 0 ? spread / mid * 10_000 : undefined,
    weightedImbalance,
    buyPressure: total > 0 ? bid / total : undefined,
  };
}

function quantile(sorted: number[], percentile: number): number {
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

export function detectLargeTrades(
  trades: Trade[],
  absoluteFloor: number,
  percentile = 0.985,
  burstWindowMs = 350,
): { threshold: number; events: LargeTrade[] } {
  const recent = trades.slice(-3000);
  if (!recent.length) return { threshold: absoluteFloor, events: [] };
  const notionals = recent.map((trade) => trade.notional).sort((a, b) => a - b);
  const adaptiveThreshold = recent.length >= 20 ? quantile(notionals, percentile) : 0;
  const threshold = Math.max(absoluteFloor, adaptiveThreshold);
  const mean = notionals.reduce((sum, value) => sum + value, 0) / notionals.length;
  const variance = notionals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, notionals.length - 1);
  const sd = Math.sqrt(variance) || 1;
  const candidates = recent.filter((trade) => trade.notional >= threshold);
  const events: LargeTrade[] = [];

  for (const trade of candidates) {
    const previous = events.at(-1);
    const priceDistanceBps = previous && previous.price > 0 ? Math.abs(trade.price - previous.price) / previous.price * 10_000 : Number.POSITIVE_INFINITY;
    if (previous && previous.side === trade.side && trade.exchangeTime - previous.endTime <= burstWindowMs && priceDistanceBps <= 4) {
      const totalNotional = previous.notional + trade.notional;
      previous.price = (previous.price * previous.notional + trade.price * trade.notional) / totalNotional;
      previous.notional = totalNotional;
      previous.size += trade.size;
      previous.endTime = trade.exchangeTime;
      previous.count += 1;
      previous.zScore = (previous.notional - mean) / sd;
    } else {
      events.push({
        id: `large-${trade.id}`,
        time: trade.exchangeTime,
        endTime: trade.exchangeTime,
        price: trade.price,
        size: trade.size,
        notional: trade.notional,
        side: trade.side,
        count: 1,
        zScore: (trade.notional - mean) / sd,
      });
    }
  }
  return { threshold, events: events.slice(-60).reverse() };
}

export function calculateAnalytics(candles: Candle[], trades: Trade[], book: OrderBook | null, marketQuality: DataQuality): AnalyticsSnapshot {
  const cvd = sessionCvd(candles, trades);
  const large = detectLargeTrades(trades, 50_000);
  return {
    sessionVwap: sessionVwap(candles),
    sessionCvd: cvd.value,
    rollingDelta: rollingDelta(candles),
    largeTradeThreshold: large.threshold,
    dataQuality: marketQuality === "proxy" ? "proxy" : cvd.quality,
    ...depthAnalytics(book),
  };
}
