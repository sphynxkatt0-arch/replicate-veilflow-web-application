import type { Candle, MarketDefinition, MarketMetrics, MarketState, NormalizedEvent, OrderBook, ReplayState, Trade } from "./types";

const MAX_EVENTS = 200_000;

export class EventRecorder {
  private events: NormalizedEvent[] = [];
  private marketKey: string | null = null;

  reset(marketKey?: string): void {
    this.events = [];
    this.marketKey = marketKey ?? null;
  }

  append(event: NormalizedEvent): void {
    if (this.marketKey && event.market !== this.marketKey) return;
    this.marketKey = event.market;
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  snapshot(): NormalizedEvent[] { return this.events.slice(); }

  exportJson(market: MarketDefinition, timeframe: string): string {
    return JSON.stringify({
      format: "veilflow-session-v2",
      createdAt: Date.now(),
      market,
      timeframe,
      events: this.events,
    });
  }

  importJson(raw: string): NormalizedEvent[] {
    const parsed = JSON.parse(raw) as { format?: string; events?: NormalizedEvent[] };
    if (!["veilflow-session-v1", "veilflow-session-v2"].includes(parsed.format ?? "") || !Array.isArray(parsed.events)) {
      throw new Error("Unsupported VeilFlow replay file");
    }
    this.events = parsed.events
      .filter((event) => event && typeof event === "object" && typeof event.type === "string")
      .slice(-MAX_EVENTS);
    this.marketKey = this.events[0]?.market ?? null;
    return this.snapshot();
  }
}

export function reduceReplay(
  base: MarketState,
  replay: ReplayState,
): Pick<MarketState, "candles" | "trades" | "book" | "metrics" | "status" | "statusDetail" | "lastEventAt"> {
  const candles = new Map<number, Candle>();
  const trades: Trade[] = [];
  let book: OrderBook | null = null;
  let metrics: MarketMetrics = base.metrics;
  let status = base.status;
  let statusDetail = "Recorded session replay";
  let lastEventAt = 0;

  for (const event of replay.events.slice(0, replay.cursor + 1)) {
    lastEventAt = event.exchangeTime;
    if (event.type === "candle") candles.set(event.payload.time, event.payload);
    else if (event.type === "trade") trades.push({ ...event.payload, source: "replay" });
    else if (event.type === "book") book = event.payload;
    else if (event.type === "metrics") metrics = event.payload;
    else if (event.type === "status") {
      status = event.payload.state;
      statusDetail = event.payload.detail;
    }
  }

  return {
    candles: [...candles.values()].sort((a, b) => a.time - b.time),
    trades: trades.slice(-100_000),
    book,
    metrics,
    status,
    statusDetail,
    lastEventAt,
  };
}
