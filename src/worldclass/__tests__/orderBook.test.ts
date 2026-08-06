import { describe, expect, it } from "vitest";
import { BinanceLocalBook, groupBook, normalizeBook } from "../orderBook";

const snapshot = {
  lastUpdateId: 100,
  bids: [["100", "2"], ["99", "3"]] as Array<[string, string]>,
  asks: [["101", "4"], ["102", "5"]] as Array<[string, string]>,
};

describe("BinanceLocalBook", () => {
  it("applies a snapshot and contiguous updates", () => {
    const book = new BinanceLocalBook();
    book.reset();
    book.buffer({ E: 1, U: 101, u: 102, b: [["100", "4"]], a: [["101", "0"], ["100.5", "1"]] });
    book.applySnapshot(snapshot);
    const result = book.snapshot(1);
    expect(result.sequence).toBe(102);
    expect(result.bids[0]).toEqual({ price: 100, size: 4 });
    expect(result.asks[0]).toEqual({ price: 100.5, size: 1 });
    expect(result.asks.some((level) => level.price === 101)).toBe(false);
  });

  it("detects a sequence gap", () => {
    const book = new BinanceLocalBook();
    book.reset();
    book.applySnapshot(snapshot);
    expect(() => book.applyUpdate({ E: 1, U: 105, u: 106, b: [], a: [] })).toThrow(/gap/i);
    expect(book.syncState).toBe("gapped");
  });

  it("ignores stale updates", () => {
    const book = new BinanceLocalBook();
    book.reset();
    book.applySnapshot(snapshot);
    expect(book.applyUpdate({ E: 1, U: 90, u: 99, b: [["100", "9"]], a: [] })).toBe(false);
    expect(book.snapshot(1).bids[0].size).toBe(2);
  });
});

describe("book normalization", () => {
  it("removes crossed and invalid levels", () => {
    const result = normalizeBook(
      [{ price: 101, size: 1 }, { price: 100, size: 2 }, { price: -1, size: 2 }],
      [{ price: 100.5, size: 1 }, { price: 102, size: 2 }],
      1,
      "full",
    );
    expect(result.bids.map((level) => level.price)).toEqual([100]);
    expect(result.asks.map((level) => level.price)).toEqual([100.5, 102]);
  });

  it("conserves size while grouping", () => {
    const book = normalizeBook([{ price: 100.1, size: 2 }, { price: 100.2, size: 3 }], [{ price: 100.8, size: 4 }], 1, "full");
    const grouped = groupBook(book, 1, 10)!;
    expect(grouped.bids.reduce((sum, level) => sum + level.size, 0)).toBe(5);
    expect(grouped.asks.reduce((sum, level) => sum + level.size, 0)).toBe(4);
  });
});
