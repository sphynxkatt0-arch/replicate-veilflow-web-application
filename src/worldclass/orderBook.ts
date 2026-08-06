import type { BookLevel, DataQuality, OrderBook } from "./types";

export interface BinanceDepthSnapshot {
  lastUpdateId: number;
  bids: Array<[string, string]>;
  asks: Array<[string, string]>;
}

export interface BinanceDepthUpdate {
  E: number;
  U: number;
  u: number;
  pu?: number;
  b: Array<[string, string]>;
  a: Array<[string, string]>;
}

export type BookSyncState = "idle" | "buffering" | "syncing" | "synced" | "gapped";

export class BinanceLocalBook {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private buffered: BinanceDepthUpdate[] = [];
  private lastUpdateId = 0;
  private state: BookSyncState = "idle";
  private needsBridge = true;

  get syncState(): BookSyncState { return this.state; }
  get sequence(): number { return this.lastUpdateId; }

  reset(): void {
    this.bids.clear();
    this.asks.clear();
    this.buffered = [];
    this.lastUpdateId = 0;
    this.state = "buffering";
    this.needsBridge = true;
  }

  buffer(update: BinanceDepthUpdate): void {
    if (this.state === "synced") throw new Error("Cannot buffer while synchronized");
    this.buffered.push(update);
    this.state = "buffering";
  }

  applySnapshot(snapshot: BinanceDepthSnapshot): void {
    this.state = "syncing";
    this.bids.clear();
    this.asks.clear();
    this.applyLevels(this.bids, snapshot.bids);
    this.applyLevels(this.asks, snapshot.asks);
    this.lastUpdateId = snapshot.lastUpdateId;
    this.needsBridge = true;
    this.buffered.sort((a, b) => a.U - b.U);
    this.buffered = this.buffered.filter((update) => update.u > this.lastUpdateId);

    const first = this.buffered[0];
    if (first && !(first.U <= this.lastUpdateId + 1 && first.u >= this.lastUpdateId + 1)) {
      this.state = "gapped";
      throw new Error(`Initial depth gap: snapshot ${this.lastUpdateId}, first [${first.U}, ${first.u}]`);
    }

    for (const update of this.buffered) this.applyUpdate(update);
    this.buffered = [];
    this.state = "synced";
  }

  applyUpdate(update: BinanceDepthUpdate): boolean {
    if (update.u <= this.lastUpdateId) return false;
    const bridgesSnapshot = this.needsBridge && this.lastUpdateId > 0 && update.U <= this.lastUpdateId + 1 && update.u >= this.lastUpdateId + 1;
    if (!bridgesSnapshot && this.lastUpdateId > 0 && update.pu !== undefined && update.pu !== this.lastUpdateId) {
      this.state = "gapped";
      throw new Error(`Futures depth sequence gap: expected previous ${this.lastUpdateId}, received ${update.pu}`);
    }
    if (!bridgesSnapshot && this.lastUpdateId > 0 && update.U > this.lastUpdateId + 1) {
      this.state = "gapped";
      throw new Error(`Depth sequence gap: expected ${this.lastUpdateId + 1}, received ${update.U}`);
    }
    if (this.lastUpdateId > 0 && update.u < this.lastUpdateId + 1) return false;
    this.applyLevels(this.bids, update.b);
    this.applyLevels(this.asks, update.a);
    this.lastUpdateId = update.u;
    this.needsBridge = false;
    this.state = "synced";
    return true;
  }

  snapshot(exchangeTime: number, limit = 100, quality: DataQuality = "full"): OrderBook {
    return {
      bids: this.sorted(this.bids, true, limit),
      asks: this.sorted(this.asks, false, limit),
      exchangeTime,
      receiveTime: Date.now(),
      sequence: this.lastUpdateId,
      quality: this.state === "gapped" ? "gapped" : quality,
    };
  }

  private applyLevels(side: Map<number, number>, levels: Array<[string, string]>): void {
    for (const [rawPrice, rawSize] of levels) {
      const price = Number(rawPrice);
      const size = Number(rawSize);
      if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0) continue;
      if (size === 0) side.delete(price);
      else if (size > 0) side.set(price, size);
    }
  }

  private sorted(side: Map<number, number>, descending: boolean, limit: number): BookLevel[] {
    return [...side.entries()]
      .sort((a, b) => descending ? b[0] - a[0] : a[0] - b[0])
      .slice(0, limit)
      .map(([price, size]) => ({ price, size }));
  }
}

export function normalizeBook(
  bids: BookLevel[],
  asks: BookLevel[],
  exchangeTime: number,
  quality: DataQuality,
  limit = 100,
): OrderBook {
  const validBids = bids.filter((level) => level.price > 0 && level.size > 0).sort((a, b) => b.price - a.price);
  const validAsks = asks.filter((level) => level.price > 0 && level.size > 0).sort((a, b) => a.price - b.price);
  const bestAsk = validAsks[0]?.price ?? Infinity;
  const uncrossedBids = validBids.filter((level) => level.price < bestAsk);
  const bestBid = uncrossedBids[0]?.price ?? -Infinity;
  return {
    bids: uncrossedBids.slice(0, limit),
    asks: validAsks.filter((level) => level.price > bestBid).slice(0, limit),
    exchangeTime,
    receiveTime: Date.now(),
    quality,
  };
}

export function groupBook(book: OrderBook | null, groupSize: number, levels = 18): OrderBook | null {
  if (!book || groupSize <= 0) return book;
  const group = (input: BookLevel[], side: "bid" | "ask") => {
    const map = new Map<number, { size: number; orders: number }>();
    for (const level of input) {
      const price = side === "bid"
        ? Math.floor(level.price / groupSize) * groupSize
        : Math.ceil(level.price / groupSize) * groupSize;
      const key = Number(price.toPrecision(12));
      const current = map.get(key) ?? { size: 0, orders: 0 };
      current.size += level.size;
      current.orders += level.orders ?? 0;
      map.set(key, current);
    }
    return [...map.entries()]
      .map(([price, value]) => ({ price, size: value.size, orders: value.orders || undefined }))
      .sort((a, b) => side === "bid" ? b.price - a.price : a.price - b.price)
      .slice(0, levels);
  };
  return { ...book, bids: group(book.bids, "bid"), asks: group(book.asks, "ask") };
}
