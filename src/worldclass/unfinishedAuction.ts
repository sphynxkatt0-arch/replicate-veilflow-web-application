import type { Candle, FootprintCandle } from "./types";

export interface UnfinishedAuctionLevel {
  id: string;
  sourceTime: number;
  price: number;
  side: "high" | "low";
  endTime: number;
  resolved: boolean;
  resolvedAt?: number;
}

function touched(candle: Candle, price: number): boolean {
  return candle.low <= price && candle.high >= price;
}

export function buildUnfinishedAuctionLevels(
  footprints: FootprintCandle[],
  candles: Candle[],
): UnfinishedAuctionLevel[] {
  if (!footprints.length || !candles.length) return [];
  const orderedCandles = [...candles].sort((left, right) => left.time - right.time);
  const candleIndex = new Map(orderedCandles.map((candle, index) => [candle.time, index]));
  const lastEndTime = orderedCandles.at(-1)?.endTime ?? 0;
  const levels: UnfinishedAuctionLevel[] = [];

  const add = (footprint: FootprintCandle, side: "high" | "low", price: number | undefined) => {
    if (price === undefined) return;
    const sourceIndex = candleIndex.get(footprint.time);
    if (sourceIndex === undefined) return;
    let resolvedAt: number | undefined;
    let endTime = lastEndTime;
    for (let index = sourceIndex + 1; index < orderedCandles.length; index += 1) {
      const candle = orderedCandles[index];
      if (!touched(candle, price)) continue;
      resolvedAt = candle.time;
      endTime = candle.time;
      break;
    }
    levels.push({
      id: `ua-${side}-${footprint.time}-${price}`,
      sourceTime: footprint.time,
      price,
      side,
      endTime,
      resolved: resolvedAt !== undefined,
      resolvedAt,
    });
  };

  for (const footprint of [...footprints].sort((left, right) => left.time - right.time)) {
    if (footprint.unfinishedHigh === true) add(footprint, "high", footprint.unfinishedHighPrice);
    if (footprint.unfinishedLow === true) add(footprint, "low", footprint.unfinishedLowPrice);
  }
  return levels;
}
