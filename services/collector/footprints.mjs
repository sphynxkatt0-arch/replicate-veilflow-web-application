import { sha256 } from "./core.mjs";

export const FOOTPRINT_TIMEFRAMES = Object.freeze({
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
});

const QUALITY_ORDER = Object.freeze({
  "REPLAY FULL": 0,
  FULL: 0,
  "LIVE PARTIAL": 1,
  "AGGREGATE ONLY": 2,
  STALE: 3,
  GAPPED: 4,
  UNAVAILABLE: 5,
});

function canonicalQuality(value) {
  const normalized = String(value || "FULL").trim().replaceAll("_", " ").replaceAll("-", " ").toUpperCase();
  return Object.hasOwn(QUALITY_ORDER, normalized) ? normalized : "UNAVAILABLE";
}

function weakerQuality(left, right) {
  const a = canonicalQuality(left);
  const b = canonicalQuality(right);
  return QUALITY_ORDER[a] >= QUALITY_ORDER[b] ? a : b;
}

function precise(value) {
  return Number(Number(value).toPrecision(12));
}

function groupPrice(price, tickSize) {
  return precise(Math.round(price / tickSize) * tickSize);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function valueArea(rows, target = 0.7) {
  const total = rows.reduce((sum, row) => sum + row.totalVolume, 0);
  if (total <= 0) return { low: undefined, high: undefined };
  const selected = [];
  let running = 0;
  for (const row of [...rows].sort((left, right) => right.totalVolume - left.totalVolume || right.price - left.price)) {
    selected.push(row);
    running += row.totalVolume;
    if (running / total >= target) break;
  }
  return {
    low: Math.min(...selected.map((row) => row.price)),
    high: Math.max(...selected.map((row) => row.price)),
  };
}

function markImbalances(rows, tickSize, imbalanceRatio, minVolume) {
  const byPrice = new Map(rows.map((row) => [precise(row.price), row]));
  for (const row of rows) {
    const lower = byPrice.get(precise(row.price - tickSize));
    const upper = byPrice.get(precise(row.price + tickSize));
    row.askImbalance = row.askVolume >= minVolume && row.askVolume >= Math.max(minVolume, (lower?.bidVolume ?? 0) * imbalanceRatio);
    row.bidImbalance = row.bidVolume >= minVolume && row.bidVolume >= Math.max(minVolume, (upper?.askVolume ?? 0) * imbalanceRatio);
  }

  const ascending = [...rows].sort((left, right) => left.price - right.price);
  const markStack = (key, target) => {
    let run = [];
    const flush = () => {
      if (run.length >= 3) for (const row of run) row[target] = true;
      run = [];
    };
    for (let index = 0; index < ascending.length; index += 1) {
      const row = ascending[index];
      const previous = ascending[index - 1];
      const adjacent = !previous || Math.abs(row.price - previous.price - tickSize) <= tickSize * 0.001;
      if (row[key] && adjacent) run.push(row);
      else {
        flush();
        if (row[key]) run.push(row);
      }
    }
    flush();
  };
  markStack("askImbalance", "stackedAsk");
  markStack("bidImbalance", "stackedBid");
}

function finalizeRows(rows, tickSize, imbalanceRatio, minVolume, valueAreaRatio) {
  const output = [...rows.values()]
    .map((row) => ({
      price: row.price,
      bidVolume: row.bidVolume,
      askVolume: row.askVolume,
      totalVolume: row.bidVolume + row.askVolume,
      delta: row.askVolume - row.bidVolume,
      tradeCount: row.bidTrades + row.askTrades,
      bidTrades: row.bidTrades,
      askTrades: row.askTrades,
      bidImbalance: false,
      askImbalance: false,
      stackedBid: false,
      stackedAsk: false,
      inValueArea: false,
    }))
    .sort((left, right) => right.price - left.price);

  markImbalances(output, tickSize, imbalanceRatio, minVolume);
  const area = valueArea(output, valueAreaRatio);
  for (const row of output) {
    row.inValueArea = area.low !== undefined && area.high !== undefined && row.price >= area.low && row.price <= area.high;
  }
  return { rows: output, area };
}

function validRangeValue(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function buildFootprints(events, timeframe = "1m", tickSize = 0.01, options = {}) {
  const interval = FOOTPRINT_TIMEFRAMES[timeframe];
  if (!interval) throw new Error(`Unsupported timeframe ${timeframe}`);
  if (!Number.isFinite(Number(tickSize)) || Number(tickSize) <= 0) throw new Error("tickSize must be positive");

  const step = Number(tickSize);
  const startTime = validRangeValue(options.startTime);
  const endTime = validRangeValue(options.endTime);
  const imbalanceRatio = Number.isFinite(Number(options.imbalanceRatio)) && Number(options.imbalanceRatio) > 0 ? Number(options.imbalanceRatio) : 3;
  const minVolume = Number.isFinite(Number(options.minVolume)) && Number(options.minVolume) >= 0 ? Number(options.minVolume) : 0;
  const valueAreaRatio = Number.isFinite(Number(options.valueAreaRatio)) && Number(options.valueAreaRatio) > 0 && Number(options.valueAreaRatio) <= 1 ? Number(options.valueAreaRatio) : 0.7;
  const buckets = new Map();
  let globalQuality = "FULL";

  for (const event of events) {
    const exchangeTimestamp = number(event.exchangeTimestamp, 0);
    if (event.eventType === "quality") {
      globalQuality = canonicalQuality(event.payload?.to ?? event.quality);
      continue;
    }
    if (event.eventType !== "trade") continue;
    if (startTime !== undefined && exchangeTimestamp < startTime) continue;
    if (endTime !== undefined && exchangeTimestamp > endTime) continue;

    const price = number(event.payload?.price, Number.NaN);
    const size = number(event.payload?.size, Number.NaN);
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size < 0) continue;

    const time = Math.floor(exchangeTimestamp / interval) * interval;
    let candle = buckets.get(time);
    if (!candle) {
      candle = {
        time,
        endTime: time + interval - 1,
        rows: new Map(),
        quality: weakerQuality(globalQuality, event.quality),
        eventCount: 0,
        firstEventTime: exchangeTimestamp,
        lastEventTime: exchangeTimestamp,
      };
      buckets.set(time, candle);
    } else {
      candle.quality = weakerQuality(candle.quality, weakerQuality(globalQuality, event.quality));
      candle.firstEventTime = Math.min(candle.firstEventTime, exchangeTimestamp);
      candle.lastEventTime = Math.max(candle.lastEventTime, exchangeTimestamp);
    }

    const groupedPrice = groupPrice(price, step);
    const row = candle.rows.get(groupedPrice) ?? { price: groupedPrice, bidVolume: 0, askVolume: 0, bidTrades: 0, askTrades: 0 };
    if (event.payload?.side === "buy") {
      row.askVolume += size;
      row.askTrades += 1;
    } else {
      row.bidVolume += size;
      row.bidTrades += 1;
    }
    candle.rows.set(groupedPrice, row);
    candle.eventCount += 1;
  }

  return [...buckets.values()].sort((left, right) => left.time - right.time).map((candle) => {
    const finalized = finalizeRows(candle.rows, step, imbalanceRatio, minVolume, valueAreaRatio);
    const rows = finalized.rows;
    let totalBidVolume = 0;
    let totalAskVolume = 0;
    let tradeCount = 0;
    let maxDelta = Number.NEGATIVE_INFINITY;
    let minDelta = Number.POSITIVE_INFINITY;
    let poc;

    for (const row of rows) {
      totalBidVolume += row.bidVolume;
      totalAskVolume += row.askVolume;
      tradeCount += row.tradeCount;
      maxDelta = Math.max(maxDelta, row.delta);
      minDelta = Math.min(minDelta, row.delta);
      if (!poc || row.totalVolume > poc.totalVolume) poc = row;
    }

    const footprint = {
      time: candle.time,
      endTime: candle.endTime,
      firstEventTime: candle.firstEventTime,
      lastEventTime: candle.lastEventTime,
      rows,
      totalBidVolume,
      totalAskVolume,
      totalVolume: totalBidVolume + totalAskVolume,
      delta: totalAskVolume - totalBidVolume,
      maxDelta: Number.isFinite(maxDelta) ? maxDelta : 0,
      minDelta: Number.isFinite(minDelta) ? minDelta : 0,
      tradeCount,
      pocPrice: poc?.price,
      valueAreaHigh: finalized.area.high,
      valueAreaLow: finalized.area.low,
      eventCount: candle.eventCount,
      quality: canonicalQuality(candle.quality),
      priceStep: step,
    };
    return { ...footprint, hash: sha256(footprint) };
  });
}

export function footprintCoverage(events, footprints, options = {}) {
  const tradeEvents = events.filter((event) => {
    if (event.eventType !== "trade") return false;
    if (options.startTime !== undefined && event.exchangeTimestamp < Number(options.startTime)) return false;
    if (options.endTime !== undefined && event.exchangeTimestamp > Number(options.endTime)) return false;
    return true;
  });
  const qualityEvents = events.filter((event) => event.eventType === "quality");
  const qualities = footprints.map((footprint) => canonicalQuality(footprint.quality));
  let quality = qualities[0] ?? "UNAVAILABLE";
  for (const candidate of qualities.slice(1)) quality = weakerQuality(quality, candidate);
  if (qualityEvents.some((event) => canonicalQuality(event.payload?.to ?? event.quality) === "GAPPED")) quality = weakerQuality(quality, "GAPPED");

  const first = tradeEvents[0];
  const last = tradeEvents.at(-1);
  return {
    requestedStartTime: validRangeValue(options.startTime),
    requestedEndTime: validRangeValue(options.endTime),
    availableStartTime: first?.exchangeTimestamp,
    availableEndTime: last?.exchangeTimestamp,
    eventCount: tradeEvents.length,
    footprintCount: footprints.length,
    contiguous: quality !== "GAPPED",
    quality,
  };
}
