import type { DataQuality, FootprintCandle, FootprintQuality, ProductType } from "./types";

export type CanonicalQuality =
  | "FULL"
  | "LIVE PARTIAL"
  | "AGGREGATE ONLY"
  | "GAPPED"
  | "STALE"
  | "REPLAY FULL"
  | "UNAVAILABLE";

export interface MetricProvenance {
  venue: string;
  productType: ProductType;
  symbol: string;
  venueSymbol: string;
  sourceTimestamp: number;
  receiveTimestamp: number;
  dataAgeMs: number;
  quality: CanonicalQuality;
  calculationId: string;
  calculationVersion: string;
  completeness: number;
  reconciliation?: ReconciliationResult;
  detail?: string;
}

export interface ReconciliationResult {
  derivedVolume: number;
  sourceVolume: number;
  ratio?: number;
  difference: number;
  tolerance: number;
  passed: boolean;
}

export interface QualityTransition {
  at: number;
  from: CanonicalQuality;
  to: CanonicalQuality;
  reason: string;
  evidence?: string;
}

export interface VenueDefinition {
  id: "binance" | "coinbase" | "bybit" | "okx" | "hyperliquid" | "deribit";
  name: string;
  products: readonly ("spot" | "perpetual" | "options")[];
  trades: boolean;
  depth: boolean;
  funding: boolean;
  openInterest: boolean;
  liquidations: boolean;
  disclosure: string;
}

export const VENUES: readonly VenueDefinition[] = [
  { id: "binance", name: "Binance", products: ["spot", "perpetual"], trades: true, depth: true, funding: true, openInterest: true, liquidations: true, disclosure: "Crypto spot and USDⓈ-M perpetual market data; not CME futures." },
  { id: "coinbase", name: "Coinbase", products: ["spot"], trades: true, depth: true, funding: false, openInterest: false, liquidations: false, disclosure: "Crypto spot market data." },
  { id: "bybit", name: "Bybit", products: ["spot", "perpetual"], trades: true, depth: true, funding: true, openInterest: true, liquidations: true, disclosure: "Crypto spot and perpetual market data; not regulated futures." },
  { id: "okx", name: "OKX", products: ["spot", "perpetual", "options"], trades: true, depth: true, funding: true, openInterest: true, liquidations: true, disclosure: "Crypto spot, derivatives, and options market data; not CME futures." },
  { id: "hyperliquid", name: "Hyperliquid", products: ["perpetual"], trades: true, depth: true, funding: true, openInterest: true, liquidations: true, disclosure: "On-chain crypto perpetual data; not a regulated futures contract." },
  { id: "deribit", name: "Deribit", products: ["spot", "perpetual", "options"], trades: true, depth: true, funding: true, openInterest: true, liquidations: true, disclosure: "Crypto derivatives and options market data; not CME futures." },
] as const;

export interface MethodologyDefinition {
  id: string;
  version: string;
  title: string;
  formula: string;
  inputs: readonly string[];
  limitations: string;
}

export const METHODOLOGY: readonly MethodologyDefinition[] = [
  { id: "aggressor-side", version: "1.0.0", title: "Aggressor-side classification", formula: "Exchange maker flag when supplied; otherwise quote test, then tick rule.", inputs: ["trade price", "maker flag", "best bid", "best ask", "previous trade"], limitations: "Quote-test fallback can be ambiguous inside the spread." },
  { id: "footprint-row", version: "1.1.0", title: "Footprint row grouping", formula: "price bucket = round(price / rowStep) × rowStep", inputs: ["trade price", "tick size", "configured row step"], limitations: "Display regrouping must preserve bid, ask, total volume, and delta." },
  { id: "candle-reconciliation", version: "1.0.0", title: "Footprint reconciliation", formula: "Σ(row bid + row ask) / source candle volume", inputs: ["price-level trades", "source candle volume"], limitations: "A candle cannot be FULL when coverage is partial or sequence-gapped even if the ratio is near one." },
  { id: "session-cvd", version: "1.0.0", title: "Session CVD", formula: "Σ aggressive buy volume − Σ aggressive sell volume", inputs: ["aggressor-classified trades", "session boundary"], limitations: "Aggregate OHLCV without aggressor split is not sufficient." },
  { id: "session-vwap", version: "1.0.0", title: "Session VWAP", formula: "Σ typicalPrice × volume / Σ volume", inputs: ["session candles", "volume"], limitations: "Candle-derived VWAP is less precise than trade-derived VWAP." },
  { id: "value-area", version: "1.0.0", title: "Value area", formula: "Highest-volume price rows accumulated until 70% of total volume", inputs: ["row total volume"], limitations: "Tie ordering is deterministic by volume then price." },
  { id: "diagonal-imbalance", version: "1.0.0", title: "Diagonal imbalance", formula: "ask(price) / bid(price − rowStep), or bid(price) / ask(price + rowStep)", inputs: ["bid volume", "ask volume", "ratio threshold", "minimum volume"], limitations: "Zero denominators require the configured minimum-volume guard." },
  { id: "stacked-imbalance", version: "1.0.0", title: "Stacked imbalance", formula: "Three or more adjacent diagonal imbalances on the same side", inputs: ["diagonal imbalance flags", "row adjacency"], limitations: "Regrouping may change which rows are adjacent but not source volume." },
  { id: "book-imbalance", version: "1.0.0", title: "Book imbalance", formula: "distance-weighted bid liquidity versus ask liquidity", inputs: ["synchronized bids", "synchronized asks", "mid price"], limitations: "Only valid while the local order book is synchronized and uncrossed." },
  { id: "microprice", version: "1.0.0", title: "Microprice", formula: "(ask × bidSize + bid × askSize) / (bidSize + askSize)", inputs: ["best bid", "best ask", "best sizes"], limitations: "Unavailable without a synchronized two-sided book." },
] as const;

const QUALITY_SEVERITY: Record<CanonicalQuality, number> = {
  FULL: 0,
  "REPLAY FULL": 0,
  "LIVE PARTIAL": 1,
  "AGGREGATE ONLY": 2,
  STALE: 3,
  GAPPED: 4,
  UNAVAILABLE: 5,
};

export function canonicalQuality(quality: DataQuality | FootprintQuality, replay = false): CanonicalQuality {
  if (quality === "full") return replay ? "REPLAY FULL" : "FULL";
  if (quality === "replay-full") return "REPLAY FULL";
  if (quality === "live-only" || quality === "live-partial") return "LIVE PARTIAL";
  if (quality === "aggregate" || quality === "aggregate-only") return "AGGREGATE ONLY";
  if (quality === "gapped") return "GAPPED";
  if (quality === "stale") return "STALE";
  return "UNAVAILABLE";
}

export function weakestQuality(qualities: readonly CanonicalQuality[]): CanonicalQuality {
  if (!qualities.length) return "UNAVAILABLE";
  return qualities.reduce((weakest, current) => QUALITY_SEVERITY[current] > QUALITY_SEVERITY[weakest] ? current : weakest);
}

export function reconcileVolumes(derivedVolume: number, sourceVolume: number, tolerance = 0.03): ReconciliationResult {
  const difference = derivedVolume - sourceVolume;
  const ratio = sourceVolume > 0 ? derivedVolume / sourceVolume : derivedVolume === 0 ? 1 : undefined;
  const passed = ratio !== undefined && Math.abs(ratio - 1) <= tolerance;
  return { derivedVolume, sourceVolume, ratio, difference, tolerance, passed };
}

export function reconcileFootprint(footprint: FootprintCandle, sourceVolume: number, tolerance = 0.03): ReconciliationResult {
  return reconcileVolumes(footprint.rows.reduce((sum, row) => sum + row.bidVolume + row.askVolume, 0), sourceVolume, tolerance);
}

export function validateProvenance(input: MetricProvenance): string[] {
  const errors: string[] = [];
  if (!input.venue.trim()) errors.push("venue is required");
  if (!input.symbol.trim()) errors.push("symbol is required");
  if (!input.venueSymbol.trim()) errors.push("venueSymbol is required");
  if (!Number.isFinite(input.sourceTimestamp) || input.sourceTimestamp <= 0) errors.push("sourceTimestamp is invalid");
  if (!Number.isFinite(input.receiveTimestamp) || input.receiveTimestamp <= 0) errors.push("receiveTimestamp is invalid");
  if (input.receiveTimestamp < input.sourceTimestamp - 60_000) errors.push("receiveTimestamp precedes sourceTimestamp");
  if (!Number.isFinite(input.dataAgeMs) || input.dataAgeMs < 0) errors.push("dataAgeMs is invalid");
  if (!input.calculationId.trim()) errors.push("calculationId is required");
  if (!input.calculationVersion.trim()) errors.push("calculationVersion is required");
  if (!Number.isFinite(input.completeness) || input.completeness < 0 || input.completeness > 1) errors.push("completeness must be between 0 and 1");
  if ((input.quality === "FULL" || input.quality === "REPLAY FULL") && input.completeness < 1) errors.push("full quality requires complete coverage");
  if ((input.quality === "FULL" || input.quality === "REPLAY FULL") && input.reconciliation && !input.reconciliation.passed) errors.push("full quality requires passing reconciliation");
  return errors;
}

export class QualityTimeline {
  private readonly transitions: QualityTransition[] = [];

  constructor(private current: CanonicalQuality = "UNAVAILABLE", private readonly limit = 2_000) {}

  get value(): CanonicalQuality { return this.current; }

  transition(to: CanonicalQuality, reason: string, at = Date.now(), evidence?: string): QualityTransition | undefined {
    if (to === this.current) return undefined;
    const improving = QUALITY_SEVERITY[to] < QUALITY_SEVERITY[this.current];
    if (improving && !evidence) throw new Error(`Quality improvement ${this.current} → ${to} requires evidence`);
    const item = { at, from: this.current, to, reason, evidence };
    this.current = to;
    this.transitions.push(item);
    if (this.transitions.length > this.limit) this.transitions.splice(0, this.transitions.length - this.limit);
    return item;
  }

  snapshot(): QualityTransition[] { return this.transitions.slice(); }
}

export interface VenueMarketSample {
  venue: string;
  price: number;
  bid?: number;
  ask?: number;
  bidLiquidity?: number;
  askLiquidity?: number;
  buyVolume: number;
  sellVolume: number;
  fundingRate?: number;
  openInterest?: number;
  quality: CanonicalQuality;
}

export interface CrossVenueSnapshot {
  consolidatedCvd: number;
  totalVolume: number;
  weightedPrice?: number;
  priceDivergenceBps?: number;
  liquidityFragmentation?: number;
  venueShare: Record<string, number>;
  venueCvd: Record<string, number>;
  quality: CanonicalQuality;
}

export function calculateCrossVenue(samples: readonly VenueMarketSample[]): CrossVenueSnapshot {
  const valid = samples.filter((sample) => Number.isFinite(sample.price) && sample.price > 0);
  const volumes = valid.map((sample) => Math.max(0, sample.buyVolume) + Math.max(0, sample.sellVolume));
  const totalVolume = volumes.reduce((sum, volume) => sum + volume, 0);
  const weightedPrice = totalVolume > 0
    ? valid.reduce((sum, sample, index) => sum + sample.price * volumes[index], 0) / totalVolume
    : valid.length ? valid.reduce((sum, sample) => sum + sample.price, 0) / valid.length : undefined;
  const prices = valid.map((sample) => sample.price);
  const priceDivergenceBps = weightedPrice && prices.length > 1
    ? (Math.max(...prices) - Math.min(...prices)) / weightedPrice * 10_000
    : undefined;
  const liquidity = valid.map((sample) => Math.max(0, sample.bidLiquidity ?? 0) + Math.max(0, sample.askLiquidity ?? 0));
  const totalLiquidity = liquidity.reduce((sum, value) => sum + value, 0);
  const liquidityFragmentation = totalLiquidity > 0
    ? 1 - Math.max(...liquidity) / totalLiquidity
    : undefined;
  const venueShare: Record<string, number> = {};
  const venueCvd: Record<string, number> = {};
  valid.forEach((sample, index) => {
    venueShare[sample.venue] = totalVolume > 0 ? volumes[index] / totalVolume : 0;
    venueCvd[sample.venue] = sample.buyVolume - sample.sellVolume;
  });
  return {
    consolidatedCvd: valid.reduce((sum, sample) => sum + sample.buyVolume - sample.sellVolume, 0),
    totalVolume,
    weightedPrice,
    priceDivergenceBps,
    liquidityFragmentation,
    venueShare,
    venueCvd,
    quality: weakestQuality(valid.map((sample) => sample.quality)),
  };
}
