import type { MarketDefinition, MarketKey, Timeframe } from "./types";

export const MARKETS: Record<MarketKey, MarketDefinition> = {
  BTC: {
    key: "BTC",
    displayName: "BTC / USDT Spot",
    shortName: "BTCUSDT",
    provider: "Binance",
    providerSymbol: "BTCUSDT",
    productType: "spot",
    venue: "Binance Spot",
    priceDecimals: 1,
    quantityDecimals: 5,
    tickSize: 0.1,
    quantityUnit: "BTC",
    timezone: "UTC",
    disclosure: "Binance BTCUSDT spot. This is spot-market order flow, not CME Bitcoin futures.",
    quality: "full",
  },
  NQ: {
    key: "NQ",
    displayName: "XYZ100 Perpetual Proxy",
    shortName: "XYZ100 PERP",
    provider: "Hyperliquid",
    providerSymbol: "xyz:XYZ100",
    productType: "perpetual-proxy",
    venue: "Hyperliquid Trade[XYZ]",
    priceDecimals: 1,
    quantityDecimals: 4,
    tickSize: 0.1,
    quantityUnit: "contracts",
    timezone: "UTC",
    disclosure: "Hyperliquid XYZ100 perpetual proxy. It is not CME Nasdaq-100 futures and must not be interpreted as CME NQ order flow.",
    quality: "proxy",
  },
  ES: {
    key: "ES",
    displayName: "SP500 Perpetual Proxy",
    shortName: "SP500 PERP",
    provider: "Hyperliquid",
    providerSymbol: "xyz:SP500",
    productType: "perpetual-proxy",
    venue: "Hyperliquid Trade[XYZ]",
    priceDecimals: 2,
    quantityDecimals: 4,
    tickSize: 0.01,
    quantityUnit: "contracts",
    timezone: "UTC",
    disclosure: "Hyperliquid SP500 perpetual proxy. It is not CME E-mini S&P 500 futures and must not be interpreted as CME ES order flow.",
    quality: "proxy",
  },
};

export const TIMEFRAMES: Timeframe[] = ["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"];

export function timeframeMs(timeframe: Timeframe): number {
  const count = Number(timeframe.slice(0, -1));
  const unit = timeframe.at(-1);
  if (unit === "m") return count * 60_000;
  if (unit === "h") return count * 3_600_000;
  return count * 86_400_000;
}

export function sessionStartUtc(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
