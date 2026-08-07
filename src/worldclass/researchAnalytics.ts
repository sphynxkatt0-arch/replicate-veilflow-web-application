import type { Candle, FootprintCandle, FootprintRow, OrderBook, Trade } from "./types";

export interface AuctionSignals {
  zeroPrints: number[];
  unfinishedHigh: boolean;
  unfinishedLow: boolean;
  absorption: Array<{ price: number; side: "buy" | "sell"; volume: number; delta: number }>;
  exhaustion: Array<{ price: number; side: "buy" | "sell"; volume: number }>;
  trapped: Array<{ price: number; side: "buyers" | "sellers"; score: number }>;
}

export interface ProfileNode {
  price: number;
  volume: number;
  delta: number;
  share: number;
  kind: "HVN" | "LVN" | "NORMAL";
}

export interface SessionProfile {
  rows: ProfileNode[];
  poc?: number;
  valueAreaHigh?: number;
  valueAreaLow?: number;
  totalVolume: number;
  totalDelta: number;
}

export interface OpeningRange {
  start?: number;
  end?: number;
  high?: number;
  low?: number;
  midpoint?: number;
  width?: number;
  complete: boolean;
}

export interface VolatilityRegime {
  atr?: number;
  realizedVolatility?: number;
  percentile?: number;
  regime: "UNAVAILABLE" | "LOW" | "NORMAL" | "HIGH" | "EXTREME";
}

export interface LiquidityRegime {
  spread?: number;
  spreadBps?: number;
  topDepth?: number;
  imbalance?: number;
  regime: "UNAVAILABLE" | "THIN" | "NORMAL" | "DEEP" | "DISLOCATED";
}

export interface SpotPerpetualAnalytics {
  basis?: number;
  basisBps?: number;
  deltaDivergence?: number;
  relativeDeltaDivergence?: number;
  fundingRate?: number;
  openInterestChange?: number;
  regime: "UNAVAILABLE" | "SPOT-LED" | "PERP-LED" | "ALIGNED" | "CROWDED-LONG" | "CROWDED-SHORT";
}

export interface LiquidationCluster {
  startTime: number;
  endTime: number;
  side: "buy" | "sell";
  priceLow: number;
  priceHigh: number;
  notional: number;
  count: number;
}

function quantile(values: number[], q: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * Math.max(0, Math.min(1, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function valueArea(rows: Array<{ price: number; volume: number }>, target = 0.7): { high?: number; low?: number } {
  const total = rows.reduce((sum, row) => sum + row.volume, 0);
  if (total <= 0) return {};
  const selected: Array<{ price: number; volume: number }> = [];
  let accumulated = 0;
  for (const row of [...rows].sort((a, b) => b.volume - a.volume || b.price - a.price)) {
    selected.push(row);
    accumulated += row.volume;
    if (accumulated / total >= target) break;
  }
  return { high: Math.max(...selected.map((row) => row.price)), low: Math.min(...selected.map((row) => row.price)) };
}

export function deriveAuctionSignals(footprint: FootprintCandle, minimumVolume = 0.000001): AuctionSignals {
  const ascending = [...footprint.rows].sort((a, b) => a.price - b.price);
  const low = ascending[0];
  const high = ascending.at(-1);
  const zeroPrints = ascending.filter((row) => row.bidVolume === 0 || row.askVolume === 0).map((row) => row.price);
  const volumeThreshold = quantile(ascending.map((row) => row.totalVolume), 0.8) ?? Number.POSITIVE_INFINITY;
  const absorption = ascending.filter((row) => row.totalVolume >= volumeThreshold && Math.abs(row.delta) <= row.totalVolume * 0.2).map((row) => ({
    price: row.price,
    side: row.askVolume >= row.bidVolume ? "sell" as const : "buy" as const,
    volume: row.totalVolume,
    delta: row.delta,
  }));
  const exhaustion = ascending.filter((row) => row.totalVolume <= (quantile(ascending.map((item) => item.totalVolume), 0.2) ?? 0) && row.totalVolume > minimumVolume).map((row) => ({
    price: row.price,
    side: row.delta >= 0 ? "buy" as const : "sell" as const,
    volume: row.totalVolume,
  }));
  const trapped = ascending.filter((row) => row.stackedAsk || row.stackedBid).map((row) => ({
    price: row.price,
    side: row.stackedAsk ? "buyers" as const : "sellers" as const,
    score: Math.abs(row.delta) / Math.max(minimumVolume, row.totalVolume),
  }));
  return {
    zeroPrints,
    unfinishedHigh: Boolean(high && high.bidVolume > minimumVolume && high.askVolume > minimumVolume),
    unfinishedLow: Boolean(low && low.bidVolume > minimumVolume && low.askVolume > minimumVolume),
    absorption,
    exhaustion,
    trapped,
  };
}

export function buildSessionProfile(footprints: readonly FootprintCandle[]): SessionProfile {
  const byPrice = new Map<number, { price: number; volume: number; delta: number }>();
  for (const footprint of footprints) {
    for (const row of footprint.rows) {
      const current = byPrice.get(row.price) ?? { price: row.price, volume: 0, delta: 0 };
      current.volume += row.totalVolume;
      current.delta += row.delta;
      byPrice.set(row.price, current);
    }
  }
  const aggregate = [...byPrice.values()].sort((a, b) => b.price - a.price);
  const totalVolume = aggregate.reduce((sum, row) => sum + row.volume, 0);
  const highThreshold = quantile(aggregate.map((row) => row.volume), 0.8) ?? Number.POSITIVE_INFINITY;
  const lowThreshold = quantile(aggregate.map((row) => row.volume), 0.2) ?? Number.NEGATIVE_INFINITY;
  const area = valueArea(aggregate);
  const poc = aggregate.reduce<typeof aggregate[number] | undefined>((best, row) => !best || row.volume > best.volume || (row.volume === best.volume && row.price > best.price) ? row : best, undefined);
  return {
    rows: aggregate.map((row) => ({
      ...row,
      share: totalVolume > 0 ? row.volume / totalVolume : 0,
      kind: row.volume >= highThreshold ? "HVN" : row.volume <= lowThreshold ? "LVN" : "NORMAL",
    })),
    poc: poc?.price,
    valueAreaHigh: area.high,
    valueAreaLow: area.low,
    totalVolume,
    totalDelta: aggregate.reduce((sum, row) => sum + row.delta, 0),
  };
}

export function calculateOpeningRange(candles: readonly Candle[], minutes = 30): OpeningRange {
  if (!candles.length) return { complete: false };
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const start = sorted[0].time;
  const end = start + minutes * 60_000;
  const included = sorted.filter((candle) => candle.time < end);
  if (!included.length) return { start, end, complete: false };
  const high = Math.max(...included.map((candle) => candle.high));
  const low = Math.min(...included.map((candle) => candle.low));
  return { start, end, high, low, midpoint: (high + low) / 2, width: high - low, complete: (included.at(-1)?.endTime ?? 0) >= end - 1 };
}

function trueRanges(candles: readonly Candle[]): number[] {
  return candles.slice(1).map((candle, index) => {
    const previous = candles[index];
    return Math.max(candle.high - candle.low, Math.abs(candle.high - previous.close), Math.abs(candle.low - previous.close));
  });
}

export function calculateVolatilityRegime(candles: readonly Candle[], lookback = 20): VolatilityRegime {
  if (candles.length < Math.max(3, lookback + 1)) return { regime: "UNAVAILABLE" };
  const ranges = trueRanges(candles);
  const recent = ranges.slice(-lookback);
  const atr = recent.reduce((sum, value) => sum + value, 0) / recent.length;
  const returns = candles.slice(1).map((candle, index) => Math.log(candle.close / candles[index].close)).filter(Number.isFinite);
  const recentReturns = returns.slice(-lookback);
  const mean = recentReturns.reduce((sum, value) => sum + value, 0) / recentReturns.length;
  const realizedVolatility = Math.sqrt(recentReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / recentReturns.length);
  const history = ranges.map((_, index) => {
    const window = ranges.slice(Math.max(0, index - lookback + 1), index + 1);
    return window.reduce((sum, value) => sum + value, 0) / window.length;
  });
  const percentile = history.filter((value) => value <= atr).length / history.length;
  const regime = percentile >= 0.95 ? "EXTREME" : percentile >= 0.75 ? "HIGH" : percentile <= 0.25 ? "LOW" : "NORMAL";
  return { atr, realizedVolatility, percentile, regime };
}

export function calculateLiquidityRegime(book: OrderBook | null, depth = 10): LiquidityRegime {
  const bestBid = book?.bids[0]; const bestAsk = book?.asks[0];
  if (!bestBid || !bestAsk || bestBid.price >= bestAsk.price) return { regime: book ? "DISLOCATED" : "UNAVAILABLE" };
  const spread = bestAsk.price - bestBid.price;
  const midpoint = (bestAsk.price + bestBid.price) / 2;
  const spreadBps = spread / midpoint * 10_000;
  const bidDepth = book.bids.slice(0, depth).reduce((sum, row) => sum + row.size, 0);
  const askDepth = book.asks.slice(0, depth).reduce((sum, row) => sum + row.size, 0);
  const topDepth = bidDepth + askDepth;
  const imbalance = topDepth > 0 ? (bidDepth - askDepth) / topDepth : 0;
  const regime = spreadBps > 10 ? "DISLOCATED" : topDepth <= 0 ? "THIN" : spreadBps < 1 && topDepth > (bestBid.size + bestAsk.size) * 5 ? "DEEP" : "NORMAL";
  return { spread, spreadBps, topDepth, imbalance, regime };
}

export function calculateSpotPerpetual(
  spotPrice: number | undefined,
  perpetualPrice: number | undefined,
  spotDelta: number | undefined,
  perpetualDelta: number | undefined,
  fundingRate?: number,
  openInterestChange?: number,
): SpotPerpetualAnalytics {
  if (!spotPrice || !perpetualPrice || spotDelta === undefined || perpetualDelta === undefined) return { regime: "UNAVAILABLE", fundingRate, openInterestChange };
  const basis = perpetualPrice - spotPrice;
  const basisBps = basis / spotPrice * 10_000;
  const deltaDivergence = perpetualDelta - spotDelta;
  const relativeDeltaDivergence = deltaDivergence / Math.max(1, Math.abs(perpetualDelta) + Math.abs(spotDelta));
  let regime: SpotPerpetualAnalytics["regime"] = Math.sign(spotDelta) === Math.sign(perpetualDelta) ? "ALIGNED" : Math.abs(spotDelta) > Math.abs(perpetualDelta) ? "SPOT-LED" : "PERP-LED";
  if ((fundingRate ?? 0) > 0.0005 && (openInterestChange ?? 0) > 0 && perpetualDelta > 0) regime = "CROWDED-LONG";
  if ((fundingRate ?? 0) < -0.0005 && (openInterestChange ?? 0) > 0 && perpetualDelta < 0) regime = "CROWDED-SHORT";
  return { basis, basisBps, deltaDivergence, relativeDeltaDivergence, fundingRate, openInterestChange, regime };
}

export function clusterLiquidations(trades: readonly Trade[], windowMs = 5_000, priceBandBps = 10): LiquidationCluster[] {
  const sorted = [...trades].sort((a, b) => a.exchangeTime - b.exchangeTime);
  const clusters: LiquidationCluster[] = [];
  for (const trade of sorted) {
    const latest = clusters.at(-1);
    const priceWithinBand = latest && trade.price >= latest.priceLow * (1 - priceBandBps / 10_000) && trade.price <= latest.priceHigh * (1 + priceBandBps / 10_000);
    if (latest && latest.side === trade.side && trade.exchangeTime - latest.endTime <= windowMs && priceWithinBand) {
      latest.endTime = trade.exchangeTime;
      latest.priceLow = Math.min(latest.priceLow, trade.price);
      latest.priceHigh = Math.max(latest.priceHigh, trade.price);
      latest.notional += trade.notional;
      latest.count += 1;
    } else {
      clusters.push({ startTime: trade.exchangeTime, endTime: trade.exchangeTime, side: trade.side, priceLow: trade.price, priceHigh: trade.price, notional: trade.notional, count: 1 });
    }
  }
  return clusters;
}

export function aggregateTradesToFootprints(
  trades: readonly Trade[],
  timeframeMs: number,
  tickSize: number,
): Array<{ time: number; rows: Array<Pick<FootprintRow, "price" | "bidVolume" | "askVolume" | "totalVolume" | "delta">>; totalVolume: number; delta: number }> {
  const candles = new Map<number, Map<number, { price: number; bidVolume: number; askVolume: number }>>();
  for (const trade of trades) {
    const time = Math.floor(trade.exchangeTime / timeframeMs) * timeframeMs;
    const price = Number((Math.round(trade.price / tickSize) * tickSize).toPrecision(12));
    const rows = candles.get(time) ?? new Map();
    const row = rows.get(price) ?? { price, bidVolume: 0, askVolume: 0 };
    if (trade.side === "buy") row.askVolume += trade.size; else row.bidVolume += trade.size;
    rows.set(price, row); candles.set(time, rows);
  }
  return [...candles].sort(([left], [right]) => left - right).map(([time, rows]) => {
    const output = [...rows.values()].sort((a, b) => b.price - a.price).map((row) => ({ ...row, totalVolume: row.bidVolume + row.askVolume, delta: row.askVolume - row.bidVolume }));
    return { time, rows: output, totalVolume: output.reduce((sum, row) => sum + row.totalVolume, 0), delta: output.reduce((sum, row) => sum + row.delta, 0) };
  });
}
