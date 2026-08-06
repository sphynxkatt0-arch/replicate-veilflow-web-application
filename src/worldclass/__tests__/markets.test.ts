import { describe, expect, it } from "vitest";
import { MARKETS } from "../markets";
import { binanceApiConfig } from "../providers";

describe("market definitions", () => {
  it("exposes Binance spot and USD-M BTC perpetual as separate instruments", () => {
    expect(MARKETS.BTC.productType).toBe("spot");
    expect(MARKETS.BTCPERP.productType).toBe("perpetual");
    expect(MARKETS.BTCPERP.binanceProduct).toBe("usdm");
    expect(MARKETS.BTCPERP.providerSymbol).toBe("BTCUSDT");
    expect(binanceApiConfig(MARKETS.BTCPERP).rest[0]).toContain("fapi.binance.com");
    expect(binanceApiConfig(MARKETS.BTC).rest[0]).toContain("api.binance.com");
  });
});
