import { candleStart, timeframeMs } from "./markets";
import type {
  Candle,
  FootprintCandle,
  FootprintCoverage,
  FootprintQuality,
  FootprintRow,
  MarketDefinition,
  Timeframe,
  Trade,
} from "./types";

export interface TradeCoverageInput {
  source: FootprintCoverage["source"];
  startTime?: number;
  endTime?: number;
  contiguous: boolean;
  eventCount: number;
  detail?: string;
}

interface MutableRow {
  price: number;
  bidVolume: number;
  askVolume: number;
  bidTrades: number;
  askTrades: number;
}

interface MutableCandle {
  candle: Candle;
  rows: Map<number, MutableRow>;
}

function precise(value: number): number {
  return Number(value.toPrecision(12));
}

function priceBucket(price: number, step: number): number {
  return precise(Math.round(price / step) * step);
}

function valueArea(rows: FootprintRow[], target = 0.7): { low?: number; high?: number } {
  const total = rows.reduce((sum, row) => sum + row.totalVolume, 0);
  if (total <= 0) return {};
  const selected: FootprintRow[] = [];
  let running = 0;
  for (const row of [...rows].sort((a, b) => b.totalVolume - a.totalVolume)) {
    selected.push(row);
    running += row.totalVolume;
    if (running / total >= target) break;
  }
  return {
    low: Math.min(...selected.map((row) => row.price)),
    high: Math.max(...selected.map((row) => row.price)),
  };
}

function markImbalances(rows: FootprintRow[], step: number, ratio: number, minVolume: number): void {
  const byPrice = new Map(rows.map((row) => [precise(row.price), row]));
  for (const row of rows) {
    const lower = byPrice.get(precise(row.price - step));
    const upper = byPrice.get(precise(row.price + step));
    row.askImbalance = row.askVolume >= minVolume && row.askVolume >= Math.max(minVolume, (lower?.bidVolume ?? 0) * ratio);
    row.bidImbalance = row.bidVolume >= minVolume && row.bidVolume >= Math.max(minVolume, (upper?.askVolume ?? 0) * ratio);
  }

  const ascending = [...rows].sort((a, b) => a.price - b.price);
  const markStack = (key: "askImbalance" | "bidImbalance", target: "stackedAsk" | "stackedBid") => {
    let run: FootprintRow[] = [];
    const flush = () => {
      if (run.length >= 3) run.forEach((row) => { row[target] = true; });
      run = [];
    };
    for (let index = 0; index < ascending.length; index += 1) {
      const row = ascending[index];
      const previous = ascending[index - 1];
      const adjacent = !previous || Math.abs(row.price - previous.price - step) < step * 0.001;
      if (row[key] && adjacent) run.push(row);
      else { flush(); if (row[key]) run.push(row); }
    }
    flush();
  };
  markStack("askImbalance", "stackedAsk");
  markStack("bidImbalance", "stackedBid");
}

function deriveRows(input: Iterable<MutableRow>, step: number, ratio: number, minVolume: number): FootprintRow[] {
  const rows: FootprintRow[] = [...input].map((row) => ({
    price: row.price,
    bidVolume: row.bidVolume,
    askVolume: row.askVolume,
    totalVolume: row.bidVolume + row.askVolume,
    delta: row.askVolume - row.bidVolume,
    tradeCount: row.bidTrades + row.askTrades,
    bidTrades: row.bidTrades,
    askTrades: row.askTrades,
    bidImbalance: false,
    askImbalance: false,
    stackedBid: false,
    stackedAsk: false,
    inValueArea: false,
  })).sort((a, b) => b.price - a.price);

  markImbalances(rows, step, ratio, minVolume);
  const area = valueArea(rows);
  for (const row of rows) {
    row.inValueArea = area.low !== undefined && area.high !== undefined && row.price >= area.low && row.price <= area.high;
  }
  return rows;
}

function summarize(
  candle: Candle,
  rows: FootprintRow[],
  priceStep: number,
  quality: FootprintQuality,
): FootprintCandle {
  const totalBidVolume = rows.reduce((sum, row) => sum + row.bidVolume, 0);
  const totalAskVolume = rows.reduce((sum, row) => sum + row.askVolume, 0);
  const totalVolume = totalBidVolume + totalAskVolume;
  const area = valueArea(rows);
  const poc = rows.reduce<FootprintRow | undefined>((best, row) => !best || row.totalVolume > best.totalVolume ? row : best, undefined);
  const deltas = rows.map((row) => row.delta);
  return {
    time: candle.time,
    endTime: candle.endTime,
    rows,
    totalBidVolume,
    totalAskVolume,
    totalVolume,
    delta: totalAskVolume - totalBidVolume,
    maxDelta: deltas.length ? Math.max(...deltas) : 0,
    minDelta: deltas.length ? Math.min(...deltas) : 0,
    tradeCount: rows.reduce((sum, row) => sum + row.tradeCount, 0),
    pocPrice: poc?.price,
    valueAreaHigh: area.high,
    valueAreaLow: area.low,
    coverageRatio: candle.volume > 0 ? totalVolume / candle.volume : undefined,
    quality,
    priceStep,
  };
}

function aggregateRows(rows: FootprintRow[], step: number): MutableRow[] {
  const map = new Map<number, MutableRow>();
  for (const row of rows) {
    const price = priceBucket(row.price, step);
    const current = map.get(price) ?? { price, bidVolume: 0, askVolume: 0, bidTrades: 0, askTrades: 0 };
    current.bidVolume += row.bidVolume;
    current.askVolume += row.askVolume;
    current.bidTrades += row.bidTrades;
    current.askTrades += row.askTrades;
    map.set(price, current);
  }
  return [...map.values()];
}

export function regroupFootprint(
  footprint: FootprintCandle,
  candle: Candle,
  step: number,
  imbalanceRatio: number,
  minVolume: number,
): FootprintCandle {
  if (!footprint.rows.length || Math.abs(footprint.priceStep - step) < Number.EPSILON) return footprint;
  return summarize(candle, deriveRows(aggregateRows(footprint.rows, step), step, imbalanceRatio, minVolume), step, footprint.quality);
}

export class FootprintAccumulator {
  private readonly candles = new Map<number, MutableCandle>();
  private coverage: FootprintCoverage;
  private gappedAt?: number;
  private latestTradeTime = 0;
  private captureStart = Date.now();

  constructor(
    private readonly market: MarketDefinition,
    private readonly timeframe: Timeframe,
  ) {
    this.coverage = {
      quality: "aggregate-only",
      source: market.provider === "Binance" ? "binance-aggtrades" : "hyperliquid-live",
      contiguous: true,
      eventCount: 0,
      detail: "No price-level trade history loaded",
    };
  }

  reset(candles: Candle[], trades: Trade[] = [], input?: TradeCoverageInput, captureStart = Date.now()): void {
    this.candles.clear();
    this.captureStart = captureStart;
    this.gappedAt = undefined;
    this.latestTradeTime = 0;
    for (const candle of candles) this.upsertCandle(candle);
    this.coverage = {
      quality: trades.length ? "live-partial" : "aggregate-only",
      source: input?.source ?? (this.market.provider === "Binance" ? "binance-aggtrades" : "hyperliquid-live"),
      startTime: input?.startTime,
      endTime: input?.endTime,
      contiguous: input?.contiguous ?? true,
      eventCount: input?.eventCount ?? trades.length,
      detail: input?.detail ?? (trades.length ? "Price-level trades loaded" : "Aggregate candles only"),
    };
    for (const trade of trades) this.ingestTrade(trade, false);
    if (this.coverage.startTime === undefined && trades.length) this.coverage.startTime = trades[0].exchangeTime;
    if (this.coverage.endTime === undefined && trades.length) this.coverage.endTime = trades.at(-1)?.exchangeTime;
  }

  upsertCandle(candle: Candle): void {
    const existing = this.candles.get(candle.time);
    if (existing) existing.candle = candle;
    else this.candles.set(candle.time, { candle, rows: new Map() });
    const keepAfter = candle.time - timeframeMs(this.timeframe) * 5000;
    for (const time of this.candles.keys()) if (time < keepAfter) this.candles.delete(time);
  }

  ingestTrade(trade: Trade, countEvent = true): void {
    const time = candleStart(trade.exchangeTime, this.timeframe);
    let bucket = this.candles.get(time);
    if (!bucket) {
      const interval = timeframeMs(this.timeframe);
      const candle: Candle = {
        time,
        endTime: time + interval - 1,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: 0,
      };
      bucket = { candle, rows: new Map() };
      this.candles.set(time, bucket);
    }
    const step = this.market.tickSize;
    const price = priceBucket(trade.price, step);
    const row = bucket.rows.get(price) ?? { price, bidVolume: 0, askVolume: 0, bidTrades: 0, askTrades: 0 };
    if (trade.side === "buy") { row.askVolume += trade.size; row.askTrades += 1; }
    else { row.bidVolume += trade.size; row.bidTrades += 1; }
    bucket.rows.set(price, row);
    this.latestTradeTime = Math.max(this.latestTradeTime, trade.exchangeTime);
    this.coverage.endTime = Math.max(this.coverage.endTime ?? 0, trade.exchangeTime);
    if (this.coverage.startTime === undefined) this.coverage.startTime = trade.exchangeTime;
    if (countEvent) this.coverage.eventCount += 1;
  }

  markGap(exchangeTime: number, detail = "Aggregate-trade sequence gap detected"): void {
    this.gappedAt = this.gappedAt === undefined ? exchangeTime : Math.min(this.gappedAt, exchangeTime);
    this.coverage.gappedAt = this.gappedAt;
    this.coverage.contiguous = false;
    this.coverage.quality = "gapped";
    this.coverage.detail = detail;
  }

  snapshot(now = Date.now(), replay = false): { footprints: FootprintCandle[]; coverage: FootprintCoverage } {
    const footprints = [...this.candles.values()]
      .sort((a, b) => a.candle.time - b.candle.time)
      .map(({ candle, rows }) => {
        const derived = deriveRows(rows.values(), this.market.tickSize, this.market.footprintImbalanceRatio, this.market.footprintMinVolume);
        const quality = this.qualityFor(candle, derived, now, replay);
        return summarize(candle, derived, this.market.tickSize, quality);
      });
    const qualities = footprints.slice(-20).map((item) => item.quality);
    const quality: FootprintQuality = qualities.includes("gapped") ? "gapped"
      : qualities.includes("live-partial") ? "live-partial"
        : qualities.some((item) => item === "full" || item === "replay-full") ? (replay ? "replay-full" : "full")
          : "aggregate-only";
    return {
      footprints,
      coverage: {
        ...this.coverage,
        quality,
        endTime: Math.max(this.coverage.endTime ?? 0, this.latestTradeTime) || this.coverage.endTime,
        detail: quality === "full" ? "Contiguous Binance aggregate trades reconcile to closed candles"
          : quality === "replay-full" ? "Deterministic footprint rebuilt from replay events"
            : quality === "live-partial" ? "Current or first observed candle is partial"
              : quality === "gapped" ? this.coverage.detail
                : "Historical candles lack price-level executions",
      },
    };
  }

  private qualityFor(candle: Candle, rows: FootprintRow[], now: number, replay: boolean): FootprintQuality {
    if (this.gappedAt !== undefined && candle.endTime >= this.gappedAt) return "gapped";
    if (!rows.length) return "aggregate-only";
    if (replay) return "replay-full";
    const coverageStart = this.coverage.startTime;
    const coverageEnd = Math.max(this.coverage.endTime ?? 0, this.latestTradeTime);
    if (!this.coverage.contiguous) return "gapped";
    if (coverageStart === undefined || coverageStart > candle.time) return "live-partial";
    if (candle.time < this.captureStart && coverageStart > candle.time) return "live-partial";
    if (coverageEnd < candle.endTime || candle.endTime >= now - 1500) return "live-partial";
    const total = rows.reduce((sum, row) => sum + row.totalVolume, 0);
    const ratio = candle.volume > 0 ? total / candle.volume : 1;
    if (ratio < 0.97 || ratio > 1.03) return "gapped";
    return "full";
  }
}

export function buildFootprints(
  market: MarketDefinition,
  timeframe: Timeframe,
  candles: Candle[],
  trades: Trade[],
  input?: TradeCoverageInput,
  now = Date.now(),
  replay = false,
): { footprints: FootprintCandle[]; coverage: FootprintCoverage } {
  const accumulator = new FootprintAccumulator(market, timeframe);
  accumulator.reset(candles, trades, input, input?.startTime ?? now);
  return accumulator.snapshot(now, replay);
}
