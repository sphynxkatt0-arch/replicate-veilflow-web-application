import { describe, expect, it } from "vitest";
import { BinanceLocalBook } from "../orderBook";

describe("Binance USD-M depth continuity", () => {
  it("accepts the first bridge event and enforces pu afterwards", () => {
    const book = new BinanceLocalBook();
    book.reset();
    book.buffer({ E: 1, U: 95, u: 101, pu: 94, b: [["100", "2"]], a: [] });
    book.buffer({ E: 2, U: 102, u: 103, pu: 101, b: [], a: [["101", "3"]] });
    book.applySnapshot({ lastUpdateId: 100, bids: [["99", "1"]], asks: [["102", "1"]] });
    expect(book.sequence).toBe(103);
    expect(book.snapshot(3).bids[0].price).toBe(100);
  });

  it("rejects a futures pu gap", () => {
    const book = new BinanceLocalBook();
    book.reset();
    book.applySnapshot({ lastUpdateId: 100, bids: [["99", "1"]], asks: [["102", "1"]] });
    book.applyUpdate({ E: 2, U: 101, u: 102, pu: 99, b: [], a: [] });
    expect(() => book.applyUpdate({ E: 3, U: 103, u: 104, pu: 101, b: [], a: [] })).toThrow(/previous/);
  });
});
