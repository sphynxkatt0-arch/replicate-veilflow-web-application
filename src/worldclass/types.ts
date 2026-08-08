export type MarketKey = "BTC" | "BTCPERP" | "NQ" | "ES";
export type ProviderName = "Binance" | "Hyperliquid";
export type ProductType = "spot" | "perpetual" | "perpetual-proxy";
export type BinanceProduct = "spot" | "usdm";
export type Timeframe = "1m" | "3m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d";
export type Side = "buy" | "sell";
export type ConnectionState = "connecting" | "syncing" | "live" | "reconnecting" | "stale" | "error" | "closed";
export type DataQuality = "full" | "live-only" | "aggregate" | "proxy" | "stale" | "gapped" | "unavailable";
export type ChartMode = "candles" | "footprint" | "delta";
export type ReplayMode = "live" | "events";
export type FootprintQuality = "full" | "live-partial" | "aggregate-only" | "gapped" | "replay-full";

export interface MarketDefinition {
  key: MarketKey;
  displayName: string;
  shortName: string;
  provider: ProviderName;
  providerSymbol: string;
  productType: ProductType;
  binanceProduct?: BinanceProduct;
  venue: string;
  priceDecimals: number;
  quantityDecimals: number;
  tickSize: number;
  quantityUnit: string;
  timezone: string;
  disclosure: string;
  quality: DataQuality;
  footprintDefaultTicks: number;
  footprintImbalanceRatio: number;
  footprintMinVolume: number;
}

export interface Candle {
  time: number;
  endTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume?: number;
  sellVolume?: number;
  trades?: number;
}

export interface Trade {
  id: string;
  exchangeTime: number;
  receiveTime: number;
  price: number;
  size: number;
  side: Side;
  notional: number;
  sequence?: number;
  source?: "backfill" | "live" | "replay";
}

export interface FootprintRow {
  price: number;
  bidVolume: number;
  askVolume: number;
  totalVolume: number;
  delta: number;
  tradeCount: number;
  bidTrades: number;
  askTrades: number;
  bidImbalance: boolean;
  askImbalance: boolean;
  stackedBid: boolean;
  stackedAsk: boolean;
  inValueArea: boolean;
}

export interface FootprintCandle {
  time: number;
  endTime: number;
  rows: FootprintRow[];
  totalBidVolume: number;
  totalAskVolume: number;
  totalVolume: number;
  delta: number;
  maxDelta: number;
  minDelta: number;
  tradeCount: number;
  pocPrice?: number;
  valueAreaHigh?: number;
  valueAreaLow?: number;
  coverageRatio?: number;
  /** Confirmed only when execution coverage for the candle is FULL/replay-full. */
  unfinishedHigh?: boolean;
  unfinishedLow?: boolean;
  unfinishedHighPrice?: number;
  unfinishedLowPrice?: number;
  quality: FootprintQuality;
  priceStep: number;
}

export interface FootprintCoverage {
  quality: FootprintQuality;
  source: "collector-api" | "binance-aggtrades" | "live-stream" | "hyperliquid-live" | "replay" | "none";
  startTime?: number;
  endTime?: number;
  startSequence?: number;
  endSequence?: number;
  contiguous: boolean;
  eventCount: number;
  gappedAt?: number;
  detail: string;
}

export interface BookLevel {
  price: number;
  size: number;
  orders?: number;
}

export interface OrderBook {
  bids: BookLevel[];
  asks: BookLevel[];
  exchangeTime: number;
  receiveTime: number;
  sequence?: number;
  quality: DataQuality;
}

export interface MarketMetrics {
  markPrice?: number;
  oraclePrice?: number;
  fundingRate?: number;
  openInterest?: number;
  dayVolume?: number;
  dayVolumeUnit?: "base" | "usd-notional";
  timestamp: number;
  quality: DataQuality;
}

export interface AnalyticsSnapshot {
  sessionVwap?: number;
  sessionCvd?: number;
  rollingDelta?: number;
  microprice?: number;
  spread?: number;
  spreadBps?: number;
  weightedImbalance?: number;
  buyPressure?: number;
  largeTradeThreshold?: number;
  dataQuality: DataQuality;
}

export type NormalizedEvent =
  | { id: string; type: "candle"; market: MarketKey; exchangeTime: number; receiveTime: number; payload: Candle }
  | { id: string; type: "trade"; market: MarketKey; exchangeTime: number; receiveTime: number; payload: Trade }
  | { id: string; type: "book"; market: MarketKey; exchangeTime: number; receiveTime: number; payload: OrderBook }
  | { id: string; type: "metrics"; market: MarketKey; exchangeTime: number; receiveTime: number; payload: MarketMetrics }
  | { id: string; type: "status"; market: MarketKey; exchangeTime: number; receiveTime: number; payload: { state: ConnectionState; detail: string } };

export interface MarketState {
  market: MarketDefinition;
  timeframe: Timeframe;
  candles: Candle[];
  trades: Trade[];
  footprints: FootprintCandle[];
  footprintCoverage: FootprintCoverage;
  book: OrderBook | null;
  metrics: MarketMetrics;
  analytics: AnalyticsSnapshot;
  status: ConnectionState;
  statusDetail: string;
  lastEventAt: number;
  eventRate: number;
  eventLagMs: number;
}

export interface ReplayState {
  mode: ReplayMode;
  playing: boolean;
  speed: number;
  cursor: number;
  events: NormalizedEvent[];
  importedName?: string;
}

export interface LargeTrade {
  id: string;
  time: number;
  endTime: number;
  price: number;
  size: number;
  notional: number;
  side: Side;
  count: number;
  zScore: number;
}
