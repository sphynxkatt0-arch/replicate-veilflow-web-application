import type { BookLevel, MarketDefinition, OrderBook, Trade } from "./marketData";

export interface GroupedBookLevel extends BookLevel {
  cumulativeSize: number;
  levelCount: number;
}

export interface BookLadder {
  asks: GroupedBookLevel[];
  bids: GroupedBookLevel[];
  bestAsk?: number;
  bestBid?: number;
  mid?: number;
  spread?: number;
  spreadBps?: number;
  microPrice?: number;
  imbalance: number;
  bidTotal: number;
  askTotal: number;
  maxSize: number;
  groupSize: number;
}

export interface TradeBurst {
  id: string;
  side: "buy" | "sell";
  time: number;
  endTime: number;
  price: number;
  size: number;
  notional: number;
  count: number;
}

export interface LargeTradeResult {
  bursts: TradeBurst[];
  threshold: number;
  buyNotional: number;
  sellNotional: number;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function niceStep(target: number, minimum: number): number {
  if (!finitePositive(target)) return minimum;
  const safeMinimum = finitePositive(minimum) ? minimum : 0.01;
  const exponent = Math.floor(Math.log10(target));
  const power = 10 ** exponent;
  const normalized = target / power;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const stepped = multiplier * power;
  const multiples = Math.max(1, Math.round(stepped / safeMinimum));
  return Number((multiples * safeMinimum).toPrecision(12));
}

export function automaticBookGroup(market: MarketDefinition, referencePrice?: number): number {
  const minimum = 10 ** -market.priceDecimals;
  const target = referencePrice && finitePositive(referencePrice) ? referencePrice * 0.000012 : minimum * 5;
  return niceStep(target, minimum);
}

export function bookGroupOptions(market: MarketDefinition, referencePrice?: number): Array<{ value: string; label: string; size: number }> {
  const minimum = 10 ** -market.priceDecimals;
  const automatic = automaticBookGroup(market, referencePrice);
  const candidates = [minimum, automatic / 2, automatic, automatic * 2, automatic * 5]
    .map((value) => niceStep(value, minimum))
    .filter((value) => finitePositive(value));
  const unique = Array.from(new Set(candidates.map((value) => value.toPrecision(12)))).map(Number).sort((a, b) => a - b);
  return [
    { value: "auto", label: `Auto · ${formatGroupSize(automatic)}`, size: automatic },
    ...unique.map((size) => ({ value: String(size), label: formatGroupSize(size), size })),
  ];
}

export function resolveBookGroup(value: string, market: MarketDefinition, referencePrice?: number): number {
  if (value === "auto") return automaticBookGroup(market, referencePrice);
  const parsed = Number(value);
  return finitePositive(parsed) ? parsed : automaticBookGroup(market, referencePrice);
}

export function formatGroupSize(value: number): string {
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1).replace(/\.0$/, "");
  if (value >= 1) return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function cleanLevels(levels: BookLevel[], side: "bid" | "ask"): BookLevel[] {
  const merged = new Map<number, BookLevel>();
  for (const level of levels) {
    if (!finitePositive(level.price) || !finitePositive(level.size)) continue;
    const existing = merged.get(level.price);
    if (existing) {
      existing.size += level.size;
      existing.orders = (existing.orders ?? 0) + (level.orders ?? 0);
    } else {
      merged.set(level.price, { ...level });
    }
  }
  return Array.from(merged.values()).sort((a, b) => side === "bid" ? b.price - a.price : a.price - b.price);
}

function groupSide(levels: BookLevel[], side: "bid" | "ask", groupSize: number, depth: number): GroupedBookLevel[] {
  const grouped = new Map<string, { price: number; size: number; orders: number; levelCount: number }>();
  for (const level of levels) {
    const groupedPrice = side === "bid"
      ? Math.floor((level.price + Number.EPSILON) / groupSize) * groupSize
      : Math.ceil((level.price - Number.EPSILON) / groupSize) * groupSize;
    const normalizedPrice = Number(groupedPrice.toPrecision(12));
    const key = normalizedPrice.toPrecision(12);
    const current = grouped.get(key);
    if (current) {
      current.size += level.size;
      current.orders += level.orders ?? 0;
      current.levelCount += 1;
    } else {
      grouped.set(key, {
        price: normalizedPrice,
        size: level.size,
        orders: level.orders ?? 0,
        levelCount: 1,
      });
    }
  }

  const sorted = Array.from(grouped.values()).sort((a, b) => side === "bid" ? b.price - a.price : a.price - b.price).slice(0, depth);
  let cumulative = 0;
  return sorted.map((level) => {
    cumulative += level.size;
    return {
      ...level,
      cumulativeSize: cumulative,
      orders: level.orders > 0 ? level.orders : undefined,
    };
  });
}

export function buildBookLadder(book: OrderBook | null, groupSize: number, depth = 16): BookLadder {
  if (!book) {
    return {
      asks: [],
      bids: [],
      imbalance: 0.5,
      bidTotal: 0,
      askTotal: 0,
      maxSize: 1,
      groupSize,
    };
  }

  const rawBids = cleanLevels(book.bids, "bid");
  const rawAsks = cleanLevels(book.asks, "ask");
  const rawBestBid = rawBids[0]?.price;
  const rawBestAsk = rawAsks[0]?.price;

  const crossed = rawBestBid !== undefined && rawBestAsk !== undefined && rawBestBid >= rawBestAsk;
  const safeBids = crossed && rawBestAsk !== undefined ? rawBids.filter((level) => level.price < rawBestAsk) : rawBids;
  const safeAsks = crossed && rawBestBid !== undefined ? rawAsks.filter((level) => level.price > rawBestBid) : rawAsks;

  const bids = groupSide(safeBids, "bid", groupSize, depth);
  const asks = groupSide(safeAsks, "ask", groupSize, depth);
  const bestBid = safeBids[0]?.price;
  const bestAsk = safeAsks[0]?.price;
  const mid = bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk;
  const spread = bestBid !== undefined && bestAsk !== undefined ? Math.max(0, bestAsk - bestBid) : undefined;
  const spreadBps = spread !== undefined && mid ? (spread / mid) * 10_000 : undefined;
  const bidTotal = bids.reduce((sum, level) => sum + level.size, 0);
  const askTotal = asks.reduce((sum, level) => sum + level.size, 0);
  const total = bidTotal + askTotal;
  const imbalance = total > 0 ? bidTotal / total : 0.5;
  const bestBidSize = safeBids[0]?.size ?? 0;
  const bestAskSize = safeAsks[0]?.size ?? 0;
  const microPrice = bestBid !== undefined && bestAsk !== undefined && bestBidSize + bestAskSize > 0
    ? (bestAsk * bestBidSize + bestBid * bestAskSize) / (bestBidSize + bestAskSize)
    : mid;
  const maxSize = Math.max(1, ...bids.map((level) => level.size), ...asks.map((level) => level.size));

  return {
    asks,
    bids,
    bestAsk,
    bestBid,
    mid,
    spread,
    spreadBps,
    microPrice,
    imbalance,
    bidTotal,
    askTotal,
    maxSize,
    groupSize,
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((sorted.length - 1) * fraction)));
  return sorted[index];
}

export function aggregateTradeBursts(trades: Trade[], maxGapMs = 420): TradeBurst[] {
  const sorted = trades
    .filter((trade) => finitePositive(trade.price) && finitePositive(trade.size) && Number.isFinite(trade.time))
    .slice()
    .sort((a, b) => a.time - b.time);
  const bursts: TradeBurst[] = [];

  for (const trade of sorted) {
    const previous = bursts.at(-1);
    const priceTolerance = Math.max(10 ** -4, trade.price * 0.000035);
    const canMerge = previous
      && previous.side === trade.side
      && trade.time - previous.endTime <= maxGapMs
      && Math.abs(trade.price - previous.price) <= priceTolerance;

    if (canMerge && previous) {
      const nextSize = previous.size + trade.size;
      previous.price = (previous.price * previous.size + trade.price * trade.size) / nextSize;
      previous.size = nextSize;
      previous.notional += trade.price * trade.size;
      previous.count += 1;
      previous.endTime = trade.time;
      previous.id = `${previous.id}:${trade.id}`;
    } else {
      bursts.push({
        id: trade.id,
        side: trade.side,
        time: trade.time,
        endTime: trade.time,
        price: trade.price,
        size: trade.size,
        notional: trade.price * trade.size,
        count: 1,
      });
    }
  }
  return bursts;
}

export function detectLargeTrades(
  trades: Trade[],
  sensitivity: "more" | "balanced" | "strict" = "balanced",
  maxBursts = 18,
): LargeTradeResult {
  const recent = trades.slice(-700);
  const bursts = aggregateTradeBursts(recent);
  if (bursts.length === 0) return { bursts: [], threshold: 0, buyNotional: 0, sellNotional: 0 };

  const quantile = sensitivity === "more" ? 0.76 : sensitivity === "strict" ? 0.94 : 0.86;
  const notionals = bursts.map((burst) => burst.notional);
  const median = percentile(notionals, 0.5);
  const adaptive = percentile(notionals, quantile);
  let threshold = Math.max(adaptive, median * (sensitivity === "more" ? 1.8 : sensitivity === "strict" ? 4.5 : 3));
  let selected = bursts.filter((burst) => burst.notional >= threshold);

  const minimumVisible = Math.min(5, bursts.length);
  if (selected.length < minimumVisible) {
    const ranked = bursts.slice().sort((a, b) => b.notional - a.notional);
    threshold = ranked[minimumVisible - 1]?.notional ?? threshold;
    selected = bursts.filter((burst) => burst.notional >= threshold);
  }

  selected = selected.slice(-maxBursts);
  const buyNotional = selected.filter((burst) => burst.side === "buy").reduce((sum, burst) => sum + burst.notional, 0);
  const sellNotional = selected.filter((burst) => burst.side === "sell").reduce((sum, burst) => sum + burst.notional, 0);
  return { bursts: selected, threshold, buyNotional, sellNotional };
}

export function formatNotional(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return value.toFixed(value >= 100 ? 0 : 2);
}

export function formatBookSize(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  if (value >= 100) return value.toFixed(0);
  if (value >= 1) return value.toFixed(Math.min(2, decimals));
  return value.toFixed(Math.max(2, Math.min(6, decimals + 2))).replace(/0+$/, "").replace(/\.$/, "");
}
