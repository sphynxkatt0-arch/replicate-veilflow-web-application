import { useEffect, useMemo, useRef, useState } from "react";
import { collectorConfigured, loadCollectorFootprints, type CollectorFootprintRange } from "./collectorClient";
import type { Candle, FootprintCandle, MarketState } from "./types";

const RANGE_DEBOUNCE_MS = 120;
const MAX_VIEWPORT_FOOTPRINTS = 800;

export interface ViewportFootprintState {
  footprints: FootprintCandle[];
  status: "idle" | "loading" | "ready" | "unavailable";
  loadedRanges: CollectorFootprintRange[];
}

export function viewportRequestRange(candles: Candle[], visible: Candle[]): CollectorFootprintRange | undefined {
  if (!candles.length || !visible.length) return undefined;
  const firstTime = visible[0].time;
  const lastTime = visible.at(-1)!.time;
  const firstIndex = candles.findIndex((candle) => candle.time === firstTime);
  const lastIndex = candles.findIndex((candle) => candle.time === lastTime);
  if (firstIndex < 0 || lastIndex < firstIndex) return undefined;
  const visibleCount = Math.max(1, lastIndex - firstIndex + 1);
  const bufferedStart = Math.max(0, firstIndex - visibleCount);
  const bufferedEnd = Math.min(candles.length - 1, lastIndex + Math.ceil(visibleCount * 0.5));
  return {
    startTime: candles[bufferedStart].time,
    endTime: candles[bufferedEnd].endTime,
  };
}

export function rangeCovered(ranges: CollectorFootprintRange[], target: CollectorFootprintRange): boolean {
  return ranges.some((range) => range.startTime <= target.startTime && range.endTime >= target.endTime);
}

export function mergeRanges(ranges: CollectorFootprintRange[], next: CollectorFootprintRange): CollectorFootprintRange[] {
  const ordered = [...ranges, next]
    .filter((range) => Number.isFinite(range.startTime) && Number.isFinite(range.endTime) && range.endTime >= range.startTime)
    .sort((left, right) => left.startTime - right.startTime);
  const merged: CollectorFootprintRange[] = [];
  for (const range of ordered) {
    const previous = merged.at(-1);
    if (!previous || range.startTime > previous.endTime + 1) merged.push({ ...range });
    else previous.endTime = Math.max(previous.endTime, range.endTime);
  }
  return merged;
}

export function mergeViewportFootprints(
  current: FootprintCandle[],
  incoming: FootprintCandle[],
  focus: CollectorFootprintRange,
  limit = MAX_VIEWPORT_FOOTPRINTS,
): FootprintCandle[] {
  const byTime = new Map<number, FootprintCandle>();
  for (const footprint of current) byTime.set(footprint.time, footprint);
  for (const footprint of incoming) byTime.set(footprint.time, footprint);
  const rows = [...byTime.values()];
  if (rows.length <= limit) return rows.sort((left, right) => left.time - right.time);
  const center = (focus.startTime + focus.endTime) / 2;
  return rows
    .sort((left, right) => Math.abs(left.time - center) - Math.abs(right.time - center))
    .slice(0, limit)
    .sort((left, right) => left.time - right.time);
}

export function useViewportFootprints(state: MarketState, visible: Candle[], enabled: boolean): ViewportFootprintState {
  const [footprints, setFootprints] = useState<FootprintCandle[]>([]);
  const [status, setStatus] = useState<ViewportFootprintState["status"]>("idle");
  const [loadedRanges, setLoadedRanges] = useState<CollectorFootprintRange[]>([]);
  const loadedRangesRef = useRef<CollectorFootprintRange[]>([]);
  const timerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const unavailableKeyRef = useRef<string | null>(null);
  const generationRef = useRef(0);

  const requested = useMemo(() => viewportRequestRange(state.candles, visible), [state.candles, visible]);

  useEffect(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setFootprints([]);
    unavailableKeyRef.current = null;
    const initial = state.footprintCoverage.source === "collector-api" && state.footprintCoverage.startTime !== undefined && state.footprintCoverage.endTime !== undefined
      ? [{ startTime: state.footprintCoverage.startTime, endTime: state.footprintCoverage.endTime }]
      : [];
    loadedRangesRef.current = initial;
    setLoadedRanges(initial);
    setStatus(initial.length ? "ready" : "idle");
  }, [state.market.key, state.timeframe]);

  useEffect(() => {
    if (!enabled || !requested || !collectorConfigured()) return;
    if (rangeCovered(loadedRangesRef.current, requested)) {
      setStatus("ready");
      return;
    }
    const key = `${state.market.key}:${state.timeframe}:${requested.startTime}:${requested.endTime}`;
    if (unavailableKeyRef.current === key) return;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    const generation = generationRef.current;
    setStatus("loading");
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      void loadCollectorFootprints(state.market, state.timeframe, state.candles, controller.signal, requested).then((snapshot) => {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        if (!snapshot) {
          unavailableKeyRef.current = key;
          setStatus("unavailable");
          return;
        }
        unavailableKeyRef.current = null;
        setFootprints((current) => mergeViewportFootprints(current, snapshot.footprints, requested));
        const available = {
          startTime: snapshot.coverage.startTime ?? requested.startTime,
          endTime: snapshot.coverage.endTime ?? requested.endTime,
        };
        const nextRanges = mergeRanges(loadedRangesRef.current, available);
        loadedRangesRef.current = nextRanges;
        setLoadedRanges(nextRanges);
        setStatus("ready");
      }).catch((error) => {
        if (controller.signal.aborted || generation !== generationRef.current) return;
        console.warn("Viewport footprint request failed", error);
        unavailableKeyRef.current = key;
        setStatus("unavailable");
      });
    }, RANGE_DEBOUNCE_MS);

    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [enabled, requested?.startTime, requested?.endTime, state.candles, state.market, state.timeframe]);

  useEffect(() => () => {
    abortRef.current?.abort();
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return { footprints, status, loadedRanges };
}
