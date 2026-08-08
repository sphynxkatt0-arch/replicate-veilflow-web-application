import type {
  Candle,
  FootprintCandle,
  FootprintCoverage,
  FootprintQuality,
  FootprintRow,
  MarketDefinition,
  Timeframe,
} from "./types";

export interface CollectorManifest {
  id: string;
  status?: string;
  venue?: string;
  venueSymbol?: string;
  symbol?: string;
  productType?: string;
  startTime?: number;
  endTime?: number;
  requestedStartTime?: number;
  requestedEndTime?: number;
  updatedAt?: number;
  eventCount?: number;
}

interface CollectorFootprintResponse {
  sessionId?: string;
  footprintCount?: number;
  outputHash?: string;
  coverage?: {
    requestedStartTime?: number;
    requestedEndTime?: number;
    availableStartTime?: number;
    availableEndTime?: number;
    firstSequence?: string | number;
    lastSequence?: string | number;
    eventCount?: number;
    footprintCount?: number;
    contiguous?: boolean;
    quality?: string;
  };
  footprints?: unknown[];
  cache?: { state?: string; key?: string };
}

export interface CollectorFootprintSnapshot {
  footprints: FootprintCandle[];
  coverage: FootprintCoverage;
  sessionId: string;
  outputHash?: string;
  cacheState?: string;
}

function collectorBaseUrl(): string | undefined {
  const meta = import.meta as ImportMeta & { env?: Record<string, string | undefined> };
  const configured = meta.env?.VITE_VEILFLOW_COLLECTOR_API
    ?? (typeof localStorage !== "undefined" ? localStorage.getItem("vf-collector-api") ?? undefined : undefined);
  const normalized = configured?.trim().replace(/\/+$/, "");
  return normalized || undefined;
}

function finite(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalFinite(value: unknown): number | undefined {
  const parsed = finite(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function quality(value: unknown): FootprintQuality {
  const normalized = String(value ?? "").trim().replaceAll("_", " ").replaceAll("-", " ").toUpperCase();
  if (normalized === "FULL") return "full";
  if (normalized === "LIVE PARTIAL") return "live-partial";
  if (normalized === "AGGREGATE ONLY") return "aggregate-only";
  if (normalized === "GAPPED") return "gapped";
  if (normalized === "REPLAY FULL") return "replay-full";
  return "aggregate-only";
}

function row(value: unknown): FootprintRow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const price = finite(source.price, Number.NaN);
  if (!Number.isFinite(price)) return undefined;
  const bidVolume = Math.max(0, finite(source.bidVolume));
  const askVolume = Math.max(0, finite(source.askVolume));
  return {
    price,
    bidVolume,
    askVolume,
    totalVolume: Math.max(0, finite(source.totalVolume, bidVolume + askVolume)),
    delta: finite(source.delta, askVolume - bidVolume),
    tradeCount: Math.max(0, Math.trunc(finite(source.tradeCount))),
    bidTrades: Math.max(0, Math.trunc(finite(source.bidTrades))),
    askTrades: Math.max(0, Math.trunc(finite(source.askTrades))),
    bidImbalance: source.bidImbalance === true,
    askImbalance: source.askImbalance === true,
    stackedBid: source.stackedBid === true,
    stackedAsk: source.stackedAsk === true,
    inValueArea: source.inValueArea === true,
  };
}

function footprint(value: unknown): FootprintCandle | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const time = finite(source.time, Number.NaN);
  const endTime = finite(source.endTime, Number.NaN);
  const priceStep = finite(source.priceStep, Number.NaN);
  if (!Number.isFinite(time) || !Number.isFinite(endTime) || !Number.isFinite(priceStep) || priceStep <= 0 || !Array.isArray(source.rows)) return undefined;
  const rows = source.rows.map(row).filter((item): item is FootprintRow => item !== undefined);
  const totalBidVolume = Math.max(0, finite(source.totalBidVolume, rows.reduce((sum, item) => sum + item.bidVolume, 0)));
  const totalAskVolume = Math.max(0, finite(source.totalAskVolume, rows.reduce((sum, item) => sum + item.askVolume, 0)));
  const optional = (input: unknown) => {
    const parsed = finite(input, Number.NaN);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    time,
    endTime,
    rows,
    totalBidVolume,
    totalAskVolume,
    totalVolume: Math.max(0, finite(source.totalVolume, totalBidVolume + totalAskVolume)),
    delta: finite(source.delta, totalAskVolume - totalBidVolume),
    maxDelta: finite(source.maxDelta),
    minDelta: finite(source.minDelta),
    tradeCount: Math.max(0, Math.trunc(finite(source.tradeCount, rows.reduce((sum, item) => sum + item.tradeCount, 0)))),
    pocPrice: optional(source.pocPrice),
    valueAreaHigh: optional(source.valueAreaHigh),
    valueAreaLow: optional(source.valueAreaLow),
    coverageRatio: optional(source.coverageRatio),
    quality: quality(source.quality),
    priceStep,
  };
}

async function fetchCollector<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: "no-store", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Collector ${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

export function collectorManifestMatchesMarket(manifest: CollectorManifest, market: MarketDefinition): boolean {
  const expectedProduct = market.productType === "perpetual-proxy" ? "perpetual" : market.productType;
  const venueMatches = String(manifest.venue ?? "").trim().toLowerCase() === market.provider.toLowerCase();
  const symbolMatches = String(manifest.venueSymbol ?? "").toUpperCase() === market.providerSymbol.toUpperCase();
  const productMatches = String(manifest.productType ?? "") === expectedProduct;
  return venueMatches && symbolMatches && productMatches;
}

function overlap(manifest: CollectorManifest, startTime: number, endTime: number): number {
  const start = finite(manifest.startTime ?? manifest.requestedStartTime, Number.NEGATIVE_INFINITY);
  const end = finite(manifest.endTime ?? manifest.requestedEndTime, Number.POSITIVE_INFINITY);
  return Math.max(0, Math.min(end, endTime) - Math.max(start, startTime));
}

export async function loadCollectorFootprints(
  market: MarketDefinition,
  timeframe: Timeframe,
  candles: Candle[],
  signal?: AbortSignal,
): Promise<CollectorFootprintSnapshot | undefined> {
  const base = collectorBaseUrl();
  if (!base || !candles.length) return undefined;

  try {
    const requestedStart = candles[0].time;
    const requestedEnd = candles.at(-1)?.endTime ?? Date.now();
    const catalogue = await fetchCollector<{ sessions?: CollectorManifest[] }>(`${base}/sessions`, signal);
    const sessions = (catalogue.sessions ?? [])
      .filter((item) => item.status === "complete" && collectorManifestMatchesMarket(item, market) && overlap(item, requestedStart, requestedEnd) > 0)
      .sort((left, right) => {
        const coverage = overlap(right, requestedStart, requestedEnd) - overlap(left, requestedStart, requestedEnd);
        return coverage || finite(right.updatedAt) - finite(left.updatedAt);
      });
    const selected = sessions[0];
    if (!selected) return undefined;

    const startTime = Math.max(requestedStart, finite(selected.startTime ?? selected.requestedStartTime, requestedStart));
    const endTime = Math.min(requestedEnd, finite(selected.endTime ?? selected.requestedEndTime, requestedEnd));
    if (endTime < startTime) return undefined;

    const query = new URLSearchParams({
      timeframe,
      tickSize: String(market.tickSize),
      startTime: String(startTime),
      endTime: String(endTime),
      imbalanceRatio: String(market.footprintImbalanceRatio),
      minVolume: String(market.footprintMinVolume),
    });
    const response = await fetchCollector<CollectorFootprintResponse>(`${base}/sessions/${encodeURIComponent(selected.id)}/footprints?${query}`, signal);
    const footprints = (response.footprints ?? []).map(footprint).filter((item): item is FootprintCandle => item !== undefined);
    if (!footprints.length) return undefined;

    const coverageQuality = quality(response.coverage?.quality);
    const availableStart = finite(response.coverage?.availableStartTime, footprints[0].time);
    const availableEnd = finite(response.coverage?.availableEndTime, footprints.at(-1)?.endTime ?? availableStart);
    const eventCount = Math.max(0, Math.trunc(finite(response.coverage?.eventCount, footprints.reduce((sum, item) => sum + item.tradeCount, 0))));
    const cacheState = response.cache?.state;
    return {
      footprints,
      sessionId: response.sessionId ?? selected.id,
      outputHash: response.outputHash,
      cacheState,
      coverage: {
        quality: coverageQuality,
        source: "collector-api",
        startTime: availableStart,
        endTime: availableEnd,
        startSequence: optionalFinite(response.coverage?.firstSequence),
        endSequence: optionalFinite(response.coverage?.lastSequence),
        contiguous: response.coverage?.contiguous !== false && coverageQuality !== "gapped",
        eventCount,
        detail: `Server footprints · ${footprints.length.toLocaleString()} candles · ${eventCount.toLocaleString()} executions${cacheState ? ` · cache ${cacheState}` : ""}`,
      },
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

export function collectorConfigured(): boolean {
  return collectorBaseUrl() !== undefined;
}
