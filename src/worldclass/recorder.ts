import { integrityHash } from "./integrity";
import type { Candle, ConnectionState, MarketDefinition, MarketMetrics, MarketState, NormalizedEvent, OrderBook, ReplayState, Trade } from "./types";

const MAX_EVENTS = 200_000;
const EVENT_TRIM_BATCH = 5_000;
const CHECKPOINT_EVENT_COUNT = 5_000;
const REPLAY_FORMAT = "veilflow-session-v4" as const;

export interface ReplayOutputState {
  candles: Candle[];
  trades: Trade[];
  book: OrderBook | null;
  metrics: MarketMetrics;
  status: ConnectionState;
  statusDetail: string;
  lastEventAt: number;
}

export interface ReplayCheckpoint {
  startCursor: number;
  endCursor: number;
  exchangeTime: number;
  eventCount: number;
  eventHash: string;
  stateHash: string;
}

interface ReplayManifest {
  format: typeof REPLAY_FORMAT;
  schemaVersion: 4;
  createdAt: number;
  market: MarketDefinition;
  timeframe: string;
  startTime?: number;
  endTime?: number;
  eventCount: number;
  eventHash: string;
  analyticsOutputHash: string;
  checkpointInterval: number;
  checkpoints: ReplayCheckpoint[];
}

export interface ReplayArchiveV4 extends ReplayManifest {
  manifestHash: string;
  events: NormalizedEvent[];
}

interface ReplayArchiveV3 {
  format: "veilflow-session-v3";
  schemaVersion: 3;
  createdAt: number;
  market: MarketDefinition;
  timeframe: string;
  startTime?: number;
  endTime?: number;
  eventCount: number;
  eventHash: string;
  checkpointInterval: number;
  checkpoints: Array<Omit<ReplayCheckpoint, "stateHash">>;
  manifestHash: string;
  events: NormalizedEvent[];
}

interface LegacyReplayArchive {
  format?: string;
  market?: MarketDefinition;
  timeframe?: string;
  events?: NormalizedEvent[];
}

interface MutableReplayState {
  candles: Map<number, Candle>;
  trades: Trade[];
  book: OrderBook | null;
  metrics: MarketMetrics;
  status: ConnectionState;
  statusDetail: string;
  lastEventAt: number;
}

interface CachedCheckpoint {
  cursor: number;
  output: ReplayOutputState;
}

const checkpointCache = new WeakMap<NormalizedEvent[], CachedCheckpoint[]>();

function emptyReplayState(): MutableReplayState {
  return {
    candles: new Map(),
    trades: [],
    book: null,
    metrics: { timestamp: 0, quality: "unavailable" },
    status: "closed",
    statusDetail: "Recorded session replay",
    lastEventAt: 0,
  };
}

function applyEvent(state: MutableReplayState, event: NormalizedEvent): void {
  state.lastEventAt = event.exchangeTime;
  if (event.type === "candle") state.candles.set(event.payload.time, event.payload);
  else if (event.type === "trade") {
    state.trades.push({ ...event.payload, source: "replay" });
    if (state.trades.length > 100_000) state.trades.splice(0, state.trades.length - 100_000);
  } else if (event.type === "book") state.book = event.payload;
  else if (event.type === "metrics") state.metrics = event.payload;
  else if (event.type === "status") {
    state.status = event.payload.state;
    state.statusDetail = event.payload.detail;
  }
}

function outputState(state: MutableReplayState): ReplayOutputState {
  return {
    candles: [...state.candles.values()].sort((a, b) => a.time - b.time),
    trades: state.trades.slice(),
    book: state.book ? structuredClone(state.book) : null,
    metrics: structuredClone(state.metrics),
    status: state.status,
    statusDetail: state.statusDetail,
    lastEventAt: state.lastEventAt,
  };
}

function mutableFromOutput(output: ReplayOutputState): MutableReplayState {
  return {
    candles: new Map(output.candles.map((candle) => [candle.time, candle])),
    trades: output.trades.slice(),
    book: output.book ? structuredClone(output.book) : null,
    metrics: structuredClone(output.metrics),
    status: output.status,
    statusDetail: output.statusDetail,
    lastEventAt: output.lastEventAt,
  };
}

function buildReplayStateCheckpoints(events: NormalizedEvent[]): CachedCheckpoint[] {
  const state = emptyReplayState();
  const checkpoints: CachedCheckpoint[] = [];
  for (let cursor = 0; cursor < events.length; cursor += 1) {
    applyEvent(state, events[cursor]);
    if ((cursor + 1) % CHECKPOINT_EVENT_COUNT === 0 || cursor === events.length - 1) checkpoints.push({ cursor, output: outputState(state) });
  }
  return checkpoints;
}

function replayStateAt(events: NormalizedEvent[], cursor: number): ReplayOutputState {
  let checkpoints = checkpointCache.get(events);
  if (!checkpoints) {
    checkpoints = buildReplayStateCheckpoints(events);
    checkpointCache.set(events, checkpoints);
  }
  const checkpoint = [...checkpoints].reverse().find((item) => item.cursor <= cursor);
  const state = checkpoint ? mutableFromOutput(checkpoint.output) : emptyReplayState();
  const start = checkpoint ? checkpoint.cursor + 1 : 0;
  for (let index = start; index <= cursor && index < events.length; index += 1) applyEvent(state, events[index]);
  return outputState(state);
}

function buildCheckpoints(events: NormalizedEvent[]): ReplayCheckpoint[] {
  const state = emptyReplayState();
  const checkpoints: ReplayCheckpoint[] = [];
  for (let startCursor = 0; startCursor < events.length; startCursor += CHECKPOINT_EVENT_COUNT) {
    const endCursor = Math.min(events.length - 1, startCursor + CHECKPOINT_EVENT_COUNT - 1);
    const chunk = events.slice(startCursor, endCursor + 1);
    for (const event of chunk) applyEvent(state, event);
    checkpoints.push({
      startCursor,
      endCursor,
      exchangeTime: chunk.at(-1)?.exchangeTime ?? 0,
      eventCount: chunk.length,
      eventHash: integrityHash(chunk),
      stateHash: integrityHash(outputState(state)),
    });
  }
  return checkpoints;
}

function manifestFromArchive(archive: ReplayArchiveV4): ReplayManifest {
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
    analyticsOutputHash: archive.analyticsOutputHash,
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
): ReplayArchiveV4 {
  const snapshot = events.slice(-MAX_EVENTS);
  const eventMarket = singleMarket(snapshot);
  if (eventMarket !== undefined && eventMarket !== market.key) throw new Error(`Replay events are ${eventMarket}, but manifest is ${market.key}`);
  const checkpoints = buildCheckpoints(snapshot);
  const finalOutput = snapshot.length ? replayStateAt(snapshot, snapshot.length - 1) : outputState(emptyReplayState());
  const manifest: ReplayManifest = {
    format: REPLAY_FORMAT,
    schemaVersion: 4,
    createdAt,
    market,
    timeframe,
    startTime: snapshot[0]?.exchangeTime,
    endTime: snapshot.at(-1)?.exchangeTime,
    eventCount: snapshot.length,
    eventHash: integrityHash(snapshot),
    analyticsOutputHash: integrityHash(finalOutput),
    checkpointInterval: CHECKPOINT_EVENT_COUNT,
    checkpoints,
  };
  return { ...manifest, manifestHash: integrityHash(manifest), events: snapshot };
}

export function validateReplayArchive(archive: ReplayArchiveV4): void {
  if (archive.format !== REPLAY_FORMAT || archive.schemaVersion !== 4) throw new Error("Unsupported VeilFlow replay schema");
  if (!Array.isArray(archive.events) || !Array.isArray(archive.checkpoints)) throw new Error("Replay archive is missing events or checkpoints");
  if (archive.manifestHash !== integrityHash(manifestFromArchive(archive))) throw new Error("Replay manifest integrity hash mismatch");
  if (archive.eventCount !== archive.events.length) throw new Error(`Replay event count mismatch: manifest ${archive.eventCount}, payload ${archive.events.length}`);
  if (archive.eventHash !== integrityHash(archive.events)) throw new Error("Replay event integrity hash mismatch");
  const eventMarket = singleMarket(archive.events);
  if (eventMarket !== undefined && eventMarket !== archive.market.key) throw new Error(`Replay instrument mismatch: events ${eventMarket}, manifest ${archive.market.key}`);

  const expectedCheckpoints = buildCheckpoints(archive.events);
  if (archive.checkpointInterval !== CHECKPOINT_EVENT_COUNT || archive.checkpoints.length !== expectedCheckpoints.length) throw new Error("Replay checkpoint manifest mismatch");
  for (let index = 0; index < expectedCheckpoints.length; index += 1) {
    const expected = expectedCheckpoints[index];
    const actual = archive.checkpoints[index];
    if (actual.startCursor !== expected.startCursor || actual.endCursor !== expected.endCursor || actual.eventCount !== expected.eventCount || actual.exchangeTime !== expected.exchangeTime || actual.eventHash !== expected.eventHash || actual.stateHash !== expected.stateHash) {
      throw new Error(`Replay checkpoint ${index} integrity mismatch`);
    }
  }
  const finalOutput = archive.events.length ? replayStateAt(archive.events, archive.events.length - 1) : outputState(emptyReplayState());
  if (archive.analyticsOutputHash !== integrityHash(finalOutput)) throw new Error("Replay analytics output hash mismatch");
  const firstTime = archive.events[0]?.exchangeTime;
  const lastTime = archive.events.at(-1)?.exchangeTime;
  if (archive.startTime !== firstTime || archive.endTime !== lastTime) throw new Error("Replay time-range manifest mismatch");
}

function validateReplayV3(archive: ReplayArchiveV3): void {
  if (!Array.isArray(archive.events) || archive.eventCount !== archive.events.length) throw new Error("Replay event count mismatch");
  if (archive.eventHash !== integrityHash(archive.events)) throw new Error("Replay event integrity hash mismatch");
  singleMarket(archive.events);
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
    if (this.events.length > MAX_EVENTS + EVENT_TRIM_BATCH) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
  }

  get eventCount(): number { return this.events.length; }

  snapshot(limit = MAX_EVENTS): NormalizedEvent[] {
    const bounded = Math.max(0, Math.min(MAX_EVENTS, Math.floor(limit)));
    return bounded === 0 ? [] : this.events.slice(-bounded);
  }

  exportJson(market: MarketDefinition, timeframe: string): string {
    return JSON.stringify(createReplayArchive(market, timeframe, this.events));
  }

  importJson(raw: string): NormalizedEvent[] {
    const parsed = JSON.parse(raw) as LegacyReplayArchive | ReplayArchiveV3 | ReplayArchiveV4;
    if (parsed.format === REPLAY_FORMAT) validateReplayArchive(parsed as ReplayArchiveV4);
    else if (parsed.format === "veilflow-session-v3") validateReplayV3(parsed as ReplayArchiveV3);
    else if (!["veilflow-session-v1", "veilflow-session-v2"].includes(parsed.format ?? "") || !Array.isArray(parsed.events)) throw new Error("Unsupported VeilFlow replay file");

    const events = (parsed.events ?? []).filter((event) => event && typeof event === "object" && typeof event.type === "string").slice(-MAX_EVENTS);
    singleMarket(events);
    this.events = events;
    this.marketKey = this.events[0]?.market ?? null;
    return this.snapshot();
  }
}

export function reduceReplay(
  _base: MarketState,
  replay: ReplayState,
): Pick<MarketState, "candles" | "trades" | "book" | "metrics" | "status" | "statusDetail" | "lastEventAt"> {
  return replayStateAt(replay.events, Math.max(0, Math.min(replay.cursor, replay.events.length - 1)));
}
