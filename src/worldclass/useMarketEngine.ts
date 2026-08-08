import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { calculateAnalytics } from "./analytics";
import { buildFootprints, FootprintAccumulator } from "./footprint";
import { MARKETS } from "./markets";
import { loadSnapshot, streamMarket, type ProviderController } from "./providers";
import { EventRecorder, reduceReplay } from "./recorder";
import { createStoredSession, defaultSessionStore, type StoredSession, type StoredSessionSummary } from "./sessionStore";
import {
  createPublicationDirty,
  markPublicationDirty,
  preparePublishedCollections,
  publishedCollectionsFromState,
  type PublishedCollections,
} from "./statePublication";
import { TelemetryBuffer } from "./telemetry";
import type {
  Candle,
  ConnectionState,
  MarketKey,
  MarketMetrics,
  MarketState,
  NormalizedEvent,
  OrderBook,
  ReplayState,
  Timeframe,
  Trade,
} from "./types";

const EMPTY_METRICS: MarketMetrics = { timestamp: 0, quality: "unavailable" };
const EMPTY_FOOTPRINT = {
  quality: "aggregate-only" as const,
  source: "none" as const,
  contiguous: true,
  eventCount: 0,
  detail: "No footprint data yet",
};
const STALE_AFTER_MS = 8_000;
const STALE_CHECK_MS = 250;
const UI_FLUSH_MS = 50;
const ANALYTICS_INTERVAL_MS = 250;
const FOOTPRINT_QUALITY_REFRESH_MS = 1_000;
const AUTOSAVE_MS = 30_000;
const AUTOSAVE_IDLE_TIMEOUT_MS = 2_500;
const MAX_LIVE_TRADES = 25_000;
const TRADE_TRIM_BATCH = 2_000;

interface PendingReplay {
  raw: string;
  name: string;
  market: MarketKey;
  timeframe: Timeframe;
}

function validMarket(value: string | null): MarketKey {
  return value && value in MARKETS ? value as MarketKey : "BTC";
}

function validTimeframe(value: unknown): Timeframe {
  return typeof value === "string" && ["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"].includes(value) ? value as Timeframe : "5m";
}

function initialState(marketKey: MarketKey, timeframe: Timeframe): MarketState {
  const market = MARKETS[marketKey];
  return {
    market,
    timeframe,
    candles: [],
    trades: [],
    footprints: [],
    footprintCoverage: EMPTY_FOOTPRINT,
    book: null,
    metrics: EMPTY_METRICS,
    analytics: { dataQuality: market.quality },
    status: "connecting",
    statusDetail: "Preparing market data",
    lastEventAt: 0,
    eventRate: 0,
    eventLagMs: 0,
  };
}

function mergeCandle(candles: Candle[], candle: Candle): Candle[] {
  const last = candles.at(-1);
  if (last?.time === candle.time) {
    const next = candles.slice();
    next[next.length - 1] = candle;
    return next;
  }
  if (!last || candle.time > last.time) return [...candles, candle].slice(-5000);
  const index = candles.findIndex((item) => item.time === candle.time);
  if (index >= 0) {
    const next = candles.slice();
    next[index] = candle;
    return next;
  }
  return [...candles, candle].sort((a, b) => a.time - b.time).slice(-5000);
}

function mergeCandles(left: Candle[], right: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const candle of [...left, ...right]) map.set(candle.time, candle);
  return [...map.values()].sort((a, b) => a.time - b.time).slice(-5000);
}

function mergeTrades(left: Trade[], right: Trade[]): Trade[] {
  const map = new Map<string, Trade>();
  for (const trade of [...left, ...right]) map.set(trade.id, trade);
  return [...map.values()].sort((a, b) => a.exchangeTime - b.exchangeTime || (a.sequence ?? 0) - (b.sequence ?? 0)).slice(-MAX_LIVE_TRADES);
}

export function appendLiveTrade(trades: Trade[], seen: Set<string>, trade: Trade): boolean {
  if (seen.has(trade.id)) return false;
  seen.add(trade.id);
  trades.push(trade);
  if (trades.length > MAX_LIVE_TRADES + TRADE_TRIM_BATCH) {
    const removed = trades.splice(0, trades.length - MAX_LIVE_TRADES);
    for (const item of removed) seen.delete(item.id);
  }
  return true;
}

function latestSequence(trades: Trade[]): number | undefined {
  for (let index = trades.length - 1; index >= 0; index -= 1) {
    if (trades[index].sequence !== undefined) return trades[index].sequence;
  }
  return undefined;
}

function eventId(type: string, time: number, suffix = ""): string {
  return `${type}-${time}-${suffix}`;
}

function sequenceGap(trades: Trade[]): { time: number; detail: string } | undefined {
  const sequenced = trades.filter((trade) => trade.sequence !== undefined).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  for (let index = 1; index < sequenced.length; index += 1) {
    const previous = sequenced[index - 1].sequence ?? 0;
    const current = sequenced[index].sequence ?? 0;
    if (current > previous + 1) return { time: sequenced[index].exchangeTime, detail: `Aggregate-trade gap: expected ${previous + 1}, received ${current}` };
  }
  return undefined;
}

export interface EngineApi {
  state: MarketState;
  liveState: MarketState;
  replay: ReplayState;
  sessions: StoredSessionSummary[];
  telemetry: TelemetryBuffer;
  setMarket: (market: MarketKey) => void;
  setTimeframe: (timeframe: Timeframe) => void;
  enterReplay: () => void;
  exitReplay: () => void;
  setReplayCursor: (cursor: number) => void;
  toggleReplay: () => void;
  setReplaySpeed: (speed: number) => void;
  exportReplay: () => void;
  importReplay: (file: File) => Promise<void>;
  saveSession: (name?: string) => Promise<void>;
  openSession: (id: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  refreshSessions: () => Promise<void>;
  refresh: () => void;
}

export function useMarketEngine(): EngineApi {
  const [marketKey, setMarketKey] = useState<MarketKey>(() => validMarket(localStorage.getItem("vf-market")));
  const [timeframe, setTimeframeState] = useState<Timeframe>(() => validTimeframe(localStorage.getItem("vf-timeframe")));
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [liveState, setLiveState] = useState<MarketState>(() => initialState(marketKey, timeframe));
  const [replay, setReplay] = useState<ReplayState>({ mode: "live", playing: false, speed: 1, cursor: 0, events: [] });
  const [sessions, setSessions] = useState<StoredSessionSummary[]>([]);
  const modelRef = useRef(liveState);
  const recorderRef = useRef(new EventRecorder());
  const controllerRef = useRef<ProviderController | null>(null);
  const footprintRef = useRef(new FootprintAccumulator(MARKETS[marketKey], timeframe));
  const flushTimerRef = useRef<number | null>(null);
  const eventsThisSecondRef = useRef(0);
  const rateRef = useRef(0);
  const sessionStoreRef = useRef(defaultSessionStore());
  const captureStartedAtRef = useRef(Date.now());
  const pendingReplayRef = useRef<PendingReplay | null>(null);
  const telemetryRef = useRef(new TelemetryBuffer(10_000));
  const staleStartedRef = useRef<number | null>(null);
  const tradeIdsRef = useRef(new Set<string>());
  const lastSequenceRef = useRef<number | undefined>(undefined);
  const lastFlushAtRef = useRef(0);
  const lastAnalyticsAtRef = useRef(0);
  const lastFootprintSnapshotAtRef = useRef(0);
  const publicationDirtyRef = useRef(createPublicationDirty(true));
  const publishedCollectionsRef = useRef<PublishedCollections>(publishedCollectionsFromState(liveState));
  const autosaveInFlightRef = useRef(false);
  const lastAutosavedCountRef = useRef(0);

  const refreshSessions = useCallback(async () => {
    setSessions(await sessionStoreRef.current.list());
  }, []);

  const flush = useCallback(() => {
    if (flushTimerRef.current !== null) return;
    const elapsed = performance.now() - lastFlushAtRef.current;
    const delay = Math.max(0, UI_FLUSH_MS - elapsed);
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      const model = modelRef.current;
      const now = performance.now();
      const dirty = publicationDirtyRef.current;

      if (dirty.footprints || now - lastFootprintSnapshotAtRef.current >= FOOTPRINT_QUALITY_REFRESH_MS) {
        const footprint = footprintRef.current.snapshot();
        model.footprints = footprint.footprints;
        model.footprintCoverage = footprint.coverage;
        markPublicationDirty(dirty, { footprints: true });
        lastFootprintSnapshotAtRef.current = now;
      }
      if (now - lastAnalyticsAtRef.current >= ANALYTICS_INTERVAL_MS) {
        model.analytics = calculateAnalytics(model.candles, model.trades, model.book, model.market.quality);
        lastAnalyticsAtRef.current = now;
      }
      model.eventRate = rateRef.current;
      lastFlushAtRef.current = now;

      const collections = preparePublishedCollections(publishedCollectionsRef.current, model, dirty);
      publishedCollectionsRef.current = collections;
      publicationDirtyRef.current = createPublicationDirty(false);
      setLiveState({ ...model, ...collections });
    }, delay);
  }, []);

  useEffect(() => { void refreshSessions(); }, [refreshSessions]);

  useEffect(() => {
    let elapsed = 0;
    const interval = window.setInterval(() => {
      elapsed += STALE_CHECK_MS;
      if (elapsed >= 1_000) {
        rateRef.current = eventsThisSecondRef.current;
        eventsThisSecondRef.current = 0;
        elapsed = 0;
      }
      const current = modelRef.current;
      if (current.lastEventAt && Date.now() - current.lastEventAt > STALE_AFTER_MS && current.status === "live") {
        current.status = "stale";
        current.statusDetail = `No market event for ${Math.round((Date.now() - current.lastEventAt) / 1000)}s`;
        current.book = current.book ? { ...current.book, quality: "stale" } : null;
        staleStartedRef.current = Date.now();
        telemetryRef.current.record({ kind: "quality-transition", market: current.market.key, venue: current.market.venue, detail: current.statusDetail, tags: { to: "STALE" } });
        flush();
      }
    }, STALE_CHECK_MS);
    return () => window.clearInterval(interval);
  }, [flush]);

  useEffect(() => {
    localStorage.setItem("vf-market", marketKey);
    localStorage.setItem("vf-timeframe", timeframe);
    controllerRef.current?.close();
    const abort = new AbortController();
    const market = MARKETS[marketKey];
    const next = initialState(marketKey, timeframe);
    const initialCollections = preparePublishedCollections(
      publishedCollectionsFromState(next),
      next,
      createPublicationDirty(true),
    );
    captureStartedAtRef.current = Date.now();
    modelRef.current = next;
    publishedCollectionsRef.current = initialCollections;
    publicationDirtyRef.current = createPublicationDirty(true);
    lastFootprintSnapshotAtRef.current = 0;
    setLiveState({ ...next, ...initialCollections });
    footprintRef.current = new FootprintAccumulator(market, timeframe);
    recorderRef.current.reset(marketKey);
    tradeIdsRef.current.clear();
    lastSequenceRef.current = undefined;
    lastAnalyticsAtRef.current = 0;
    lastAutosavedCountRef.current = 0;
    setReplay({ mode: "live", playing: false, speed: 1, cursor: 0, events: [] });

    const record = (event: NormalizedEvent) => {
      recorderRef.current.append(event);
      eventsThisSecondRef.current += 1;
    };
    const touch = (exchangeTime: number) => {
      const model = modelRef.current;
      model.lastEventAt = exchangeTime;
      model.eventLagMs = Math.max(0, Date.now() - exchangeTime);
      if (model.status === "stale") {
        model.status = "live";
        model.statusDetail = "Market stream recovered";
        if (staleStartedRef.current !== null) {
          telemetryRef.current.record({ kind: "stale-duration", market: marketKey, venue: market.venue, value: Date.now() - staleStartedRef.current, unit: "ms" });
          staleStartedRef.current = null;
        }
      }
    };
    const status = (state: ConnectionState, detail: string) => {
      const model = modelRef.current;
      const now = Date.now();
      model.status = state;
      model.statusDetail = detail;
      record({ id: eventId("status", now, state), type: "status", market: marketKey, exchangeTime: now, receiveTime: now, payload: { state, detail } });
      if (state === "reconnecting") telemetryRef.current.record({ kind: "reconnect", market: marketKey, venue: market.venue, detail });
      if (state === "error") telemetryRef.current.record({ kind: "websocket-failure", market: marketKey, venue: market.venue, detail });
      if (detail.toLowerCase().includes("resync")) telemetryRef.current.record({ kind: "book-resync", market: marketKey, venue: market.venue, detail });
      flush();
    };

    void loadSnapshot(market, timeframe, abort.signal).then((snapshot) => {
      if (abort.signal.aborted) return;
      const model = modelRef.current;
      model.candles = mergeCandles(snapshot.candles, model.candles);
      model.trades = mergeTrades(snapshot.trades, model.trades);
      markPublicationDirty(publicationDirtyRef.current, { candles: true, trades: true, footprints: true });
      tradeIdsRef.current = new Set(model.trades.map((trade) => trade.id));
      lastSequenceRef.current = latestSequence(model.trades);
      model.book = snapshot.book ?? model.book;
      model.metrics = snapshot.metrics;
      model.status = "syncing";
      const serverFootprintCount = snapshot.footprints?.length ?? 0;
      model.statusDetail = serverFootprintCount
        ? `Historical snapshot and ${serverFootprintCount.toLocaleString()} server footprints loaded; synchronizing live stream`
        : `Historical snapshot and ${snapshot.trades.length.toLocaleString()} aggregate trades loaded; synchronizing live stream`;
      model.lastEventAt = Math.max(snapshot.tradeCoverage.endTime ?? 0, Date.now());
      footprintRef.current.reset(model.candles, model.trades, snapshot.tradeCoverage, Date.now(), snapshot.footprints ?? []);
      if (market.provider === "Binance") {
        const gap = sequenceGap(model.trades);
        if (gap) {
          footprintRef.current.markGap(gap.time, gap.detail);
          telemetryRef.current.record({ kind: "sequence-gap", market: marketKey, venue: market.venue, detail: gap.detail });
        }
      }
      for (const candle of snapshot.candles.slice(-500)) record({ id: eventId("candle", candle.time), type: "candle", market: marketKey, exchangeTime: candle.endTime, receiveTime: Date.now(), payload: candle });
      for (const trade of snapshot.trades) record({ id: eventId("trade", trade.exchangeTime, trade.id), type: "trade", market: marketKey, exchangeTime: trade.exchangeTime, receiveTime: trade.receiveTime, payload: trade });
      if (snapshot.book) record({ id: eventId("book", snapshot.book.exchangeTime, String(snapshot.book.sequence ?? "")), type: "book", market: marketKey, exchangeTime: snapshot.book.exchangeTime, receiveTime: snapshot.book.receiveTime, payload: snapshot.book });
      record({ id: eventId("metrics", snapshot.metrics.timestamp), type: "metrics", market: marketKey, exchangeTime: snapshot.metrics.timestamp, receiveTime: Date.now(), payload: snapshot.metrics });
      model.analytics = calculateAnalytics(model.candles, model.trades, model.book, model.market.quality);
      lastAnalyticsAtRef.current = performance.now();
      flush();
    }).catch((error) => {
      if (!abort.signal.aborted) status("error", error instanceof Error ? error.message : "Snapshot load failed");
    });

    controllerRef.current = streamMarket(market, timeframe, {
      onCandle: (candle) => {
        const model = modelRef.current;
        model.candles = mergeCandle(model.candles, candle);
        footprintRef.current.upsertCandle(candle);
        markPublicationDirty(publicationDirtyRef.current, { candles: true, footprints: true });
        touch(candle.endTime);
        record({ id: eventId("candle", candle.time), type: "candle", market: marketKey, exchangeTime: candle.endTime, receiveTime: Date.now(), payload: candle });
        flush();
      },
      onTrade: (trade: Trade) => {
        const model = modelRef.current;
        if (!appendLiveTrade(model.trades, tradeIdsRef.current, trade)) return;
        markPublicationDirty(publicationDirtyRef.current, { trades: true, footprints: true });
        if (market.provider === "Binance" && trade.sequence !== undefined) {
          const previous = lastSequenceRef.current;
          if (previous !== undefined && trade.sequence > previous + 1) {
            const detail = `Aggregate-trade gap: expected ${previous + 1}, received ${trade.sequence}`;
            footprintRef.current.markGap(trade.exchangeTime, detail);
            telemetryRef.current.record({ kind: "sequence-gap", market: marketKey, venue: market.venue, detail });
          }
          if (previous === undefined || trade.sequence > previous) lastSequenceRef.current = trade.sequence;
        }
        footprintRef.current.ingestTrade(trade);
        touch(trade.exchangeTime);
        record({ id: eventId("trade", trade.exchangeTime, trade.id), type: "trade", market: marketKey, exchangeTime: trade.exchangeTime, receiveTime: trade.receiveTime, payload: trade });
        flush();
      },
      onTradeGap: (exchangeTime, detail) => {
        footprintRef.current.markGap(exchangeTime, detail);
        markPublicationDirty(publicationDirtyRef.current, { footprints: true });
        const model = modelRef.current;
        const receiveTime = Date.now();
        model.statusDetail = detail;
        record({ id: eventId("gap", exchangeTime, detail), type: "status", market: marketKey, exchangeTime, receiveTime, payload: { state: model.status, detail } });
        telemetryRef.current.record({ kind: "sequence-gap", market: marketKey, venue: market.venue, detail });
        flush();
      },
      onBook: (book: OrderBook) => {
        const model = modelRef.current;
        model.book = book;
        touch(book.exchangeTime);
        record({ id: eventId("book", book.exchangeTime, String(book.sequence ?? "")), type: "book", market: marketKey, exchangeTime: book.exchangeTime, receiveTime: book.receiveTime, payload: book });
        flush();
      },
      onMetrics: (metrics) => {
        const model = modelRef.current;
        model.metrics = metrics;
        record({ id: eventId("metrics", metrics.timestamp), type: "metrics", market: marketKey, exchangeTime: metrics.timestamp, receiveTime: Date.now(), payload: metrics });
        flush();
      },
      onState: status,
    });

    const pending = pendingReplayRef.current;
    if (pending && pending.market === marketKey && pending.timeframe === timeframe) {
      const importer = new EventRecorder();
      const events = importer.importJson(pending.raw);
      recorderRef.current = importer;
      setReplay({ mode: "events", playing: false, speed: 1, cursor: Math.max(0, events.length - 1), events, importedName: pending.name });
      pendingReplayRef.current = null;
    }

    return () => {
      abort.abort();
      controllerRef.current?.close();
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
    };
  }, [marketKey, timeframe, refreshNonce, flush]);

  useEffect(() => {
    let disposed = false;
    const persist = () => {
      if (disposed || replay.mode !== "live" || autosaveInFlightRef.current) return;
      const eventCount = recorderRef.current.eventCount;
      if (!eventCount || eventCount === lastAutosavedCountRef.current) return;
      autosaveInFlightRef.current = true;
      const events = recorderRef.current.snapshot();
      const session = createStoredSession(`Autosave · ${MARKETS[marketKey].displayName} · ${timeframe}`, MARKETS[marketKey], timeframe, events, captureStartedAtRef.current);
      session.id = `autosave-${marketKey}-${timeframe}`;
      session.updatedAt = Date.now();
      void sessionStoreRef.current.put(session).then(async () => {
        lastAutosavedCountRef.current = eventCount;
        await refreshSessions();
      }).catch((error) => {
        telemetryRef.current.record({ kind: "api-failure", market: marketKey, venue: MARKETS[marketKey].venue, detail: `Session autosave failed: ${error instanceof Error ? error.message : String(error)}` });
      }).finally(() => {
        autosaveInFlightRef.current = false;
      });
    };
    const schedulePersist = () => {
      const idleWindow = window as Window & { requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number };
      if (typeof idleWindow.requestIdleCallback === "function") idleWindow.requestIdleCallback(() => persist(), { timeout: AUTOSAVE_IDLE_TIMEOUT_MS });
      else window.setTimeout(persist, 0);
    };
    const timer = window.setInterval(schedulePersist, AUTOSAVE_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [marketKey, timeframe, replay.mode, refreshSessions]);

  useEffect(() => {
    if (replay.mode !== "events" || !replay.playing || replay.events.length === 0) return;
    const interval = window.setInterval(() => {
      setReplay((current) => {
        const step = Math.max(1, Math.round(current.speed * 3));
        const cursor = Math.min(current.events.length - 1, current.cursor + step);
        return { ...current, cursor, playing: cursor < current.events.length - 1 };
      });
    }, 100);
    return () => window.clearInterval(interval);
  }, [replay.mode, replay.playing, replay.events.length]);

  const displayState = useMemo(() => {
    if (replay.mode === "live") return liveState;
    const started = performance.now();
    const reduced = reduceReplay(liveState, replay);
    const state: MarketState = {
      ...liveState,
      ...reduced,
      statusDetail: replay.importedName ? `Replay: ${replay.importedName}` : "Recorded session replay",
    };
    const firstTrade = state.trades[0]?.exchangeTime;
    const lastTrade = state.trades.at(-1)?.exchangeTime;
    const replayGap = state.market.provider === "Binance" ? sequenceGap(state.trades) : undefined;
    const footprint = buildFootprints(
      state.market,
      state.timeframe,
      state.candles,
      state.trades,
      {
        source: "replay",
        startTime: firstTrade,
        endTime: lastTrade,
        contiguous: replayGap === undefined,
        eventCount: state.trades.length,
        detail: replayGap?.detail ?? "Rebuilt from replay trade events",
      },
      lastTrade ?? Date.now(),
      true,
    );
    state.footprints = footprint.footprints;
    state.footprintCoverage = footprint.coverage;
    state.analytics = calculateAnalytics(state.candles, state.trades, state.book, state.market.quality);
    telemetryRef.current.record({ kind: "replay-seek", market: state.market.key, venue: state.market.venue, value: performance.now() - started, unit: "ms", tags: { cursor: replay.cursor } });
    return state;
  }, [liveState, replay]);

  const setMarket = useCallback((value: MarketKey) => setMarketKey(value), []);
  const setTimeframe = useCallback((value: Timeframe) => setTimeframeState(value), []);
  const enterReplay = useCallback(() => {
    const events = recorderRef.current.snapshot();
    setReplay((current) => ({ ...current, mode: "events", playing: false, events, cursor: Math.max(0, events.length - 1) }));
  }, []);
  const exitReplay = useCallback(() => setReplay((current) => ({ ...current, mode: "live", playing: false })), []);
  const setReplayCursor = useCallback((cursor: number) => setReplay((current) => ({ ...current, cursor: Math.max(0, Math.min(current.events.length - 1, cursor)), playing: false })), []);
  const toggleReplay = useCallback(() => setReplay((current) => ({ ...current, playing: !current.playing })), []);
  const setReplaySpeed = useCallback((speed: number) => setReplay((current) => ({ ...current, speed })), []);
  const refresh = useCallback(() => setRefreshNonce((value) => value + 1), []);

  const exportReplay = useCallback(() => {
    const raw = recorderRef.current.exportJson(MARKETS[marketKey], timeframe);
    const blob = new Blob([raw], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `veilflow-${marketKey}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [marketKey, timeframe]);

  const activateRawReplay = useCallback((raw: string, name: string) => {
    const metadata = JSON.parse(raw) as { market?: { key?: MarketKey }; timeframe?: Timeframe; events?: NormalizedEvent[] };
    const targetMarket = metadata.market?.key ?? metadata.events?.[0]?.market ?? marketKey;
    const targetTimeframe = validTimeframe(metadata.timeframe ?? timeframe);
    if (!(targetMarket in MARKETS)) throw new Error(`Unsupported replay market ${targetMarket}`);
    if (targetMarket !== marketKey || targetTimeframe !== timeframe) {
      pendingReplayRef.current = { raw, name, market: targetMarket, timeframe: targetTimeframe };
      setMarketKey(targetMarket);
      setTimeframeState(targetTimeframe);
      return;
    }
    const importer = new EventRecorder();
    const events = importer.importJson(raw);
    recorderRef.current = importer;
    setReplay({ mode: "events", playing: false, speed: 1, cursor: Math.max(0, events.length - 1), events, importedName: name });
  }, [marketKey, timeframe]);

  const importReplay = useCallback(async (file: File) => activateRawReplay(await file.text(), file.name), [activateRawReplay]);

  const saveSession = useCallback(async (name?: string) => {
    const events = recorderRef.current.snapshot();
    if (!events.length) throw new Error("No normalized events are available to save");
    const session = createStoredSession(name ?? `${MARKETS[marketKey].displayName} ${timeframe}`, MARKETS[marketKey], timeframe, events, captureStartedAtRef.current);
    await sessionStoreRef.current.put(session);
    await refreshSessions();
  }, [marketKey, timeframe, refreshSessions]);

  const openSession = useCallback(async (id: string) => {
    const session = await sessionStoreRef.current.get(id);
    if (!session) throw new Error(`Session ${id} was not found`);
    activateRawReplay(JSON.stringify(session.archive), session.name);
  }, [activateRawReplay]);

  const deleteSession = useCallback(async (id: string) => {
    await sessionStoreRef.current.delete(id);
    await refreshSessions();
  }, [refreshSessions]);

  return {
    state: displayState,
    liveState,
    replay,
    sessions,
    telemetry: telemetryRef.current,
    setMarket,
    setTimeframe,
    enterReplay,
    exitReplay,
    setReplayCursor,
    toggleReplay,
    setReplaySpeed,
    exportReplay,
    importReplay,
    saveSession,
    openSession,
    deleteSession,
    refreshSessions,
    refresh,
  };
}
