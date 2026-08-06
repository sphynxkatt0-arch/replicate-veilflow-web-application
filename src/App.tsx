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
  type BookLevel,
  type Candle,
  type MarketDefinition,
  type MarketMetrics,
  type OrderBook,
  type SymbolKey,
  type Timeframe,
  type Trade,
} from "./lib/marketData";

type ConnectionState = "connecting" | "live" | "reconnecting" | "closed" | "error";
type ChartMode = "candles" | "footprint" | "delta";
type FlowMode = "both" | "buy" | "sell";
type AppTab = "chart" | "replay";
type DrawingTool = "cursor" | "trend" | "hline" | "rect" | "erase";

type Settings = {
  showVolume: boolean;
  showBookHeatmap: boolean;
  showLargeTrades: boolean;
  showVWAP: boolean;
  showEMA: boolean;
  showGrid: boolean;
  autoFollow: boolean;
};

type Drawing =
  | { id: number; type: "hline"; price: number }
  | { id: number; type: "trend" | "rect"; time1: number; price1: number; time2: number; price2: number };

const DEFAULT_SETTINGS: Settings = {
  showVolume: true,
  showBookHeatmap: true,
  showLargeTrades: true,
  showVWAP: true,
  showEMA: true,
  showGrid: true,
  autoFollow: true,
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
  const update = useCallback(
    (value: T | ((current: T) => T)) => {
      setState((current) => {
        const next = typeof value === "function" ? (value as (current: T) => T)(current) : value;
        window.localStorage.setItem(key, JSON.stringify(next));
        return next;
      });
    },
    [key],
  );
  return [state, update];
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
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name] ?? paths.chart} />
    </svg>
  );
}

function Select<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; ariaLabel: string }) {
  return (
    <label className="select-wrap">
      <span className="sr-only">{ariaLabel}</span>
      <select value={value} onChange={(event: { target: { value: string } }) => onChange(event.target.value as T)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      <span className="select-chevron">⌄</span>
    </label>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button type="button" className="toggle-row" onClick={onChange} aria-pressed={checked}>
      <span>{label}</span>
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

function ChartCanvas({
  candles,
  book,
  trades,
  market,
  timeframe,
  chartMode,
  flowMode,
  settings,
}: {
  candles: Candle[];
  book: OrderBook | null;
  trades: Trade[];
  market: MarketDefinition;
  timeframe: Timeframe;
  chartMode: ChartMode;
  flowMode: FlowMode;
  settings: Settings;
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
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    setSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (settings.autoFollow) setOffset(0);
  }, [candles.length, settings.autoFollow]);

  const axisWidth = 84;
  const volumeHeight = settings.showVolume ? Math.max(76, size.height * 0.18) : 0;
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
    const padding = Math.max((max - min) * 0.08, Math.abs(max) * 0.0005, 0.5);
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
    const index = visible.findIndex((candle) => candle.time >= time);
    return xForVisibleIndex(index >= 0 ? index : visible.length - 1);
  };

  const emaValues = useMemo(() => ema(visible, 20), [visible]);
  const vwapValues = useMemo(() => vwap(visible), [visible]);

  const priceTicks = Array.from({ length: 7 }, (_, index) => priceRange.max - ((priceRange.max - priceRange.min) * index) / 6);
  const timeTickStep = Math.max(1, Math.ceil(visible.length / 7));
  const largestTrade = Math.max(1, ...trades.slice(-60).map((trade) => trade.size));
  const heatLevels = book ? [...book.bids, ...book.asks] : [];
  const maxBookSize = Math.max(1, ...heatLevels.map((level) => level.size));

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
    if (draft && draft.type !== "hline") {
      setDraft({ ...draft, time2: timeForX(point.x), price2: priceForY(point.y) });
    }
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
    setBars((current) => Math.max(20, Math.min(240, current + (event.deltaY > 0 ? 10 : -10))));
  };

  const allDrawings = draft ? [...drawings, draft] : drawings;
  const cursorIndex = cursor && visible.length > 0 ? Math.max(0, Math.min(visible.length - 1, Math.floor(cursor.x / candleWidth))) : -1;
  const cursorCandle = cursorIndex >= 0 ? visible[cursorIndex] : undefined;
  const cursorPrice = cursor ? priceForY(cursor.y) : undefined;

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
        <button onClick={() => setBars((current) => Math.max(20, current - 10))} title="Zoom in"><Icon name="plus" size={17} /></button>
        <button onClick={() => setBars((current) => Math.min(240, current + 10))} title="Zoom out"><Icon name="minus" size={17} /></button>
      </div>

      {visible.length === 0 ? (
        <div className="chart-empty">Waiting for market data…</div>
      ) : (
        <svg className={`market-chart tool-${tool}`} width={size.width} height={size.height} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={() => setCursor(null)} onWheel={onWheel}>
          <defs>
            <clipPath id="plot-clip"><rect x="0" y="0" width={plotWidth} height={priceHeight} /></clipPath>
            <linearGradient id="buy-gradient" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#0a8c72" stopOpacity="0.12" /><stop offset="1" stopColor="#26e0b4" stopOpacity="0.28" /></linearGradient>
            <linearGradient id="sell-gradient" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stopColor="#a72e52" stopOpacity="0.12" /><stop offset="1" stopColor="#ff5b7f" stopOpacity="0.28" /></linearGradient>
          </defs>

          <rect width={size.width} height={size.height} fill="#070b12" />
          {settings.showGrid && priceTicks.map((price) => (
            <line key={price} x1="0" x2={plotWidth} y1={yForPrice(price)} y2={yForPrice(price)} className="grid-line" />
          ))}
          {settings.showGrid && visible.map((candle, index) => index % timeTickStep === 0 ? <line key={candle.time} x1={xForVisibleIndex(index)} x2={xForVisibleIndex(index)} y1="0" y2={priceHeight} className="grid-line vertical" /> : null)}

          <g clipPath="url(#plot-clip)">
            {settings.showBookHeatmap && heatLevels.map((level, index) => {
              const y = yForPrice(level.price);
              if (y < -10 || y > priceHeight + 10) return null;
              const isBid = book?.bids.includes(level) ?? false;
              const width = plotWidth * 0.2 + plotWidth * 0.45 * (level.size / maxBookSize);
              return <rect key={`${level.price}-${index}`} x={plotWidth - width} y={y - 4} width={width} height="8" fill={isBid ? "url(#buy-gradient)" : "url(#sell-gradient)"} />;
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
              return (
                <g key={candle.time}>
                  <line x1={x} x2={x} y1={highY} y2={lowY} className={up ? "candle-up" : "candle-down"} />
                  {chartMode === "delta" ? (
                    <rect x={x - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} className={delta === undefined ? "candle-neutral" : delta >= 0 ? "candle-up-fill" : "candle-down-fill"} opacity={delta === undefined ? 0.35 : Math.min(1, 0.3 + Math.abs(delta) / Math.max(candle.volume, 1))} />
                  ) : (
                    <rect x={x - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} className={up ? "candle-up-fill" : "candle-down-fill"} />
                  )}
                  {chartMode === "footprint" && candleWidth >= 27 && (
                    <g className="footprint-labels">
                      {buy !== undefined && sell !== undefined ? (
                        <>
                          {showSell && <text x={x - 3} y={bodyTop + bodyHeight / 2 + 3} textAnchor="end" className="sell-text">{sell.toFixed(0)}</text>}
                          {showBuy && <text x={x + 3} y={bodyTop + bodyHeight / 2 + 3} textAnchor="start" className="buy-text">{buy.toFixed(0)}</text>}
                        </>
                      ) : (
                        <text x={x} y={bodyTop + bodyHeight / 2 + 3} textAnchor="middle" className="volume-text">{formatCompact(candle.volume)}</text>
                      )}
                    </g>
                  )}
                </g>
              );
            })}

            {settings.showVWAP && <path d={linePath(vwapValues, xForVisibleIndex, yForPrice)} className="indicator vwap" />}
            {settings.showEMA && <path d={linePath(emaValues, xForVisibleIndex, yForPrice)} className="indicator ema" />}

            {settings.showLargeTrades && trades.slice(-60).map((trade, index) => {
              if (trade.time < (visible[0]?.time ?? 0)) return null;
              const x = xForTime(trade.time) + ((index % 5) - 2) * 2;
              const y = yForPrice(trade.price);
              const radius = 2.5 + 8 * Math.sqrt(trade.size / largestTrade);
              return <circle key={trade.id} cx={x} cy={y} r={radius} className={trade.side === "buy" ? "trade-buy" : "trade-sell"} />;
            })}

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

          {settings.showVolume && (
            <g transform={`translate(0 ${priceHeight + 10})`}>
              {visible.map((candle, index) => {
                const x = xForVisibleIndex(index);
                const height = (candle.volume / maxVolume) * (volumeHeight - 25);
                return <rect key={candle.time} x={x - Math.max(1, candleWidth * 0.32)} y={volumeHeight - 25 - height} width={Math.max(2, candleWidth * 0.64)} height={height} className={candle.close >= candle.open ? "volume-up" : "volume-down"} />;
              })}
              <text x="8" y="14" className="panel-label">REAL VOLUME</text>
            </g>
          )}

          <rect x={plotWidth} y="0" width={axisWidth} height={size.height} className="axis-bg" />
          {priceTicks.map((price) => <text key={price} x={plotWidth + 10} y={yForPrice(price) + 4} className="axis-label">{formatPrice(price, market.priceDecimals)}</text>)}
          {visible.map((candle, index) => index % timeTickStep === 0 ? <text key={candle.time} x={xForVisibleIndex(index)} y={size.height - 8} textAnchor="middle" className="time-label">{formatTime(candle.time, timeframe)}</text> : null)}

          {cursor && cursor.x <= plotWidth && cursor.y <= priceHeight && (
            <g pointerEvents="none">
              <line x1={cursor.x} x2={cursor.x} y1="0" y2={priceHeight} className="crosshair" />
              <line x1="0" x2={plotWidth} y1={cursor.y} y2={cursor.y} className="crosshair" />
              <rect x={plotWidth} y={cursor.y - 11} width={axisWidth} height="22" className="crosshair-price-bg" />
              <text x={plotWidth + 8} y={cursor.y + 4} className="crosshair-price">{formatPrice(cursorPrice, market.priceDecimals)}</text>
            </g>
          )}
        </svg>
      )}

      {cursorCandle && (
        <div className="ohlc-strip">
          <span>{formatTime(cursorCandle.time, timeframe)}</span>
          <span>O <b>{formatPrice(cursorCandle.open, market.priceDecimals)}</b></span>
          <span>H <b>{formatPrice(cursorCandle.high, market.priceDecimals)}</b></span>
          <span>L <b>{formatPrice(cursorCandle.low, market.priceDecimals)}</b></span>
          <span>C <b>{formatPrice(cursorCandle.close, market.priceDecimals)}</b></span>
          <span>V <b>{formatCompact(cursorCandle.volume)}</b></span>
          {cursorCandle.buyVolume === undefined && <em>Historical bid/ask split unavailable from this provider</em>}
        </div>
      )}
    </div>
  );
}

function OrderBookPanel({ book, market }: { book: OrderBook | null; market: MarketDefinition }) {
  const asks = book?.asks.slice(0, 10).reverse() ?? [];
  const bids = book?.bids.slice(0, 10) ?? [];
  const maxSize = Math.max(1, ...asks.map((level) => level.size), ...bids.map((level) => level.size));
  const bestAsk = book?.asks[0]?.price;
  const bestBid = book?.bids[0]?.price;
  const spread = bestAsk !== undefined && bestBid !== undefined ? bestAsk - bestBid : undefined;

  const row = (level: BookLevel, side: "ask" | "bid") => (
    <div className={`book-row ${side}`} key={`${side}-${level.price}`}>
      <span className="book-depth" style={{ "--depth": `${(level.size / maxSize) * 100}%` } as CSSProperties} />
      <span>{formatPrice(level.price, market.priceDecimals)}</span>
      <span>{level.size.toFixed(market.quantityDecimals)}</span>
      <span>{level.orders ?? "—"}</span>
    </div>
  );

  return (
    <section className="side-card order-book-card">
      <header><div><small>LIVE DEPTH</small><h3>Order book</h3></div><span className="live-pill">LIVE</span></header>
      <div className="book-head"><span>Price</span><span>Size</span><span>Orders</span></div>
      <div className="book-list asks">{asks.map((level) => row(level, "ask"))}</div>
      <div className="spread-row"><b>{spread === undefined ? "—" : formatPrice(spread, market.priceDecimals)}</b><span>spread</span></div>
      <div className="book-list bids">{bids.map((level) => row(level, "bid"))}</div>
    </section>
  );
}

function TradesPanel({ trades, market }: { trades: Trade[]; market: MarketDefinition }) {
  return (
    <section className="side-card trades-card">
      <header><div><small>TIME & SALES</small><h3>Recent trades</h3></div></header>
      <div className="trade-head"><span>Time</span><span>Price</span><span>Size</span></div>
      <div className="trade-list">
        {trades.slice(-14).reverse().map((trade) => (
          <div className={`trade-row ${trade.side}`} key={trade.id}>
            <span>{new Date(trade.time).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span>{formatPrice(trade.price, market.priceDecimals)}</span>
            <span>{trade.size.toFixed(market.quantityDecimals)}</span>
          </div>
        ))}
        {trades.length === 0 && <div className="empty-list">Waiting for live trades…</div>}
      </div>
    </section>
  );
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="metric-card"><span>{label}</span><b>{value}</b>{detail && <small>{detail}</small>}</div>;
}

function App() {
  const [tab, setTab] = useState<AppTab>("chart");
  const [symbol, setSymbol] = usePersistentState<SymbolKey>("veilflow.symbol", "BTC");
  const [timeframe, setTimeframe] = usePersistentState<Timeframe>("veilflow.timeframe", "5m");
  const [chartMode, setChartMode] = usePersistentState<ChartMode>("veilflow.chartMode", "candles");
  const [flowMode, setFlowMode] = usePersistentState<FlowMode>("veilflow.flowMode", "both");
  const [historyBars, setHistoryBars] = usePersistentState<number>("veilflow.historyBars", 720);
  const [settings, setSettings] = usePersistentState<Settings>("veilflow.settings", DEFAULT_SETTINGS);
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
  const seenTradeIds = useRef(new Set<string>());

  const market = MARKETS[symbol];

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
              if (seenTradeIds.current.has(trade.id)) return false;
              seenTradeIds.current.add(trade.id);
              return true;
            });
            if (seenTradeIds.current.size > 6000) seenTradeIds.current = new Set(Array.from(seenTradeIds.current).slice(-3000));
            if (unique.length === 0) return;
            setTrades((current) => [...current, ...unique].slice(-300));
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
    }, 450);
    return () => window.clearInterval(timer);
  }, [tab, replayPlaying, replaySpeed, candles.length]);

  useEffect(() => {
    if (tab === "replay") {
      setReplayPlaying(false);
      setReplayIndex(Math.max(0, candles.length - 120));
    }
  }, [tab, candles.length]);

  const displayCandles = tab === "replay" ? candles.slice(0, replayIndex + 1) : candles;
  const lastCandle = displayCandles.at(-1);
  const change = calcChange(displayCandles.slice(-Math.min(displayCandles.length, 288)));
  const currentPrice = lastCandle?.close ?? metrics.markPrice;
  const sourceLag = lastUpdate ? Date.now() - lastUpdate : undefined;

  const toggleSetting = (key: keyof Settings) => {
    setSettings((current) => ({ ...current, [key]: !current[key] }));
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
        <div className="brand"><span className="brand-mark">V</span><div><b>VEILFLOW</b><small>LIVE MARKET MICROSTRUCTURE</small></div></div>
        <nav className="main-nav" aria-label="Main navigation">
          <button className={tab === "chart" ? "active" : ""} onClick={() => setTab("chart")}><Icon name="chart" />Chart</button>
          <button className={tab === "replay" ? "active" : ""} onClick={() => setTab("replay")}><Icon name="replay" />Replay</button>
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
          <Select value={symbol} ariaLabel="Market" onChange={setSymbol} options={(Object.keys(MARKETS) as SymbolKey[]).map((key) => ({ value: key, label: `${MARKETS[key].shortLabel} · ${MARKETS[key].provider}` }))} />
          <div className="instrument-copy"><b>{market.label}</b><span>{market.providerSymbol}</span></div>
        </div>
        <div className="control-divider" />
        <Select value={chartMode} ariaLabel="Chart mode" onChange={setChartMode} options={[{ value: "candles", label: "Candles" }, { value: "footprint", label: "Footprint" }, { value: "delta", label: "Delta" }]} />
        <Select value={flowMode} ariaLabel="Flow filter" onChange={setFlowMode} options={[{ value: "both", label: "Buy × Sell" }, { value: "buy", label: "Buy only" }, { value: "sell", label: "Sell only" }]} />
        <Select value={timeframe} ariaLabel="Timeframe" onChange={setTimeframe} options={TIMEFRAMES.map((value) => ({ value, label: value }))} />
        <Select value={String(historyBars)} ariaLabel="History length" onChange={(value) => setHistoryBars(Number(value))} options={[{ value: "360", label: "360 bars" }, { value: "720", label: "720 bars" }, { value: "1200", label: "1,200 bars" }]} />
        <button className={`indicator-button ${indicatorOpen ? "active" : ""}`} onClick={() => setIndicatorOpen((current) => !current)}>ƒx Indicators</button>
        <div className="source-note"><span className={market.provider === "Binance" ? "binance" : "hyperliquid"}>{market.provider}</span><p>{market.description}</p></div>
      </div>

      {tab === "replay" && (
        <div className="replaybar">
          <button onClick={() => setReplayPlaying((current) => !current)}><Icon name={replayPlaying ? "pause" : "play"} />{replayPlaying ? "Pause" : "Play"}</button>
          <button onClick={() => setReplayIndex((current) => Math.max(0, Math.min(candles.length - 1, current + 1)))}><Icon name="step" />Step</button>
          <button onClick={() => { setReplayPlaying(false); setReplayIndex(Math.max(0, candles.length - 120)); }}><Icon name="reset" />Reset</button>
          <Select value={String(replaySpeed)} ariaLabel="Replay speed" onChange={(value) => setReplaySpeed(Number(value))} options={[{ value: "1", label: "1×" }, { value: "2", label: "2×" }, { value: "5", label: "5×" }, { value: "10", label: "10×" }]} />
          <input type="range" min="0" max={Math.max(0, candles.length - 1)} value={Math.min(replayIndex, Math.max(0, candles.length - 1))} onChange={(event: { target: { value: string } }) => setReplayIndex(Number(event.target.value))} />
          <span>{Math.min(replayIndex + 1, candles.length)} / {candles.length} bars</span>
        </div>
      )}

      {error && <div className="error-banner"><b>Market data unavailable.</b><span>{error}</span><button onClick={() => setRefreshKey((current) => current + 1)}>Retry</button></div>}

      <main className="workspace">
        <section className="chart-column">
          <div className="market-header">
            <div><small>{market.shortLabel} · {timeframe} · {tab === "replay" ? "REPLAY" : "LIVE"}</small><h1>{formatPrice(currentPrice, market.priceDecimals)}</h1><span className={change !== undefined && change < 0 ? "negative" : "positive"}>{change === undefined ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}</span></div>
            <div className="market-meta"><span>Source <b>{market.provider}</b></span><span>Last update <b>{sourceLag === undefined ? "—" : `${Math.max(0, Math.round(sourceLag / 1000))}s ago`}</b></span><span>Bars <b>{displayCandles.length.toLocaleString()}</b></span></div>
          </div>
          <ChartCanvas candles={displayCandles} book={book} trades={trades} market={market} timeframe={timeframe} chartMode={chartMode} flowMode={flowMode} settings={settings} />
          <div className="bottom-metrics">
            <MetricCard label="Open interest" value={formatCompact(metrics.openInterest)} detail={market.provider === "Hyperliquid" ? "contracts" : "not provided"} />
            <MetricCard label="24h volume" value={formatCompact(metrics.dayVolume)} detail={market.provider === "Hyperliquid" ? "notional" : "base volume"} />
            <MetricCard label="Funding / hour" value={metrics.fundingRate === undefined ? "—" : `${(metrics.fundingRate * 100).toFixed(4)}%`} detail={market.provider === "Binance" ? "spot market" : "Hyperliquid perp"} />
            <MetricCard label="Oracle" value={formatPrice(metrics.oraclePrice, market.priceDecimals)} detail={market.providerSymbol} />
          </div>
        </section>

        <aside className="right-sidebar">
          <OrderBookPanel book={book} market={market} />
          <TradesPanel trades={trades} market={market} />
        </aside>
      </main>

      {indicatorOpen && (
        <div className="floating-panel indicator-panel">
          <header><div><small>OVERLAYS</small><h2>Indicators</h2></div><button onClick={() => setIndicatorOpen(false)}><Icon name="close" /></button></header>
          <Toggle checked={settings.showEMA} onChange={() => toggleSetting("showEMA")} label="EMA 20" />
          <Toggle checked={settings.showVWAP} onChange={() => toggleSetting("showVWAP")} label="Session VWAP" />
          <Toggle checked={settings.showVolume} onChange={() => toggleSetting("showVolume")} label="Volume histogram" />
          <p>All calculations use the loaded real OHLCV candles. Hyperliquid does not provide historical aggressor-side volume in candle snapshots; live trade flow is accumulated after connection.</p>
        </div>
      )}

      {settingsOpen && (
        <div className="drawer-backdrop" onMouseDown={() => setSettingsOpen(false)}>
          <aside className="settings-drawer" onMouseDown={(event: { stopPropagation: () => void }) => event.stopPropagation()}>
            <header><div><small>WORKSPACE</small><h2>Chart settings</h2></div><button onClick={() => setSettingsOpen(false)}><Icon name="close" /></button></header>
            <section><h3>Display</h3><Toggle checked={settings.showGrid} onChange={() => toggleSetting("showGrid")} label="Grid" /><Toggle checked={settings.showVolume} onChange={() => toggleSetting("showVolume")} label="Volume" /><Toggle checked={settings.autoFollow} onChange={() => toggleSetting("autoFollow")} label="Auto-follow latest bar" /></section>
            <section><h3>Order flow</h3><Toggle checked={settings.showBookHeatmap} onChange={() => toggleSetting("showBookHeatmap")} label="Real order-book heatmap" /><Toggle checked={settings.showLargeTrades} onChange={() => toggleSetting("showLargeTrades")} label="Live trade bubbles" /></section>
            <section><h3>Indicators</h3><Toggle checked={settings.showEMA} onChange={() => toggleSetting("showEMA")} label="EMA 20" /><Toggle checked={settings.showVWAP} onChange={() => toggleSetting("showVWAP")} label="VWAP" /></section>
            <button className="reset-settings" onClick={() => setSettings(DEFAULT_SETTINGS)}>Restore defaults</button>
            <div className="data-disclaimer"><b>Instrument mapping</b><p>BTC is Binance BTCUSDT spot. NQ maps to Hyperliquid <code>xyz:XYZ100</code>. ES maps to Hyperliquid <code>xyz:SP500</code>. The two index products are perpetual proxies, not CME futures contracts.</p></div>
          </aside>
        </div>
      )}
    </div>
  );
}

export default App;
