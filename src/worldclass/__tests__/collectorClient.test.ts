import { describe, expect, it } from "vitest";
import { collectorManifestMatchesMarket } from "../collectorClient";
import { MARKETS } from "../markets";

describe("collector session routing", () => {
  it("requires venue, symbol, and product type to match", () => {
    expect(collectorManifestMatchesMarket({ id: "ok", venue: "binance", venueSymbol: "BTCUSDT", productType: "spot" }, MARKETS.BTC)).toBe(true);
    expect(collectorManifestMatchesMarket({ id: "wrong-venue", venue: "hyperliquid", venueSymbol: "BTCUSDT", productType: "spot" }, MARKETS.BTC)).toBe(false);
    expect(collectorManifestMatchesMarket({ id: "wrong-product", venue: "binance", venueSymbol: "BTCUSDT", productType: "perpetual" }, MARKETS.BTC)).toBe(false);
  });

  it("routes Hyperliquid proxy instruments to perpetual collector sessions", () => {
    expect(collectorManifestMatchesMarket({ id: "hl", venue: "hyperliquid", venueSymbol: MARKETS.NQ.providerSymbol, productType: "perpetual" }, MARKETS.NQ)).toBe(true);
    expect(collectorManifestMatchesMarket({ id: "hl-wrong", venue: "binance", venueSymbol: MARKETS.NQ.providerSymbol, productType: "perpetual" }, MARKETS.NQ)).toBe(false);
  });
});
