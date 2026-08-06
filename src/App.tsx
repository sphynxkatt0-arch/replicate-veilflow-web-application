import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  MARKETS,
  TIMEFRAMES,
  formatCompact,
  loadMarketSnapshot,
  mergeCandle,
  streamMarket,
  type Candle,
  type MarketDefinition,
  type MarketMetrics,
  type OrderBook,
  type SymbolKey,
  type Timeframe,
  type Trade,
} from "./lib/marketData";
import {
  bookGroupOptions,
  buildBookLadder,
  detectLargeTrades,
  formatBookSize,
  formatNotional,
  resolveBookGroup,
  type BookLadder,
  type TradeBurst,
} from "./lib/orderFlow";

type ConnectionState = "connecting" | "live" | "reconnecting" | "closed" | "error";
type ChartMode = "candles" | "footprint" | "delta";
type FlowMode = "both" | "buy" | "sell";
type AppTab = "chart" | "replay";
type DrawingTool = "cursor" | "trend" | "hline" | "rect" | "erase";
type LargeTradeSensitivity = "more" | "balanced" | "strict";

type Settings = {
  showVolume: boolean;
  showBookHeatmap: boolean;
  showLargeTrades: boolean;
  showVWAP: boolean;
  showEMA: boolean;
  showGrid: boolean;
  autoFollow: boolean;
  largeTradeSensitivity: LargeTradeSensitivity;
};

type Drawing =
  | { id: number; type: "hline"; price: number }
  | { id: number; type: "trend" | "rect"; time1: number; price1: number; time2: number; price2: number };

type FootprintLevel = { price: number; buy: number; sell: number };

const DEFAULT_SETTINGS: Settings = {
  showVolume: true,
  showBookHeatmap: true,
  showLargeTrades: true,
  showVWAP: true,
  showEMA: true,
  showGrid: true,
  autoFollow: true,
  largeTradeSensitivity: "balanced",
};

function usePersistentState<T>(key: string, fallback: T): [T, (value: T | ((current: T) => T)) => void] {
  const [state, setState] = useState<T>(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const update = useCallback((value: T | ((current: T) => T)) => {
    setState((current) => {
      const next = typeof value === "function" ? (value as (current: T) => T)(current) : value;
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // The workspace remains usable when storage is unavailable.
      }
      return next;
    });
  }, [key]);
  return [state, update];
}

function usePersistentSettings(key: string): [Settings, (value: Settings | ((current: Settings) => Settings)) => void] {
  const [settings, setSettings] = usePersistentState<Settings>(key, DEFAULT_SETTINGS);
  const normalized = useMemo(() => ({ ...DEFAULT_SETTINGS, ...(settings ?? {}) }), [settings]);
  return [normalized, setSettings];
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    chart: "M3 18l5-6 4 3 7-9",
    replay: "M5 5v5h5M6 17a8 8 0 1 0-1-7",
    settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4",
    download: "M12 3v12m-5-5 5 5 5-5M4 20h16",
    refresh: "M4 8V4h4M20 16v4h-4M5.5 17A8 8 0 0 0 19 8M18.5 7A8 8 0 0 0 5 16",
    play: "M8 5v14l11-7Z",
    pause: "M8 5v14M16 5v14",
    step: "M6 5v14l9-7Zm11 0v14",
    reset: "M4 8V4h4M5 17a8 8 0 1 0-1-9",
    cursor: "M5 3l13 8-6 2-2 6Z",
    trend: "M4 18 19 5",
    hline: "M3 12h18",
    rect: "M4 5h16v14H4Z",
    erase: "m7 16 8-10 4 4-8 10H7l-3-3 3-4",
    trash: "M4 7h16M9 7V4h6v3M8 7l1 13h6l1-13",
    close: "m6 6 12 12M18 6 6 18",
    plus: "M12 5v14M5 12h14",
    minus: "M5 12h14",
    bolt: "m13 2-8 12h6l-1 8 9-13h-6z",
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name] ?? paths.chart} />
    </svg>
  );
}

function Select<T extends string>({ value, options, onChange, ariaLabel, compact = false }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
  compact?: boolean;
}) {
  return (
    <label className={`select-wrap ${compact ? "compact" : ""}`}>
      <span className="sr-only">{ariaLabel}</span>
      <select value={value} onChange={(event: { target: { value: string } }) => onChange(event.target.value as T)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
      <span className="select-chevron">⌄</span>
    </label>
  );
}

function Toggle({ checked, onChange, label, detail }: { checked: boolean; onChange: () => void; label: string; detail?: string }) {
  return (
    <button type="button" className="toggle-row" onClick={onChange} aria-pressed={checked}>
      <span><b>{label}</b>{detail && <small>{detail}</small>}</span>
      <span className={`switch ${checked ? "on" : ""}`}><span /></span>
    </button>
  );
}

function ema(candles: Candle[], period: number): Array<number | undefined> {
  const values: Array<number | undefined> = new Array(candles.length).fill(undefined);
  if (candles.length === 0) return values;
  const alpha = 2 / (period + 1);
  let current = candles[0].close;
  candles.forEach((candle, index) => {
    current = index === 0 ? candle.close : candle.close * alpha + current * (1 - alpha);
    values[index] = current;
  });
  return values;
}

function vwap(candles: Candle[]): Array<number | undefined> {
  let cumulativeVolume = 0;
  let cumulativeValue = 0;
  return candles.map((candle) => {
    const typical = (candle.high + candle.low + candle.close) / 3;
    cumulativeVolume += candle.volume;
    cumulativeValue += typical * candle.volume;
    return cumulativeVolume > 0 ? cumulativeValue / cumulativeVolume : undefined;
  });
}

function formatPrice(value: number | undefined, decimals: number): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatTime(timestamp: number, timeframe: Timeframe): string {
  const date = new Date(timestamp);
  if (timeframe === "1d") return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatTapeTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function calcChange(candles: Candle[]): number | undefined {
  if (candles.length < 2 || candles[0].open === 0) return undefined;
  return ((candles.at(-1)!.close - candles[0].open) / candles[0].open) * 100;
}

function linePath(values: Array<number | undefined>, xForIndex: (index: number) => number, yForPrice: (price: number) => number): string {
  let path = "";
  let started = false;
  values.forEach((value, index) => {
    if (value === undefined || !Number.isFinite(value)) return;
    path += `${started ? "L" : "M"}${xForIndex(index).toFixed(2)} ${yForPrice(value).toFixed(2)} `;
    started = true;
  });
  return path.trim();
}

function distanceToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function buildFootprintMap(candles: Candle[], trades: Trade[], priceStep: number): Map<number, FootprintLevel[]> {
  const output = new Map<number, Map<string, FootprintLevel>>();
  if (candles.length === 0 || trades.length === 0) return new Map();
  const first = candles[0].time;
  const lastEnd = candles.at(-1)!.endTime;
  const candidateTrades = trades.filter((trade) => trade.time >= first && trade.time <= lastEnd);
  for (const trade of candidateTrades) {
    const candle = candles.find((item) => trade.time >= item.time && trade.time <= item.endTime);
    if (!candle) continue;
    const roundedPrice = Number((Math.round(trade.price / priceStep) * priceStep).toPrecision(12));
    const key = roundedPrice.toPrecision(12);
    let candleLevels = output.get(candle.time);
    if (!candleLevels) {
      candleLevels = new Map();
      output.set(candle.time, candleLevels);
    }
    const level = candleLevels.get(key) ?? { price: roundedPrice, buy: 0, sell: 0 };
    level[trade.side] += trade.size;
    candleLevels.set(key, level);
  }
  return new Map(Array.from(output.entries()).map(([time, levels]) => [time, Array.from(levels.values()).sort((a, b) => b.price - a.price)]));
}

function ChartCanvas({
  candles,
  trades,
  market,
  timeframe,
  chartMode,
  flowMode,
  settings,
  ladder,
  largeTrades,
  largeTradeThreshold,
}: {
  candles: Candle[];
  trades: Trade[];
  market: MarketDefinition;
  timeframe: Timeframe;
  chartMode: ChartMode;
  flowMode: FlowMode;
  settings: Settings;
  ladder: BookLadder;
  largeTrades: TradeBurst[];
  largeTradeThreshold: number;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 1000, height: 650 });
  const [bars, setBars] = useState(90);
  const [offset, setOffset] = useState(0);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [tool, setTool] = useState<DrawingTool>("cursor");
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [draft, setDraft] = useState<Drawing | null>(null);
  const dragRef = useRef<{ startX: number; startOffset: number } | null>(null);
  const drawingIdRef = useRef(1);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const resize = () => setSize({ width: Math.max(1, element.clientWidth), height: Math.max(1, element.clientHeight) });
    resize();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", resize);
      return () => window.removeEventListener("resize", resize);
    }
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (settings.autoFollow) setOffset(0);
  }, [candles.length, settings.autoFollow]);

  const axisWidth = 88;
  const volumeHeight = settings.showVolume ? Math.max(70, size.height * 0.17) : 0;
  const plotWidth = Math.max(100, size.width - axisWidth);
  const priceHeight = Math.max(100, size.height - volumeHeight - 28);
  const end = Math.max(0, candles.length - offset);
  const start = Math.max(0, end - bars);
  const visible = candles.slice(start, end);
  const candleWidth = visible.length > 0 ? plotWidth / visible.length : plotWidth;

  const priceRange = useMemo(() => {
    if (visible.length === 0) return { min: 0, max: 1 };
    let min = Math.min(...visible.map((candle) => candle.low));
    let max = Math.max(...visible.map((candle) => candle.high));
    drawings.forEach((drawing) => {
      if (drawing.type === "hline") {
        min = Math.min(min, drawing.price);
        max = Math.max(max, drawing.price);
      }
    });
    const padding = Math.max((max - min) * 0.09, Math.abs(max) * 0.0004, 0.5);
    return { min: min - padding, max: max + padding };
  }, [visible, drawings]);

  const maxVolume = Math.max(1, ...visible.map((candle) => candle.volume));
  const xForVisibleIndex = (index: number) => (index + 0.5) * candleWidth;
  const yForPrice = (price: number) => ((priceRange.max - price) / (priceRange.max - priceRange.min)) * priceHeight;
  const priceForY = (y: number) => priceRange.max - (Math.max(0, Math.min(priceHeight, y)) / priceHeight) * (priceRange.max - priceRange.min);
  const timeForX = (x: number) => {
    if (visible.length === 0) return Date.now();
    const index = Math.max(0, Math.min(visible.length - 1, Math.floor(x / candleWidth)));
    return visible[index].time;
  };
  const xForTime = (time: number) => {
    if (visible.length === 0) return 0;
    const exactIndex = visible.findIndex((candle) => time >= candle.time && time <= candle.endTime);
    if (exactIndex >= 0) {
      const candle = visible[exactIndex];
      const fraction = Math.max(0.08, Math.min(0.92, (time - candle.time) / Math.max(1, candle.endTime - candle.time)));
      return (exactIndex + fraction) * candleWidth;
    }
    const laterIndex = visible.findIndex((candle) => candle.time >= time);
    return xForVisibleIndex(laterIndex >= 0 ? laterIndex : visible.length - 1);
  };

  const emaValues = useMemo(() => ema(visible, 20), [visible]);
  const vwapValues = useMemo(() => vwap(visible), [visible]);
  const footprintMap = useMemo(() => buildFootprintMap(visible, trades, Math.max(10 ** -market.priceDecimals, ladder.groupSize)), [visible, trades, market.priceDecimals, ladder.groupSize]);
  const visibleLargeTrades = largeTrades.filter((trade) => visible.length > 0 && trade.endTime >= visible[0].time && trade.time <= visible.at(-1)!.endTime);
  const largestLargeTrade = Math.max(1, ...visibleLargeTrades.map((trade) => trade.notional));
  const heatLevels = [...ladder.bids, ...ladder.asks];
  const priceTicks = Array.from({ length: 7 }, (_, index) => priceRange.max - ((priceRange.max - priceRange.min) * index) / 6);
  const timeTickStep = Math.max(1, Math.ceil(visible.length / 7));

  const pointerCoordinates = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const eraseAt = (x: number, y: number) => {
    const target = drawings.find((drawing) => {
      if (drawing.type === "hline") return Math.abs(yForPrice(drawing.price) - y) < 8;
      const x1 = xForTime(drawing.time1);
      const y1 = yForPrice(drawing.price1);
      const x2 = xForTime(drawing.time2);
      const y2 = yForPrice(drawing.price2);
      if (drawing.type === "trend") return distanceToSegment(x, y, x1, y1, x2, y2) < 10;
      return x >= Math.min(x1, x2) - 6 && x <= Math.max(x1, x2) + 6 && y >= Math.min(y1, y2) - 6 && y <= Math.max(y1, y2) + 6;
    });
    if (target) setDrawings((current) => current.filter((drawing) => drawing.id !== target.id));
  };

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    const point = pointerCoordinates(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "cursor") {
      dragRef.current = { startX: point.x, startOffset: offset };
      return;
    }
    if (tool === "erase") {
      eraseAt(point.x, point.y);
      return;
    }
    const time = timeForX(point.x);
    const price = priceForY(point.y);
    if (tool === "hline") {
      setDrawings((current) => [...current, { id: drawingIdRef.current++, type: "hline", price }]);
      return;
    }
    setDraft({ id: drawingIdRef.current++, type: tool, time1: time, price1: price, time2: time, price2: price });
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const point = pointerCoordinates(event);
    setCursor(point.x <= plotWidth && point.y <= priceHeight ? point : null);
    if (dragRef.current) {
      const deltaBars = Math.round((dragRef.current.startX - point.x) / Math.max(1, candleWidth));
      setOffset(Math.max(0, Math.min(Math.max(0, candles.length - 20), dragRef.current.startOffset + deltaBars)));
    }
    if (draft && draft.type !== "hline") setDraft({ ...draft, time2: timeForX(point.x), price2: priceForY(point.y) });
  };

  const onPointerUp = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
    if (draft) {
      setDrawings((current) => [...current, draft]);
      setDraft(null);
    }
  };

  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    setBars((current) => Math.max(16, Math.min(260, current + (event.deltaY > 0 ? 8 : -8))));
  };

  const allDrawings = draft ? [...drawings, draft] : drawings;
  const cursorIndex = cursor && visible.length > 0 ? Math.max(0, Math.min(visible.length - 1, Math.floor(cursor.x / candleWidth))) : -1;
  const cursorCandle = cursorIndex >= 0 ? visible[cursorIndex] : undefined;
  const cursorPrice = cursor ? priceForY(cursor.y) : undefined;
  const latestPrice = visible.at(-1)?.close;

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <div className="drawing-toolbar">
        {(["cursor", "trend", "hline", "rect", "erase"] as DrawingTool[]).map((item) => (
          <button key={item} className={tool === item ? "active" : ""} onClick={() => setTool(item)} title={item}>
            <Icon name={item} size={17} />
          </button>
        ))}
        <span className="toolbar-separator" />
        <button onClick={() => setDrawings([])} title="Clear drawings"><Icon name="trash" size={17} /></button>
        <button onClick={() => { setBars(90); setOffset(0); }} title="Reset chart"><Icon name="reset" size={17} /></button>
        <button onClick={() => setBars((current) => Math.max(16, current - 8))} title="Zoom in"><Icon name="plus" size={17} /></button>
        <button onClick={() => setBars((current) => Math.min(260, current + 8))} title="Zoom out"><Icon name="minus" size={17} /></button>
      </div>

      <div className="chart-legend">
        <span><i className="legend-dot large-buy" />Large buy</span>
        <span><i className="legend-dot large-sell" />Large sell</span>
        <span className="threshold">Adaptive ≥ ${formatNotional(largeTradeThreshold)}</span>
      </div>

      {visible.length === 0 ? <div className="chart-empty">Waiting for market data…</div> : (
        <svg className={`market-chart tool-${tool}`} width={size.width} height={size.height} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={() => setCursor(null)} onWheel={onWheel}>
          <defs>
            <clipPath id="plot-clip"><rect x="0" y="0" width={plotWidth} height={priceHeight} /></clipPath>
            <linearGradient id="buy-gradient" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#0a8c72" stopOpacity="0.03" /><stop offset="1" stopColor="#26e0b4" stopOpacity="0.22" /></linearGradient>
            <linearGradient id="sell-gradient" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stopColor="#a72e52" stopOpacity="0.03" /><stop offset="1" stopColor="#ff5b7f" stopOpacity="0.22" /></linearGradient>
            <filter id="trade-glow"><feGaussianBlur stdDeviation="2.2" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
          </defs>

          <rect width={size.width} height={size.height} fill="#060a11" />
          {settings.showGrid && priceTicks.map((price) => <line key={price} x1="0" x2={plotWidth} y1={yForPrice(price)} y2={yForPrice(price)} className="grid-line" />)}
          {settings.showGrid && visible.map((candle, index) => index % timeTickStep === 0 ? <line key={candle.time} x1={xForVisibleIndex(index)} x2={xForVisibleIndex(index)} y1="0" y2={priceHeight} className="grid-line vertical" /> : null)}

          <g clipPath="url(#plot-clip)">
            {settings.showBookHeatmap && heatLevels.map((level, index) => {
              const y = yForPrice(level.price);
              if (y < -8 || y > priceHeight + 8) return null;
              const isBid = index < ladder.bids.length;
              const intensity = Math.max(0.08, Math.min(1, level.size / ladder.maxSize));
              const width = plotWidth * (0.14 + 0.5 * intensity);
              return <rect key={`${isBid ? "b" : "a"}-${level.price}`} x={plotWidth - width} y={y - 3.5} width={width} height="7" fill={isBid ? "url(#buy-gradient)" : "url(#sell-gradient)"} opacity={0.35 + intensity * 0.65} />;
            })}

            {visible.map((candle, index) => {
              const x = xForVisibleIndex(index);
              const openY = yForPrice(candle.open);
              const closeY = yForPrice(candle.close);
              const highY = yForPrice(candle.high);
              const lowY = yForPrice(candle.low);
              const up = candle.close >= candle.open;
              const bodyTop = Math.min(openY, closeY);
              const bodyHeight = Math.max(1.5, Math.abs(closeY - openY));
              const bodyWidth = Math.max(1.5, candleWidth * 0.58);
              const buy = candle.buyVolume;
              const sell = candle.sellVolume;
              const delta = buy !== undefined && sell !== undefined ? buy - sell : undefined;
              const showBuy = flowMode !== "sell";
              const showSell = flowMode !== "buy";
              const levels = footprintMap.get(candle.time) ?? [];
              const showTrueFootprint = chartMode === "footprint" && candleWidth >= 38 && levels.length > 0;
              return (
                <g key={candle.time}>
                  <line x1={x} x2={x} y1={highY} y2={lowY} className={up ? "candle-up" : "candle-down"} />
                  {chartMode === "delta" ? (
                    <rect x={x - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} className={delta === undefined ? "candle-neutral" : delta >= 0 ? "candle-up-fill" : "candle-down-fill"} opacity={delta === undefined ? 0.35 : Math.min(1, 0.35 + Math.abs(delta) / Math.max(candle.volume, 1))} />
                  ) : (
                    <rect x={x - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} className={up ? "candle-up-fill" : "candle-down-fill"} opacity={showTrueFootprint ? 0.28 : 1} />
                  )}
                  {showTrueFootprint && levels.map((level) => {
                    const y = yForPrice(level.price);
                    const total = Math.max(1e-9, level.buy + level.sell);
                    const buyStrength = level.buy / total;
                    const sellStrength = level.sell / total;
                    return (
                      <g key={level.price} className="footprint-level">
                        {showSell && <rect x={x - candleWidth * 0.47} y={y - 5} width={candleWidth * 0.45 * sellStrength} height="10" className="footprint-sell-bg" />}
                        {showBuy && <rect x={x + candleWidth * 0.02} y={y - 5} width={candleWidth * 0.45 * buyStrength} height="10" className="footprint-buy-bg" />}
                        {showSell && <text x={x - 2} y={y + 2.5} textAnchor="end" className="sell-text">{formatBookSize(level.sell, market.quantityDecimals)}</text>}
                        {showBuy && <text x={x + 2} y={y + 2.5} textAnchor="start" className="buy-text">{formatBookSize(level.buy, market.quantityDecimals)}</text>}
                      </g>
                    );
                  })}
                  {chartMode === "footprint" && !showTrueFootprint && candleWidth >= 24 && (
                    <g className="footprint-labels">
                      {buy !== undefined && sell !== undefined ? <>
                        {showSell && <text x={x - 3} y={bodyTop + bodyHeight / 2 + 3} textAnchor="end" className="sell-text">{formatBookSize(sell, market.quantityDecimals)}</text>}
                        {showBuy && <text x={x + 3} y={bodyTop + bodyHeight / 2 + 3} textAnchor="start" className="buy-text">{formatBookSize(buy, market.quantityDecimals)}</text>}
                      </> : <text x={x} y={bodyTop + bodyHeight / 2 + 3} textAnchor="middle" className="volume-text">{formatCompact(candle.volume)}</text>}
                    </g>
                  )}
                </g>
              );
            })}

            {settings.showVWAP && <path d={linePath(vwapValues, xForVisibleIndex, yForPrice)} className="indicator vwap" />}
            {settings.showEMA && <path d={linePath(emaValues, xForVisibleIndex, yForPrice)} className="indicator ema" />}

            {settings.showLargeTrades && visibleLargeTrades.map((trade, index) => {
              const x = xForTime(trade.time);
              const y = yForPrice(trade.price);
              const ratio = Math.sqrt(trade.notional / largestLargeTrade);
              const radius = 5 + ratio * 9;
              const label = trade.notional >= Math.max(largeTradeThreshold * 1.4, largestLargeTrade * 0.42);
              const labelY = trade.side === "buy" ? y - radius - 8 - (index % 2) * 12 : y + radius + 17 + (index % 2) * 12;
              return (
                <g key={trade.id} className={`large-trade-marker ${trade.side}`} filter="url(#trade-glow)">
                  <title>{`${trade.side.toUpperCase()} · $${formatNotional(trade.notional)} · ${trade.count} prints · ${formatPrice(trade.price, market.priceDecimals)}`}</title>
                  <circle cx={x} cy={y} r={radius + 4} className="large-trade-halo" />
                  <circle cx={x} cy={y} r={radius} className="large-trade-core" />
                  <circle cx={x} cy={y} r="2" className="large-trade-center" />
                  {label && <g className="large-trade-label"><rect x={x - 25} y={labelY - 11} width="50" height="16" rx="4" /><text x={x} y={labelY} textAnchor="middle">${formatNotional(trade.notional)}</text></g>}
                </g>
              );
            })}

            {latestPrice !== undefined && <line x1="0" x2={plotWidth} y1={yForPrice(latestPrice)} y2={yForPrice(latestPrice)} className="last-price-line" />}

            {allDrawings.map((drawing) => {
              if (drawing.type === "hline") {
                const y = yForPrice(drawing.price);
                return <g key={drawing.id}><line x1="0" x2={plotWidth} y1={y} y2={y} className="drawing-line horizontal" /><text x={plotWidth - 6} y={y - 5} textAnchor="end" className="drawing-label">{formatPrice(drawing.price, market.priceDecimals)}</text></g>;
              }
              const x1 = xForTime(drawing.time1);
              const y1 = yForPrice(drawing.price1);
              const x2 = xForTime(drawing.time2);
              const y2 = yForPrice(drawing.price2);
              return drawing.type === "trend"
                ? <line key={drawing.id} x1={x1} y1={y1} x2={x2} y2={y2} className="drawing-line" />
                : <rect key={drawing.id} x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)} className="drawing-rect" />;
            })}
          </g>

          {settings.showVolume && <g transform={`translate(0 ${priceHeight + 10})`}>
            {visible.map((candle, index) => {
              const x = xForVisibleIndex(index);
              const height = (candle.volume / maxVolume) * Math.max(1, volumeHeight - 25);
              return <rect key={candle.time} x={x - Math.max(1, candleWidth * 0.32)} y={volumeHeight - 25 - height} width={Math.max(2, candleWidth * 0.64)} height={height} className={candle.close >= candle.open ? "volume-up" : "volume-down"} />;
            })}
            <text x="8" y="14" className="panel-label">REAL VOLUME</text>
          </g>}

          <rect x={plotWidth} y="0" width={axisWidth} height={size.height} className="axis-bg" />
          {priceTicks.map((price) => <text key={price} x={plotWidth + 10} y={yForPrice(price) + 4} className="axis-label">{formatPrice(price, market.priceDecimals)}</text>)}
          {visible.map((candle, index) => index % timeTickStep === 0 ? <text key={candle.time} x={xForVisibleIndex(index)} y={size.height - 8} textAnchor="middle" className="time-label">{formatTime(candle.time, timeframe)}</text> : null)}
          {latestPrice !== undefined && <g><rect x={plotWidth} y={yForPrice(latestPrice) - 11} width={axisWidth} height="22" className="last-price-bg" /><text x={plotWidth + 8} y={yForPrice(latestPrice) + 4} className="last-price-text">{formatPrice(latestPrice, market.priceDecimals)}</text></g>}

          {cursor && cursor.x <= plotWidth && cursor.y <= priceHeight && <g pointerEvents="none">
            <line x1={cursor.x} x2={cursor.x} y1="0" y2={priceHeight} className="crosshair" />
            <line x1="0" x2={plotWidth} y1={cursor.y} y2={cursor.y} className="crosshair" />
            <rect x={plotWidth} y={cursor.y - 11} width={axisWidth} height="22" className="crosshair-price-bg" />
            <text x={plotWidth + 8} y={cursor.y + 4} className="crosshair-price">{formatPrice(cursorPrice, market.priceDecimals)}</text>
          </g>}
        </svg>
      )}

      {cursorCandle && <div className="ohlc-strip">
        <span>{formatTime(cursorCandle.time, timeframe)}</span>
        <span>O <b>{formatPrice(cursorCandle.open, market.priceDecimals)}</b></span>
        <span>H <b>{formatPrice(cursorCandle.high, market.priceDecimals)}</b></span>
        <span>L <b>{formatPrice(cursorCandle.low, market.priceDecimals)}</b></span>
        <span>C <b>{formatPrice(cursorCandle.close, market.priceDecimals)}</b></span>
        <span>V <b>{formatCompact(cursorCandle.volume)}</b></span>
        {cursorCandle.buyVolume === undefined && <em>Historical aggressor split unavailable; live footprint starts after connection</em>}
      </div>}
    </div>
  );
}

function OrderBookPanel({ ladder, market, groupValue, groupOptions, onGroupChange, stale }: {
  ladder: BookLadder;
  market: MarketDefinition;
  groupValue: string;
  groupOptions: Array<{ value: string; label: string }>;
  onGroupChange: (value: string) => void;
  stale: boolean;
}) {
  const asks = ladder.asks.slice().reverse();
  const imbalancePct = ladder.imbalance * 100;
  const row = (level: BookLadder["bids"][number], side: "ask" | "bid", index: number) => {
    const depth = (level.size / ladder.maxSize) * 100;
    const wall = depth >= 72;
    return (
      <div className={`book-row ${side} ${index === (side === "ask" ? asks.length - 1 : 0) ? "best" : ""} ${wall ? "wall" : ""}`} key={`${side}-${level.price}`}>
        <span className="book-depth" style={{ "--depth": `${depth}%` } as CSSProperties} />
        <span className="book-price">{formatPrice(level.price, market.priceDecimals)}</span>
        <span>{formatBookSize(level.size, market.quantityDecimals)}</span>
        <span>{formatBookSize(level.cumulativeSize, market.quantityDecimals)}</span>
      </div>
    );
  };

  return (
    <section className="side-card order-book-card">
      <header>
        <div><small>LIVE DEPTH</small><h3>Order book</h3></div>
        <Select value={groupValue} ariaLabel="Order book grouping" onChange={onGroupChange} compact options={groupOptions} />
        <span className={`live-pill ${stale ? "stale" : ""}`}>{stale ? "STALE" : "LIVE"}</span>
      </header>
      <div className="book-pressure">
        <div className="pressure-copy"><span>BID {formatBookSize(ladder.bidTotal, market.quantityDecimals)}</span><b>{imbalancePct.toFixed(0)}% / {(100 - imbalancePct).toFixed(0)}%</b><span>ASK {formatBookSize(ladder.askTotal, market.quantityDecimals)}</span></div>
        <div className="pressure-bar"><span style={{ width: `${imbalancePct}%` }} /></div>
      </div>
      <div className="book-head"><span>Price</span><span>Size</span><span>Cum.</span></div>
      <div className="book-list asks">{asks.map((level, index) => row(level, "ask", index))}</div>
      <div className="spread-row">
        <div><small>ASK</small><b>{formatPrice(ladder.bestAsk, market.priceDecimals)}</b></div>
        <div className="spread-core"><strong>{ladder.spread === undefined ? "—" : formatPrice(ladder.spread, market.priceDecimals)}</strong><span>{ladder.spreadBps === undefined ? "spread" : `${ladder.spreadBps.toFixed(2)} bps`}</span></div>
        <div><small>BID</small><b>{formatPrice(ladder.bestBid, market.priceDecimals)}</b></div>
      </div>
      <div className="book-list bids">{ladder.bids.map((level, index) => row(level, "bid", index))}</div>
      <footer className="book-footer"><span>Mid <b>{formatPrice(ladder.mid, market.priceDecimals)}</b></span><span>Micro <b>{formatPrice(ladder.microPrice, market.priceDecimals)}</b></span><span>Group <b>{ladder.groupSize}</b></span></footer>
    </section>
  );
}

function LargePrintsPanel({ trades, threshold, market }: { trades: TradeBurst[]; threshold: number; market: MarketDefinition }) {
  return (
    <section className="side-card large-prints-card">
      <header><div><small>ADAPTIVE TAPE FILTER</small><h3>Large prints</h3></div><span className="threshold-pill">≥ ${formatNotional(threshold)}</span></header>
      <div className="large-print-list">
        {trades.slice(-7).reverse().map((trade) => <div className={`large-print-row ${trade.side}`} key={trade.id}>
          <span className="large-print-side"><i />{trade.side.toUpperCase()}</span>
          <span>{formatTapeTime(trade.time)}</span>
          <span>{formatPrice(trade.price, market.priceDecimals)}</span>
          <b>${formatNotional(trade.notional)}</b>
          <small>{trade.count > 1 ? `${trade.count} fills` : "1 fill"}</small>
        </div>)}
        {trades.length === 0 && <div className="empty-list">Collecting enough prints to establish an adaptive threshold…</div>}
      </div>
    </section>
  );
}

function TradesPanel({ trades, market, largeThreshold }: { trades: Trade[]; market: MarketDefinition; largeThreshold: number }) {
  return (
    <section className="side-card trades-card">
      <header><div><small>TIME & SALES</small><h3>Recent trades</h3></div><span className="tape-count">{trades.length}</span></header>
      <div className="trade-head"><span>Time</span><span>Price</span><span>Size</span></div>
      <div className="trade-list">
        {trades.slice(-18).reverse().map((trade) => {
          const notional = trade.price * trade.size;
          return <div className={`trade-row ${trade.side} ${notional >= largeThreshold ? "large" : ""}`} key={trade.id}>
            <span>{formatTapeTime(trade.time)}</span>
            <span>{formatPrice(trade.price, market.priceDecimals)}</span>
            <span>{formatBookSize(trade.size, market.quantityDecimals)}</span>
          </div>;
        })}
        {trades.length === 0 && <div className="empty-list">Waiting for live trades…</div>}
      </div>
    </section>
  );
}

function MetricCard({ label, value, detail, tone }: { label: string; value: string; detail?: string; tone?: "positive" | "negative" | "neutral" }) {
  return <div className={`metric-card ${tone ?? "neutral"}`}><span>{label}</span><b>{value}</b>{detail && <small>{detail}</small>}</div>;
}

function App() {
  const [tab, setTab] = useState<AppTab>("chart");
  const [symbol, setSymbol] = usePersistentState<SymbolKey>("veilflow.symbol", "BTC");
  const [timeframe, setTimeframe] = usePersistentState<Timeframe>("veilflow.timeframe", "5m");
  const [chartMode, setChartMode] = usePersistentState<ChartMode>("veilflow.chartMode", "candles");
  const [flowMode, setFlowMode] = usePersistentState<FlowMode>("veilflow.flowMode", "both");
  const [historyBars, setHistoryBars] = usePersistentState<number>("veilflow.historyBars", 720);
  const [bookGroup, setBookGroup] = usePersistentState<string>("veilflow.bookGroup", "auto");
  const [settings, setSettings] = usePersistentSettings("veilflow.settings");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [book, setBook] = useState<OrderBook | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [metrics, setMetrics] = useState<MarketMetrics>({});
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [connectionDetail, setConnectionDetail] = useState("");
  const [error, setError] = useState("");
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [indicatorOpen, setIndicatorOpen] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const [now, setNow] = useState(Date.now());
  const seenTradeIds = useRef(new Set<string>());

  const market = MARKETS[symbol];

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const abortController = new AbortController();
    let stream: ReturnType<typeof streamMarket> | null = null;
    setCandles([]);
    setBook(null);
    setTrades([]);
    setMetrics({});
    setError("");
    setConnection("connecting");
    setConnectionDetail("loading history");
    seenTradeIds.current.clear();

    loadMarketSnapshot(market, timeframe, historyBars, abortController.signal)
      .then((snapshot) => {
        if (abortController.signal.aborted) return;
        setCandles(snapshot.candles);
        setBook(snapshot.book);
        setMetrics(snapshot.metrics);
        setLastUpdate(Date.now());
        setReplayIndex(Math.max(0, snapshot.candles.length - 120));
        stream = streamMarket(market, timeframe, {
          onCandle: (candle) => {
            setCandles((current) => mergeCandle(current, candle));
            setLastUpdate(Date.now());
          },
          onBook: (nextBook) => {
            setBook(nextBook);
            setLastUpdate(Date.now());
          },
          onTrades: (nextTrades) => {
            const unique = nextTrades.filter((trade) => {
              if (!trade.id || seenTradeIds.current.has(trade.id)) return false;
              seenTradeIds.current.add(trade.id);
              return true;
            });
            if (seenTradeIds.current.size > 10_000) seenTradeIds.current = new Set(Array.from(seenTradeIds.current).slice(-5_000));
            if (unique.length === 0) return;
            setTrades((current) => [...current, ...unique].slice(-900));
            if (market.provider === "Hyperliquid") {
              setCandles((current) => {
                const next = current.slice();
                unique.forEach((trade) => {
                  const index = next.findIndex((candle) => trade.time >= candle.time && trade.time <= candle.endTime);
                  if (index < 0) return;
                  const candle = next[index];
                  next[index] = {
                    ...candle,
                    buyVolume: (candle.buyVolume ?? 0) + (trade.side === "buy" ? trade.size : 0),
                    sellVolume: (candle.sellVolume ?? 0) + (trade.side === "sell" ? trade.size : 0),
                  };
                });
                return next;
              });
            }
            setLastUpdate(Date.now());
          },
          onMetrics: setMetrics,
          onState: (state, detail) => {
            setConnection(state);
            setConnectionDetail(detail ?? "");
          },
        });
      })
      .catch((reason: unknown) => {
        if (abortController.signal.aborted) return;
        const message = reason instanceof Error ? reason.message : "Unknown market-data error";
        setError(message);
        setConnection("error");
        setConnectionDetail(message);
      });

    return () => {
      abortController.abort();
      stream?.close();
    };
  }, [market, timeframe, historyBars, refreshKey]);

  useEffect(() => {
    if (tab !== "replay" || !replayPlaying) return;
    const timer = window.setInterval(() => {
      setReplayIndex((current) => {
        if (current >= candles.length - 1) {
          setReplayPlaying(false);
          return current;
        }
        return Math.min(candles.length - 1, current + replaySpeed);
      });
    }, 420);
    return () => window.clearInterval(timer);
  }, [tab, replayPlaying, replaySpeed, candles.length]);

  const enterTab = (next: AppTab) => {
    setTab(next);
    if (next === "replay") {
      setReplayPlaying(false);
      setReplayIndex(Math.max(0, candles.length - 120));
    }
  };

  const displayCandles = tab === "replay" ? candles.slice(0, replayIndex + 1) : candles;
  const lastCandle = displayCandles.at(-1);
  const currentPrice = lastCandle?.close ?? metrics.markPrice;
  const groupOptions = useMemo(() => bookGroupOptions(market, currentPrice), [market, currentPrice]);
  const groupSize = resolveBookGroup(bookGroup, market, currentPrice);
  const ladder = useMemo(() => buildBookLadder(book, groupSize, 16), [book, groupSize]);
  const largeTradeResult = useMemo(() => detectLargeTrades(trades, settings.largeTradeSensitivity), [trades, settings.largeTradeSensitivity]);
  const change = calcChange(displayCandles.slice(-Math.min(displayCandles.length, 288)));
  const sourceLag = lastUpdate ? now - lastUpdate : undefined;
  const bookLag = book ? now - book.time : undefined;
  const bookStale = bookLag === undefined || bookLag > 6_000;
  const largePrintDelta = largeTradeResult.buyNotional - largeTradeResult.sellNotional;
  const largePrintTotal = largeTradeResult.buyNotional + largeTradeResult.sellNotional;
  const cvd = displayCandles.slice(-200).reduce((sum, candle) => sum + ((candle.buyVolume ?? 0) - (candle.sellVolume ?? 0)), 0);

  const toggleSetting = (key: keyof Omit<Settings, "largeTradeSensitivity">) => {
    setSettings((current) => ({ ...DEFAULT_SETTINGS, ...current, [key]: !current[key] }));
  };

  const exportCsv = () => {
    const header = "time,open,high,low,close,volume,buyVolume,sellVolume,trades\n";
    const rows = candles.map((candle) => [
      new Date(candle.time).toISOString(), candle.open, candle.high, candle.low, candle.close, candle.volume,
      candle.buyVolume ?? "", candle.sellVolume ?? "", candle.trades ?? "",
    ].join(",")).join("\n");
    const blob = new Blob([header + rows], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `veilflow-${symbol}-${timeframe}-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">V</span><div><b>VEILFLOW</b><small>PRO ORDER-FLOW WORKSPACE</small></div></div>
        <nav className="main-nav" aria-label="Main navigation">
          <button className={tab === "chart" ? "active" : ""} onClick={() => enterTab("chart")}><Icon name="chart" />Chart</button>
          <button className={tab === "replay" ? "active" : ""} onClick={() => enterTab("replay")}><Icon name="replay" />Replay</button>
        </nav>
        <div className="top-actions">
          <div className={`connection-chip ${connection}`}><span />{connection}<small>{connectionDetail}</small></div>
          <button className="icon-button" onClick={() => setRefreshKey((current) => current + 1)} title="Reconnect market data"><Icon name="refresh" /></button>
          <button className="icon-button" onClick={exportCsv} title="Export candles as CSV"><Icon name="download" /></button>
          <button className={`icon-button ${settingsOpen ? "active" : ""}`} onClick={() => setSettingsOpen((current) => !current)} title="Settings"><Icon name="settings" /></button>
        </div>
      </header>

      <div className="controlbar">
        <div className="symbol-control">
          <Select value={symbol} ariaLabel="Market" onChange={(value) => { setSymbol(value); setBookGroup("auto"); }} options={(Object.keys(MARKETS) as SymbolKey[]).map((key) => ({ value: key, label: `${MARKETS[key].shortLabel} · ${MARKETS[key].provider}` }))} />
          <div className="instrument-copy"><b>{market.label}</b><span>{market.providerSymbol}</span></div>
        </div>
        <div className="control-divider" />
        <Select value={chartMode} ariaLabel="Chart mode" onChange={setChartMode} options={[{ value: "candles", label: "Candles" }, { value: "footprint", label: "Footprint" }, { value: "delta", label: "Delta" }]} />
        <Select value={flowMode} ariaLabel="Flow filter" onChange={setFlowMode} options={[{ value: "both", label: "Buy × Sell" }, { value: "buy", label: "Buy only" }, { value: "sell", label: "Sell only" }]} />
        <Select value={timeframe} ariaLabel="Timeframe" onChange={setTimeframe} options={TIMEFRAMES.map((value) => ({ value, label: value }))} />
        <Select value={String(historyBars)} ariaLabel="History length" onChange={(value) => setHistoryBars(Number(value))} options={[{ value: "360", label: "360 bars" }, { value: "720", label: "720 bars" }, { value: "1200", label: "1,200 bars" }]} />
        <button className={`indicator-button ${indicatorOpen ? "active" : ""}`} onClick={() => setIndicatorOpen((current) => !current)}>ƒx Indicators</button>
        <div className="flow-status">
          <span className={largePrintDelta >= 0 ? "buy" : "sell"}><Icon name="bolt" size={13} />Print Δ ${formatNotional(Math.abs(largePrintDelta))}</span>
          <span>Book {Math.round(ladder.imbalance * 100)}% bid</span>
        </div>
        <div className="source-note"><span className={market.provider === "Binance" ? "binance" : "hyperliquid"}>{market.provider}</span><p>{market.description}</p></div>
      </div>

      {tab === "replay" && <div className="replaybar">
        <button onClick={() => setReplayPlaying((current) => !current)}><Icon name={replayPlaying ? "pause" : "play"} />{replayPlaying ? "Pause" : "Play"}</button>
        <button onClick={() => setReplayIndex((current) => Math.max(0, Math.min(candles.length - 1, current + 1)))}><Icon name="step" />Step</button>
        <button onClick={() => { setReplayPlaying(false); setReplayIndex(Math.max(0, candles.length - 120)); }}><Icon name="reset" />Reset</button>
        <Select value={String(replaySpeed)} ariaLabel="Replay speed" onChange={(value) => setReplaySpeed(Number(value))} options={[{ value: "1", label: "1×" }, { value: "2", label: "2×" }, { value: "5", label: "5×" }, { value: "10", label: "10×" }]} />
        <input type="range" min="0" max={Math.max(0, candles.length - 1)} value={Math.min(replayIndex, Math.max(0, candles.length - 1))} onChange={(event: { target: { value: string } }) => setReplayIndex(Number(event.target.value))} />
        <span>{Math.min(replayIndex + 1, candles.length)} / {candles.length} bars</span>
      </div>}

      {error && <div className="error-banner"><b>Market data unavailable.</b><span>{error}</span><button onClick={() => setRefreshKey((current) => current + 1)}>Retry</button></div>}

      <main className="workspace">
        <section className="chart-column">
          <div className="market-header">
            <div className="market-title"><small>{market.shortLabel} · {timeframe} · {tab === "replay" ? "REPLAY" : "LIVE"}</small><h1>{formatPrice(currentPrice, market.priceDecimals)}</h1><span className={change !== undefined && change < 0 ? "negative" : "positive"}>{change === undefined ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}</span></div>
            <div className="market-meta">
              <span>Source <b>{market.provider}</b></span>
              <span>Update <b>{sourceLag === undefined ? "—" : `${Math.max(0, Math.round(sourceLag / 1000))}s`}</b></span>
              <span>Bars <b>{displayCandles.length.toLocaleString()}</b></span>
              <span>Spread <b>{ladder.spreadBps === undefined ? "—" : `${ladder.spreadBps.toFixed(2)} bps`}</b></span>
              <span>Large filter <b>${formatNotional(largeTradeResult.threshold)}</b></span>
            </div>
          </div>
          <ChartCanvas candles={displayCandles} trades={trades} market={market} timeframe={timeframe} chartMode={chartMode} flowMode={flowMode} settings={settings} ladder={ladder} largeTrades={largeTradeResult.bursts} largeTradeThreshold={largeTradeResult.threshold} />
          <div className="bottom-metrics">
            <MetricCard label="Book imbalance" value={`${Math.round(ladder.imbalance * 100)}% bid`} detail={`Depth ${formatBookSize(ladder.bidTotal, market.quantityDecimals)} / ${formatBookSize(ladder.askTotal, market.quantityDecimals)}`} tone={ladder.imbalance >= 0.54 ? "positive" : ladder.imbalance <= 0.46 ? "negative" : "neutral"} />
            <MetricCard label="Large-print delta" value={`${largePrintDelta >= 0 ? "+" : "−"}$${formatNotional(Math.abs(largePrintDelta))}`} detail={`Filtered total $${formatNotional(largePrintTotal)}`} tone={largePrintDelta >= 0 ? "positive" : "negative"} />
            <MetricCard label="Cumulative delta" value={`${cvd >= 0 ? "+" : ""}${formatCompact(cvd)}`} detail="Loaded aggressor volume" tone={cvd >= 0 ? "positive" : "negative"} />
            <MetricCard label="Open interest" value={formatCompact(metrics.openInterest)} detail={market.provider === "Hyperliquid" ? "contracts" : "not provided"} />
            <MetricCard label="24h volume" value={formatCompact(metrics.dayVolume)} detail={market.provider === "Hyperliquid" ? "notional" : "base volume"} />
            <MetricCard label="Funding / hour" value={metrics.fundingRate === undefined ? "—" : `${(metrics.fundingRate * 100).toFixed(4)}%`} detail={market.provider === "Binance" ? "spot market" : "perpetual"} tone={metrics.fundingRate !== undefined && metrics.fundingRate < 0 ? "negative" : "neutral"} />
          </div>
        </section>

        <aside className="right-sidebar">
          <OrderBookPanel ladder={ladder} market={market} groupValue={bookGroup} groupOptions={groupOptions.map(({ value, label }) => ({ value, label }))} onGroupChange={setBookGroup} stale={bookStale} />
          <LargePrintsPanel trades={largeTradeResult.bursts} threshold={largeTradeResult.threshold} market={market} />
          <TradesPanel trades={trades} market={market} largeThreshold={largeTradeResult.threshold} />
        </aside>
      </main>

      {indicatorOpen && <div className="floating-panel indicator-panel">
        <header><div><small>OVERLAYS</small><h2>Order-flow layers</h2></div><button onClick={() => setIndicatorOpen(false)}><Icon name="close" /></button></header>
        <Toggle checked={settings.showLargeTrades} onChange={() => toggleSetting("showLargeTrades")} label="Adaptive large prints" detail="Aggregates rapid fills and marks outlier notional" />
        <Toggle checked={settings.showBookHeatmap} onChange={() => toggleSetting("showBookHeatmap")} label="Grouped depth heatmap" detail="Uses normalized book levels, not duplicated raw rows" />
        <Toggle checked={settings.showEMA} onChange={() => toggleSetting("showEMA")} label="EMA 20" />
        <Toggle checked={settings.showVWAP} onChange={() => toggleSetting("showVWAP")} label="Session VWAP" />
        <Toggle checked={settings.showVolume} onChange={() => toggleSetting("showVolume")} label="Volume histogram" />
        <p>Footprint mode uses real live trades binned by price. Historical Hyperliquid candles do not include aggressor-side price-level data, so their footprint fills progressively after connection.</p>
      </div>}

      {settingsOpen && <div className="drawer-backdrop" onMouseDown={() => setSettingsOpen(false)}>
        <aside className="settings-drawer" onMouseDown={(event: { stopPropagation: () => void }) => event.stopPropagation()}>
          <header><div><small>WORKSPACE</small><h2>Order-flow settings</h2></div><button onClick={() => setSettingsOpen(false)}><Icon name="close" /></button></header>
          <section><h3>Chart</h3><Toggle checked={settings.showGrid} onChange={() => toggleSetting("showGrid")} label="Grid" /><Toggle checked={settings.showVolume} onChange={() => toggleSetting("showVolume")} label="Volume" /><Toggle checked={settings.autoFollow} onChange={() => toggleSetting("autoFollow")} label="Auto-follow latest bar" /></section>
          <section><h3>Order flow</h3><Toggle checked={settings.showBookHeatmap} onChange={() => toggleSetting("showBookHeatmap")} label="Grouped order-book heatmap" /><Toggle checked={settings.showLargeTrades} onChange={() => toggleSetting("showLargeTrades")} label="Large-print bubbles" /><label className="settings-field"><span>Large-print sensitivity<small>More shows more adaptive outliers; strict only shows extreme bursts.</small></span><Select value={settings.largeTradeSensitivity} ariaLabel="Large trade sensitivity" onChange={(value) => setSettings((current) => ({ ...current, largeTradeSensitivity: value }))} options={[{ value: "more", label: "More" }, { value: "balanced", label: "Balanced" }, { value: "strict", label: "Strict" }]} /></label></section>
          <section><h3>Indicators</h3><Toggle checked={settings.showEMA} onChange={() => toggleSetting("showEMA")} label="EMA 20" /><Toggle checked={settings.showVWAP} onChange={() => toggleSetting("showVWAP")} label="VWAP" /></section>
          <button className="reset-settings" onClick={() => { setSettings(DEFAULT_SETTINGS); setBookGroup("auto"); }}>Restore professional defaults</button>
          <div className="data-disclaimer"><b>Data integrity</b><p>BTC uses Binance BTCUSDT spot. NQ and ES are Hyperliquid perpetual proxies, not CME futures. The ladder groups raw levels before rendering to prevent duplicate rounded prices and misleading depth bars.</p></div>
        </aside>
      </div>}
    </div>
  );
}

export default App;
