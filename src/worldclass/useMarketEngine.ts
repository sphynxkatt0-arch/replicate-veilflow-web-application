import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { calculateAnalytics } from "./analytics";
import { MARKETS } from "./markets";
import { loadSnapshot, streamMarket, type ProviderController } from "./providers";
import { EventRecorder, reduceReplay } from "./recorder";
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

function initialState(marketKey: MarketKey, timeframe: Timeframe): MarketState {
  const market = MARKETS[marketKey];
  return {
    market,
    timeframe,
    candles: [],
    trades: [],
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
  const index = candles.findIndex((item) => item.time === candle.time);
  if (index >= 0) {
    const next = candles.slice();
    next[index] = candle;
    return next;
  }
  return [...candles, candle].sort((a, b) => a.time - b.time).slice(-5000);
}

function eventId(type: string, time: number, suffix = ""): string {
  return `${type}-${time}-${suffix}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface EngineApi {
  state: MarketState;
  liveState: MarketState;
  replay: ReplayState;
  setMarket: (market: MarketKey) => void;
  setTimeframe: (timeframe: Timeframe) => void;
  enterReplay: () => void;
  exitReplay: () => void;
  setReplayCursor: (cursor: number) => void;
  toggleReplay: () => void;
  setReplaySpeed: (speed: number) => void;
  exportReplay: () => void;
  importReplay: (file: File) => Promise<void>;
  refresh: () => void;
}

export function useMarketEngine(): EngineApi {
  const [marketKey, setMarketKey] = useState<MarketKey>(() => (localStorage.getItem("vf-market") as MarketKey) || "BTC");
  const [timeframe, setTimeframeState] = useState<Timeframe>(() => (localStorage.getItem("vf-timeframe") as Timeframe) || "5m");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [liveState, setLiveState] = useState<MarketState>(() => initialState(marketKey, timeframe));
  const [replay, setReplay] = useState<ReplayState>({ mode: "live", playing: false, speed: 1, cursor: 0, events: [] });
  const modelRef = useRef(liveState);
  const recorderRef = useRef(new EventRecorder());
  const controllerRef = useRef<ProviderController | null>(null);
  const flushTimerRef = useRef<number | null>(null);
  const eventsThisSecondRef = useRef(0);
  const rateRef = useRef(0);

  const flush = useCallback(() => {
    if (flushTimerRef.current !== null) return;
    flushTimerRef.current = window.setTimeout(() => {
      flushTimerRef.current = null;
      const model = modelRef.current;
      model.analytics = calculateAnalytics(model.candles, model.trades, model.book, model.market.quality);
      model.eventRate = rateRef.current;
      setLiveState({ ...model, candles: model.candles.slice(), trades: model.trades.slice(), analytics: { ...model.analytics } });
    }, 80);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      rateRef.current = eventsThisSecondRef.current;
      eventsThisSecondRef.current = 0;
      const current = modelRef.current;
      if (current.lastEventAt && Date.now() - current.lastEventAt > 8_000 && current.status === "live") {
        current.status = "stale";
        current.statusDetail = `No market event for ${Math.round((Date.now() - current.lastEventAt) / 1000)}s`;
        current.book = current.book ? { ...current.book, quality: "stale" } : null;
        flush();
      }
    }, 1000);
    return () => window.clearInterval(interval);
  }, [flush]);

  useEffect(() => {
    localStorage.setItem("vf-market", marketKey);
    localStorage.setItem("vf-timeframe", timeframe);
    controllerRef.current?.close();
    const abort = new AbortController();
    const market = MARKETS[marketKey];
    const next = initialState(marketKey, timeframe);
    modelRef.current = next;
    setLiveState(next);
    recorderRef.current.reset(marketKey);
    setReplay({ mode: "live", playing: false, speed: 1, cursor: 0, events: [] });

    const record = (event: NormalizedEvent) => {
      recorderRef.current.append(event);
      eventsThisSecondRef.current += 1;
    };
    const touch = (exchangeTime: number) => {
      const model = modelRef.current;
      model.lastEventAt = Date.now();
      model.eventLagMs = Math.max(0, Date.now() - exchangeTime);
      if (model.status === "stale") { model.status = "live"; model.statusDetail = "Market stream recovered"; }
    };
    const status = (state: ConnectionState, detail: string) => {
      const model = modelRef.current;
      model.status = state;
      model.statusDetail = detail;
      record({ id: eventId("status", Date.now()), type: "status", market: marketKey, exchangeTime: Date.now(), receiveTime: Date.now(), payload: { state, detail } });
      flush();
    };

    void loadSnapshot(market, timeframe, abort.signal).then((snapshot) => {
      if (abort.signal.aborted) return;
      const model = modelRef.current;
      model.candles = snapshot.candles;
      model.book = snapshot.book;
      model.metrics = snapshot.metrics;
      model.status = "syncing";
      model.statusDetail = "Historical snapshot loaded; waiting for live synchronization";
      model.lastEventAt = Date.now();
      for (const candle of snapshot.candles.slice(-500)) {
        record({ id: eventId("candle", candle.time), type: "candle", market: marketKey, exchangeTime: candle.endTime, receiveTime: Date.now(), payload: candle });
      }
      if (snapshot.book) record({ id: eventId("book", snapshot.book.exchangeTime), type: "book", market: marketKey, exchangeTime: snapshot.book.exchangeTime, receiveTime: snapshot.book.receiveTime, payload: snapshot.book });
      record({ id: eventId("metrics", snapshot.metrics.timestamp), type: "metrics", market: marketKey, exchangeTime: snapshot.metrics.timestamp, receiveTime: Date.now(), payload: snapshot.metrics });
      flush();
    }).catch((error) => {
      if (!abort.signal.aborted) status("error", error instanceof Error ? error.message : "Snapshot load failed");
    });

    controllerRef.current = streamMarket(market, timeframe, {
      onCandle: (candle) => {
        const model = modelRef.current;
        model.candles = mergeCandle(model.candles, candle);
        touch(candle.endTime);
        record({ id: eventId("candle", candle.time), type: "candle", market: marketKey, exchangeTime: candle.endTime, receiveTime: Date.now(), payload: candle });
        flush();
      },
      onTrade: (trade: Trade) => {
        const model = modelRef.current;
        if (model.trades.some((item) => item.id === trade.id)) return;
        model.trades = [...model.trades, trade].slice(-3000);
        touch(trade.exchangeTime);
        record({ id: eventId("trade", trade.exchangeTime, trade.id), type: "trade", market: marketKey, exchangeTime: trade.exchangeTime, receiveTime: trade.receiveTime, payload: trade });
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

    return () => {
      abort.abort();
      controllerRef.current?.close();
      if (flushTimerRef.current !== null) window.clearTimeout(flushTimerRef.current);
    };
  }, [marketKey, timeframe, refreshNonce, flush]);

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
    const reduced = reduceReplay(liveState, replay);
    const state = { ...liveState, ...reduced, statusDetail: replay.importedName ? `Replay: ${replay.importedName}` : "Recorded session replay" };
    state.analytics = calculateAnalytics(state.candles, state.trades, state.book, state.market.quality);
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

  const importReplay = useCallback(async (file: File) => {
    const events = recorderRef.current.importJson(await file.text());
    setReplay({ mode: "events", playing: false, speed: 1, cursor: Math.max(0, events.length - 1), events, importedName: file.name });
  }, []);

  return { state: displayState, liveState, replay, setMarket, setTimeframe, enterReplay, exitReplay, setReplayCursor, toggleReplay, setReplaySpeed, exportReplay, importReplay, refresh };
}
