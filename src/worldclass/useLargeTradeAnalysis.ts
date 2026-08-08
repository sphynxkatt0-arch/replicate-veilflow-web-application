import { useEffect, useRef, useState } from "react";
import { detectLargeTrades } from "./analytics";
import type { LargeTrade, Trade } from "./types";

export interface LargeTradeAnalysis {
  threshold: number;
  events: LargeTrade[];
}

interface LargeTradeWorkerResponse {
  requestId: number;
  result: LargeTradeAnalysis;
}

const MAX_WORKER_TRADES = 3_000;
const WORKER_INTERVAL_MS = 250;

export function recentLargeTradeInput(trades: Trade[], limit = MAX_WORKER_TRADES): Trade[] {
  return trades.length <= limit ? trades : trades.slice(-limit);
}

export function useLargeTradeAnalysis(trades: Trade[], absoluteFloor: number): LargeTradeAnalysis {
  const [result, setResult] = useState<LargeTradeAnalysis>(() => detectLargeTrades(recentLargeTradeInput(trades), absoluteFloor));
  const workerRef = useRef<Worker | null>(null);
  const timerRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);
  const latestAcceptedRef = useRef(0);
  const lastSentAtRef = useRef(0);
  const latestRef = useRef({ trades: recentLargeTradeInput(trades), absoluteFloor });

  useEffect(() => {
    if (typeof Worker === "undefined") return;
    let worker: Worker | null = null;
    try {
      worker = new Worker(new URL("./largeTrade.worker.ts", import.meta.url), { type: "module" });
      workerRef.current = worker;
      worker.addEventListener("message", (event: MessageEvent<LargeTradeWorkerResponse>) => {
        const { requestId, result: next } = event.data;
        if (requestId < latestAcceptedRef.current) return;
        latestAcceptedRef.current = requestId;
        setResult(next);
      });
    } catch {
      workerRef.current = null;
    }
    return () => {
      workerRef.current = null;
      worker?.terminate();
    };
  }, []);

  useEffect(() => {
    latestRef.current = { trades: recentLargeTradeInput(trades), absoluteFloor };
    if (timerRef.current !== null) return;
    const elapsed = performance.now() - lastSentAtRef.current;
    const delay = Math.max(0, WORKER_INTERVAL_MS - elapsed);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      lastSentAtRef.current = performance.now();
      const input = latestRef.current;
      const requestId = ++requestIdRef.current;
      const worker = workerRef.current;
      if (worker) {
        worker.postMessage({ requestId, trades: input.trades, absoluteFloor: input.absoluteFloor });
        return;
      }

      const calculate = () => {
        if (requestId < latestAcceptedRef.current) return;
        latestAcceptedRef.current = requestId;
        setResult(detectLargeTrades(input.trades, input.absoluteFloor));
      };
      const idleWindow = window as Window & { requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number };
      if (typeof idleWindow.requestIdleCallback === "function") idleWindow.requestIdleCallback(calculate, { timeout: WORKER_INTERVAL_MS });
      else window.setTimeout(calculate, 0);
    }, delay);
  }, [trades, absoluteFloor]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  return result;
}
