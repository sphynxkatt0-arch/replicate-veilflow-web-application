import { integrityHash } from "./integrity";
import type { Candle, MarketDefinition, MarketMetrics, MarketState, NormalizedEvent, OrderBook, ReplayState, Trade } from "./types";

const MAX_EVENTS = 200_000;
const CHECKPOINT_EVENT_COUNT = 5_000;
const REPLAY_FORMAT = "veilflow-session-v3" as const;

export interface ReplayCheckpoint {
  startCursor: number;
  endCursor: number;
  exchangeTime: number;
  eventCount: number;
  eventHash: string;
}

interface ReplayManifest {
  format: typeof REPLAY_FORMAT;
  schemaVersion: 3;
  createdAt: number;
  market: MarketDefinition;
  timeframe: string;
  startTime?: number;
  endTime?: number;
  eventCount: number;
  eventHash: string;
  checkpointInterval: number;
  checkpoints: ReplayCheckpoint[];
}

export interface ReplayArchiveV3 extends ReplayManifest {
  manifestHash: string;
  events: NormalizedEvent[];
}

interface LegacyReplayArchive {
  format?: string;
  events?: NormalizedEvent[];
}

function buildCheckpoints(events: NormalizedEvent[]): ReplayCheckpoint[] {
  const checkpoints: ReplayCheckpoint[] = [];
  for (let startCursor = 0; startCursor < events.length; startCursor += CHECKPOINT_EVENT_COUNT) {
    const endCursor = Math.min(events.length - 1, startCursor + CHECKPOINT_EVENT_COUNT - 1);
    const chunk = events.slice(startCursor, endCursor + 1);
    checkpoints.push({
      startCursor,
      endCursor,
      exchangeTime: chunk.at(-1)?.exchangeTime ?? 0,
      eventCount: chunk.length,
      eventHash: integrityHash(chunk),
    });
  }
  return checkpoints;
}

function manifestFromArchive(archive: ReplayArchiveV3): ReplayManifest {
  return {
    format: archive.format,
    schemaVersion: archive.schemaVersion,
    createdAt: archive.createdAt,
    market: archive.market,
    timeframe: archive.timeframe,
    startTime: archive.startTime,
    endTime: archive.endTime,
    eventCount: archive.eventCount,
    eventHash: archive.eventHash,
    checkpointInterval: archive.checkpointInterval,
    checkpoints: archive.checkpoints,
  };
}

function singleMarket(events: NormalizedEvent[]): string | undefined {
  const markets = new Set(events.map((event) => event.market));
  if (markets.size > 1) throw new Error("Replay archive contains mixed instruments");
  return events[0]?.market;
}

export function createReplayArchive(
  market: MarketDefinition,
  timeframe: string,
  events: NormalizedEvent[],
  createdAt = Date.now(),
): ReplayArchiveV3 {
  const snapshot = events.slice(-MAX_EVENTS);
  const eventMarket = singleMarket(snapshot);
  if (eventMarket !== undefined && eventMarket !== market.key) {
    throw new Error(`Replay events are ${eventMarket}, but manifest is ${market.key}`);
  }
  const manifest: ReplayManifest = {
    format: REPLAY_FORMAT,
    schemaVersion: 3,
    createdAt,
    market,
    timeframe,
    startTime: snapshot[0]?.exchangeTime,
    endTime: snapshot.at(-1)?.exchangeTime,
    eventCount: snapshot.length,
    eventHash: integrityHash(snapshot),
    checkpointInterval: CHECKPOINT_EVENT_COUNT,
    checkpoints: buildCheckpoints(snapshot),
  };
  return {
    ...manifest,
    manifestHash: integrityHash(manifest),
    events: snapshot,
  };
}

export function validateReplayArchive(archive: ReplayArchiveV3): void {
  if (archive.format !== REPLAY_FORMAT || archive.schemaVersion !== 3) {
    throw new Error("Unsupported VeilFlow replay schema");
  }
  if (!Array.isArray(archive.events) || !Array.isArray(archive.checkpoints)) {
    throw new Error("Replay archive is missing events or checkpoints");
  }
  if (archive.manifestHash !== integrityHash(manifestFromArchive(archive))) {
    throw new Error("Replay manifest integrity hash mismatch");
  }
  if (archive.eventCount !== archive.events.length) {
    throw new Error(`Replay event count mismatch: manifest ${archive.eventCount}, payload ${archive.events.length}`);
  }
  if (archive.eventHash !== integrityHash(archive.events)) {
    throw new Error("Replay event integrity hash mismatch");
  }
  const eventMarket = singleMarket(archive.events);
  if (eventMarket !== undefined && eventMarket !== archive.market.key) {
    throw new Error(`Replay instrument mismatch: events ${eventMarket}, manifest ${archive.market.key}`);
  }

  const expectedCheckpoints = buildCheckpoints(archive.events);
  if (archive.checkpointInterval !== CHECKPOINT_EVENT_COUNT || archive.checkpoints.length !== expectedCheckpoints.length) {
    throw new Error("Replay checkpoint manifest mismatch");
  }
  for (let index = 0; index < expectedCheckpoints.length; index += 1) {
    const expected = expectedCheckpoints[index];
    const actual = archive.checkpoints[index];
    if (
      actual.startCursor !== expected.startCursor
      || actual.endCursor !== expected.endCursor
      || actual.eventCount !== expected.eventCount
      || actual.exchangeTime !== expected.exchangeTime
      || actual.eventHash !== expected.eventHash
    ) {
      throw new Error(`Replay checkpoint ${index} integrity mismatch`);
    }
  }

  const firstTime = archive.events[0]?.exchangeTime;
  const lastTime = archive.events.at(-1)?.exchangeTime;
  if (archive.startTime !== firstTime || archive.endTime !== lastTime) {
    throw new Error("Replay time-range manifest mismatch");
  }
}

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
    return JSON.stringify(createReplayArchive(market, timeframe, this.events));
  }

  importJson(raw: string): NormalizedEvent[] {
    const parsed = JSON.parse(raw) as LegacyReplayArchive | ReplayArchiveV3;
    if (parsed.format === REPLAY_FORMAT) {
      validateReplayArchive(parsed as ReplayArchiveV3);
    } else if (!["veilflow-session-v1", "veilflow-session-v2"].includes(parsed.format ?? "") || !Array.isArray(parsed.events)) {
      throw new Error("Unsupported VeilFlow replay file");
    }

    const events = (parsed.events ?? [])
      .filter((event) => event && typeof event === "object" && typeof event.type === "string")
      .slice(-MAX_EVENTS);
    singleMarket(events);
    this.events = events;
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
