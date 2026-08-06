export type Candle = {
  open: number;
  high: number;
  low: number;
  close: number;
  buyVol: number;
  sellVol: number;
};

/** kline from an external source (e.g. Binance), buyVol/sellVol already split */
export type Kline = Candle & { openTime: number; closeTime: number };

export type FlowMark = {
  i: number; // candle index
  price: number;
  value: number;
  side: "buy" | "sell";
};

export type HeatLine = {
  i: number; // starting candle index
  span: number; // number of candles wide
  price: number;
  tone: "cyan" | "green" | "gold" | "red" | "purple";
  opacity: number;
  thick: boolean;
};

export type OptionLevel = {
  price: number;
  tag: string;
  color: string;
};

export type SymbolSpec = {
  id: string;
  name: string;
  base: number; // reference last price
  tick: number; // price step
  vol: number; // per-candle volatility in price units
  decimals: number;
  source: "synthetic" | "binance";
  pair?: string; // binance symbol, e.g. BTCUSDT
};

export const SYMBOLS: Record<string, SymbolSpec> = {
  NQ: { id: "NQ", name: "E-mini Nasdaq", base: 29276.5, tick: 0.25, vol: 15, decimals: 2, source: "synthetic" },
  ES: { id: "ES", name: "E-mini S&P 500", base: 6842.75, tick: 0.25, vol: 4, decimals: 2, source: "synthetic" },
  RTY: { id: "RTY", name: "Russell 2000", base: 2612.4, tick: 0.1, vol: 2.4, decimals: 1, source: "synthetic" },
  CL: { id: "CL", name: "WTI Crude", base: 71.38, tick: 0.01, vol: 0.18, decimals: 2, source: "synthetic" },
  GC: { id: "GC", name: "Gold", base: 4192.6, tick: 0.1, vol: 4.5, decimals: 1, source: "synthetic" },
  BTC: { id: "BTC", name: "Bitcoin", base: 105000, tick: 0.1, vol: 60, decimals: 1, source: "binance", pair: "BTCUSDT" },
  ETH: { id: "ETH", name: "Ethereum", base: 3600, tick: 0.01, vol: 18, decimals: 2, source: "binance", pair: "ETHUSDT" },
  SOL: { id: "SOL", name: "Solana", base: 155, tick: 0.01, vol: 1.2, decimals: 2, source: "binance", pair: "SOLUSDT" },
};

export const TIMEFRAMES = ["1m", "3m", "5m", "15m"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

const TF_MULT: Record<Timeframe, number> = { "1m": 1, "3m": 1.7, "5m": 2.3, "15m": 4 };

export type Dataset = {
  spec: SymbolSpec;
  timeframe: Timeframe;
  candles: Candle[];
  flows: FlowMark[];
  heat: HeatLine[];
  levels: OptionLevel[];
  priceMin: number;
  priceMax: number;
  lastPrice: number;
  count: number;
};

const TONES: HeatLine["tone"][] = ["gold", "gold", "cyan", "green", "red"];

export function buildDataset(symbolId: string, timeframe: Timeframe): Dataset {
  const spec = SYMBOLS[symbolId] ?? SYMBOLS.NQ;
  const seedBase = symbolId.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const rnd = seeded(seedBase * 977 + TIMEFRAMES.indexOf(timeframe) * 131 + 7);
  const count = 158;
  const volScale = spec.vol * TF_MULT[timeframe];

  const candles: Candle[] = [];
  // walk downward-ish so the last price lands near spec.base (as in the reference)
  let price = spec.base + volScale * 9;
  const shocks: Record<number, number> = {
    52: -volScale * 3.1,
    72: volScale * 2.4,
    105: -volScale * 1.9,
    131: -volScale * 2.2,
  };
  for (let i = 0; i < count; i++) {
    const wave = Math.sin(i / 8.5) * volScale * 0.45 + Math.sin(i / 20) * volScale * 0.28;
    const drift = -volScale * 0.02;
    const open = price;
    let close = open + (rnd() - 0.5) * volScale * 1.1 + wave * 0.16 + drift + (shocks[i] ?? 0);
    close = Math.round(close / spec.tick) * spec.tick;
    const high = Math.max(open, close) + rnd() * volScale * 0.8;
    const low = Math.min(open, close) - rnd() * volScale * 0.85;
    const total = 40 + rnd() * 900;
    const buyBias = close >= open ? 0.58 : 0.42;
    candles.push({
      open,
      high,
      low,
      close,
      buyVol: Math.round(total * buyBias),
      sellVol: Math.round(total * (1 - buyBias)),
    });
    price = close;
  }

  const lows = candles.map((c) => c.low);
  const highs = candles.map((c) => c.high);
  const rawMin = Math.min(...lows);
  const rawMax = Math.max(...highs);
  const pad = (rawMax - rawMin) * 0.08;
  const priceMin = rawMin - pad;
  const priceMax = rawMax + pad;
  const lastPrice = candles[candles.length - 1].close;

  // liquidity heat lines
  const heat: HeatLine[] = [];
  for (let k = 0; k < 115; k++) {
    const startI = 55 + Math.floor(rnd() * 100);
    heat.push({
      i: startI,
      span: 1 + Math.floor(rnd() * 18),
      price: priceMin + rnd() * (priceMax - priceMin),
      tone: TONES[Math.floor(rnd() * TONES.length)],
      opacity: 0.32 + rnd() * 0.5,
      thick: rnd() > 0.9,
    });
  }

  // option water levels (GEX-style) spread around the last price
  const step = (priceMax - priceMin) / 9;
  const levelDefs: Array<[string, string, number]> = [
    ["0γ+", "#1bc3d9", priceMax - step * 0.5],
    ["0ν+", "#36c99b", priceMax - step * 1.2],
    ["ZG90", "#efb43f", priceMax - step * 2.1],
    ["90σ-", "#c76769", lastPrice + step * 1.5],
    ["ZG0", "#e8ba42", lastPrice + step * 1.05],
    ["90σ+", "#43b88c", lastPrice - step * 0.5],
    ["0ν-", "#ee6165", priceMin + step * 1.4],
    ["0γ-", "#9148ee", priceMin + step * 0.7],
    ["S0ν-", "#f17576", priceMin + step * 0.55],
  ];
  const levels: OptionLevel[] = levelDefs.map(([tag, color, p]) => ({
    tag,
    color,
    price: Math.round(p / spec.tick) * spec.tick,
  }));
  // major heat bands anchored to those levels
  levels.forEach((lvl, idx) => {
    heat.push({
      i: 30 + idx * 8,
      span: 40 + Math.floor(rnd() * 55),
      price: lvl.price,
      tone: (["green", "red", "gold", "cyan", "purple"] as HeatLine["tone"][])[idx % 5],
      opacity: 0.8,
      thick: true,
    });
  });

  // aggregated large-order bubbles (40+ lots)
  const flows: FlowMark[] = [];
  for (let k = 0; k < 50; k++) {
    const ci = 5 + Math.floor(rnd() * (count - 8));
    const c = candles[ci];
    const side = rnd() > 0.5 ? "buy" : "sell";
    flows.push({
      i: ci,
      price: (side === "buy" ? c.low : c.high) + (side === "buy" ? -1 : 1) * rnd() * volScale * 0.6,
      value: Math.round(40 + rnd() * (rnd() > 0.88 ? 190 : 85)),
      side,
    });
  }

  return {
    spec,
    timeframe,
    candles,
    flows,
    heat,
    levels,
    priceMin,
    priceMax,
    lastPrice,
    count,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Build a Dataset from real klines (e.g. Binance).
 * Order flow fields are derived from the data:
 * - heat lines & levels from a volume profile (POC / VAH / VAL / VWAP / HVN)
 * - flows from the candles with the heaviest volume
 */
export function buildCryptoDataset(spec: SymbolSpec, timeframe: Timeframe, klines: Kline[]): Dataset {
  if (klines.length === 0) return buildDataset(spec.id, timeframe);

  const candles: Candle[] = klines.map((k) => ({ ...k }));
  const count = candles.length;
  const lows = candles.map((c) => c.low);
  const highs = candles.map((c) => c.high);
  const rawMin = Math.min(...lows);
  const rawMax = Math.max(...highs);
  const pad = (rawMax - rawMin) * 0.08 || 1;
  const priceMin = rawMin - pad;
  const priceMax = rawMax + pad;
  const lastPrice = candles[count - 1]?.close ?? spec.base;

  // volume profile
  const BUCKETS = 48;
  const range = rawMax - rawMin || 1;
  const step = range / BUCKETS;
  const vols = new Array<number>(BUCKETS).fill(0);
  const deltas = new Array<number>(BUCKETS).fill(0);
  for (const c of candles) {
    const b = clamp(Math.floor(((c.high + c.low) / 2 - rawMin) / step), 0, BUCKETS - 1);
    vols[b] += c.buyVol + c.sellVol;
    deltas[b] += c.buyVol - c.sellVol;
  }
  const bucketMid = (b: number) => rawMin + (b + 0.5) * step;

  const order = vols.map((v, b) => ({ b, v })).sort((a, b) => b.v - a.v);
  const pocB = order[0]?.b ?? 0;
  const maxVol = order[0]?.v || 1;

  const total = vols.reduce((a, v) => a + v, 0) || 1;
  let vaSum = vols[pocB];
  let loB = pocB;
  let hiB = pocB;
  while (vaSum < total * 0.7) {
    const loV = loB > 0 ? vols[loB - 1] : -1;
    const hiV = hiB < BUCKETS - 1 ? vols[hiB + 1] : -1;
    if (loV < 0 && hiV < 0) break;
    if (loV >= hiV) {
      loB--;
      vaSum += loV;
    } else {
      hiB++;
      vaSum += hiV;
    }
  }

  const vwap = candles.reduce((s, c) => s + ((c.high + c.low) / 2) * (c.buyVol + c.sellVol), 0) / total;

  const nearestIndex = (price: number) => {
    let best = 0;
    let bd = Infinity;
    candles.forEach((c, i) => {
      const d = Math.abs((c.high + c.low) / 2 - price);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  };

  const heat: HeatLine[] = [];
  const tones: HeatLine["tone"][] = ["cyan", "purple", "green", "red"];
  order.slice(0, 12).forEach(({ b, v }, rank) => {
    const d = deltas[b];
    const tone: HeatLine["tone"] =
      rank === 0 ? "gold" : d > v * 0.12 ? "green" : d < -v * 0.12 ? "red" : tones[rank % tones.length];
    const i = nearestIndex(bucketMid(b));
    heat.push({
      i,
      span: Math.max(1, count - i),
      price: bucketMid(b),
      tone,
      opacity: 0.4 + 0.5 * (v / maxVol),
      thick: rank < 3,
    });
  });

  const levels: OptionLevel[] = [
    { tag: "POC", color: "#efb53d", price: bucketMid(pocB) },
    { tag: "VAH", color: "#35c896", price: bucketMid(hiB) },
    { tag: "VAL", color: "#f16669", price: bucketMid(loB) },
    { tag: "VWAP", color: "#16c4da", price: vwap },
    ...order.slice(1, 4).map(({ b }, k) => ({
      tag: ["HVN1", "HVN2", "HVN3"][k],
      color: "#a34ef5",
      price: bucketMid(b),
    })),
  ];

  const volsArr = [...candles.map((c) => c.buyVol + c.sellVol)].sort((a, b) => a - b);
  const p85 = volsArr[Math.floor(volsArr.length * 0.85)] ?? 0;
  const flows: FlowMark[] = [];
  candles.forEach((c, ci) => {
    const v = c.buyVol + c.sellVol;
    if (v < p85 || v <= 0) return;
    const side: FlowMark["side"] = c.buyVol >= c.sellVol ? "buy" : "sell";
    flows.push({
      i: ci,
      price: (side === "buy" ? c.low : c.high) + (side === "buy" ? -1 : 1) * step * 0.35,
      value: Math.max(40, Math.round(v)),
      side,
    });
  });

  return {
    spec,
    timeframe,
    candles,
    flows,
    heat,
    levels,
    priceMin,
    priceMax,
    lastPrice,
    count,
  };
}
