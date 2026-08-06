import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { detectLargeTrades } from "./analytics";
import { clamp, formatNotional, formatPrice, formatTime } from "./format";
import { groupBook } from "./orderBook";
import type { Candle, ChartMode, MarketState, Trade } from "./types";

interface ChartSettings {
  showGrid: boolean;
  showVolume: boolean;
  showVwap: boolean;
  showDepth: boolean;
  showLargeTrades: boolean;
  autoFollow: boolean;
}

interface Props {
  state: MarketState;
  mode: ChartMode;
  settings: ChartSettings;
  replayActive: boolean;
  onFps?: (fps: number) => void;
}

type Cursor = { x: number; y: number } | null;

function footprint(candles: Candle[], trades: Trade[], step: number): Map<number, Array<{ price: number; buy: number; sell: number }>> {
  const map = new Map<number, Map<number, { price: number; buy: number; sell: number }>>();
  if (!candles.length || !trades.length) return new Map();
  const start = candles[0].time;
  const end = candles.at(-1)!.endTime;
  const candleMs = Math.max(1, candles[0].endTime - candles[0].time + 1);
  const byTime = new Map(candles.map((candle) => [candle.time, candle]));
  for (const trade of trades) {
    if (trade.exchangeTime < start || trade.exchangeTime > end) continue;
    const bucket = Math.floor((trade.exchangeTime - start) / candleMs) * candleMs + start;
    const candle = byTime.get(bucket) ?? candles.find((item) => trade.exchangeTime >= item.time && trade.exchangeTime <= item.endTime);
    if (!candle) continue;
    const price = Number((Math.round(trade.price / step) * step).toPrecision(12));
    const levels = map.get(candle.time) ?? new Map();
    const level = levels.get(price) ?? { price, buy: 0, sell: 0 };
    level[trade.side] += trade.size;
    levels.set(price, level);
    map.set(candle.time, levels);
  }
  return new Map([...map.entries()].map(([time, levels]) => [time, [...levels.values()].sort((a, b) => b.price - a.price)]));
}

export function MarketChart({ state, mode, settings, replayActive, onFps }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 1000, height: 620 });
  const [bars, setBars] = useState(100);
  const [offset, setOffset] = useState(0);
  const [cursor, setCursor] = useState<Cursor>(null);
  const drag = useRef<{ x: number; offset: number } | null>(null);
  const frameCount = useRef(0);
  const frameStart = useRef(performance.now());

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const resize = () => setSize({ width: Math.max(300, element.clientWidth), height: Math.max(320, element.clientHeight) });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { if (settings.autoFollow && !replayActive) setOffset(0); }, [state.candles.length, settings.autoFollow, replayActive]);

  const end = Math.max(0, state.candles.length - offset);
  const start = Math.max(0, end - bars);
  const visible = useMemo(() => state.candles.slice(start, end), [state.candles, start, end]);
  const large = useMemo(() => detectLargeTrades(state.trades, state.market.key === "BTC" ? 75_000 : 25_000), [state.trades, state.market.key]);
  const groupedBook = useMemo(() => groupBook(state.book, Math.max(state.market.tickSize, (state.book?.asks[0]?.price ?? 1) * 0.00005), 22), [state.book, state.market.tickSize]);
  const fp = useMemo(() => footprint(visible, state.trades, Math.max(state.market.tickSize, (state.book?.asks[0]?.price ?? 1) * 0.00002)), [visible, state.trades, state.market.tickSize, state.book]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const width = size.width;
    const height = size.height;
    const axisWidth = 76;
    const timeHeight = 26;
    const volumeHeight = settings.showVolume ? Math.max(72, height * 0.17) : 0;
    const plotWidth = width - axisWidth;
    const plotHeight = height - timeHeight - volumeHeight;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#05080d";
    ctx.fillRect(0, 0, width, height);

    if (!visible.length) {
      ctx.fillStyle = "#6d7c91";
      ctx.font = "12px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Waiting for market data…", width / 2, height / 2);
      return;
    }

    let min = Math.min(...visible.map((candle) => candle.low));
    let max = Math.max(...visible.map((candle) => candle.high));
    if (settings.showVwap && state.analytics.sessionVwap) {
      min = Math.min(min, state.analytics.sessionVwap);
      max = Math.max(max, state.analytics.sessionVwap);
    }
    const padding = Math.max((max - min) * 0.08, max * 0.00035, state.market.tickSize * 4);
    min -= padding; max += padding;
    const priceRange = Math.max(Number.EPSILON, max - min);
    const xStep = plotWidth / visible.length;
    const xFor = (index: number) => (index + 0.5) * xStep;
    const yFor = (price: number) => (max - price) / priceRange * plotHeight;
    const maxVolume = Math.max(1, ...visible.map((candle) => candle.volume));

    if (settings.showGrid) {
      ctx.strokeStyle = "#111c29";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 5]);
      for (let i = 0; i <= 6; i += 1) {
        const y = plotHeight * i / 6;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotWidth, y); ctx.stroke();
      }
      const timeStep = Math.max(1, Math.ceil(visible.length / 8));
      for (let i = 0; i < visible.length; i += timeStep) {
        const x = xFor(i);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotHeight); ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    if (settings.showDepth && !replayActive && groupedBook) {
      const levels = [...groupedBook.bids.map((level) => ({ ...level, side: "bid" as const })), ...groupedBook.asks.map((level) => ({ ...level, side: "ask" as const }))];
      const maxNotional = Math.max(1, ...levels.map((level) => level.price * level.size));
      for (const level of levels) {
        const y = yFor(level.price);
        if (y < -5 || y > plotHeight + 5) continue;
        const intensity = clamp(level.price * level.size / maxNotional, 0.05, 1);
        const barWidth = plotWidth * (0.1 + intensity * 0.55);
        const gradient = ctx.createLinearGradient(plotWidth - barWidth, 0, plotWidth, 0);
        if (level.side === "bid") {
          gradient.addColorStop(0, "rgba(27,226,178,0)"); gradient.addColorStop(1, `rgba(27,226,178,${0.08 + intensity * 0.25})`);
        } else {
          gradient.addColorStop(0, "rgba(255,83,121,0)"); gradient.addColorStop(1, `rgba(255,83,121,${0.08 + intensity * 0.25})`);
        }
        ctx.fillStyle = gradient;
        ctx.fillRect(plotWidth - barWidth, y - 3, barWidth, 6);
      }
    }

    const drawCandle = (candle: Candle, index: number) => {
      const x = xFor(index);
      const up = candle.close >= candle.open;
      const color = up ? "#28dfb4" : "#ff5b7f";
      const highY = yFor(candle.high); const lowY = yFor(candle.low);
      const openY = yFor(candle.open); const closeY = yFor(candle.close);
      const bodyWidth = Math.max(1.5, xStep * 0.58);
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, highY); ctx.lineTo(x, lowY); ctx.stroke();
      ctx.fillStyle = up ? "#17b98f" : "#d74668";
      ctx.fillRect(x - bodyWidth / 2, Math.min(openY, closeY), bodyWidth, Math.max(1.5, Math.abs(closeY - openY)));
    };

    if (mode === "delta") {
      const maxDelta = Math.max(1, ...visible.map((candle) => Math.abs((candle.buyVolume ?? 0) - (candle.sellVolume ?? 0))));
      const mid = plotHeight / 2;
      ctx.strokeStyle = "#2a384b"; ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(plotWidth, mid); ctx.stroke();
      visible.forEach((candle, index) => {
        const delta = (candle.buyVolume ?? 0) - (candle.sellVolume ?? 0);
        const h = Math.abs(delta) / maxDelta * (plotHeight * 0.42);
        ctx.fillStyle = delta >= 0 ? "rgba(40,223,180,.75)" : "rgba(255,91,127,.75)";
        ctx.fillRect(xFor(index) - Math.max(1, xStep * 0.35), delta >= 0 ? mid - h : mid, Math.max(2, xStep * 0.7), h);
      });
    } else {
      visible.forEach(drawCandle);
      if (mode === "footprint" && xStep >= 26) {
        visible.forEach((candle, index) => {
          const levels = fp.get(candle.time) ?? [];
          if (!levels.length) return;
          const maxLevel = Math.max(1, ...levels.map((level) => level.buy + level.sell));
          const cellWidth = Math.max(18, xStep * 0.82);
          for (const level of levels) {
            const y = yFor(level.price);
            if (y < 0 || y > plotHeight) continue;
            const sellAlpha = clamp(level.sell / maxLevel, 0.06, 0.55);
            const buyAlpha = clamp(level.buy / maxLevel, 0.06, 0.55);
            ctx.fillStyle = `rgba(255,91,127,${sellAlpha})`;
            ctx.fillRect(xFor(index) - cellWidth / 2, y - 4, cellWidth / 2, 8);
            ctx.fillStyle = `rgba(40,223,180,${buyAlpha})`;
            ctx.fillRect(xFor(index), y - 4, cellWidth / 2, 8);
            if (xStep >= 46) {
              ctx.font = "7px JetBrains Mono, monospace";
              ctx.textBaseline = "middle";
              ctx.fillStyle = "#ffc0ce"; ctx.textAlign = "right"; ctx.fillText(level.sell.toFixed(2), xFor(index) - 2, y);
              ctx.fillStyle = "#9affdf"; ctx.textAlign = "left"; ctx.fillText(level.buy.toFixed(2), xFor(index) + 2, y);
            }
          }
        });
      }
    }

    if (settings.showVwap && state.analytics.sessionVwap) {
      const y = yFor(state.analytics.sessionVwap);
      ctx.strokeStyle = "#f4bd4a"; ctx.lineWidth = 1.3; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotWidth, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "#f4bd4a"; ctx.font = "9px JetBrains Mono, monospace"; ctx.textAlign = "left";
      ctx.fillText("SESSION VWAP", 10, y - 6);
    }

    if (settings.showLargeTrades && !replayActive) {
      const visibleStart = visible[0].time; const visibleEnd = visible.at(-1)!.endTime;
      const maxLarge = Math.max(1, ...large.events.map((item) => item.notional));
      for (const item of large.events) {
        if (item.time < visibleStart || item.time > visibleEnd) continue;
        const candleIndex = visible.findIndex((candle) => item.time >= candle.time && item.time <= candle.endTime);
        if (candleIndex < 0) continue;
        const x = xFor(candleIndex); const y = yFor(item.price);
        const radius = 4 + Math.sqrt(item.notional / maxLarge) * 11;
        ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = item.side === "buy" ? "rgba(40,223,180,.24)" : "rgba(255,91,127,.24)";
        ctx.fill(); ctx.strokeStyle = item.side === "buy" ? "#41f1c5" : "#ff7895"; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }

    if (settings.showVolume) {
      const volumeTop = plotHeight + 8;
      ctx.fillStyle = "#0a1018"; ctx.fillRect(0, volumeTop, plotWidth, volumeHeight - 8);
      visible.forEach((candle, index) => {
        const h = candle.volume / maxVolume * (volumeHeight - 24);
        ctx.fillStyle = candle.close >= candle.open ? "rgba(40,223,180,.32)" : "rgba(255,91,127,.32)";
        ctx.fillRect(xFor(index) - Math.max(1, xStep * 0.3), height - timeHeight - h, Math.max(2, xStep * 0.6), h);
      });
    }

    ctx.fillStyle = "#080d15"; ctx.fillRect(plotWidth, 0, axisWidth, height);
    ctx.strokeStyle = "#172331"; ctx.strokeRect(plotWidth, 0, axisWidth, height);
    ctx.font = "9px JetBrains Mono, monospace"; ctx.fillStyle = "#718299"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    for (let i = 0; i <= 6; i += 1) {
      const price = max - priceRange * i / 6;
      ctx.fillText(formatPrice(price, state.market.priceDecimals), plotWidth + 7, plotHeight * i / 6);
    }
    const timeStep = Math.max(1, Math.ceil(visible.length / 7));
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    for (let i = 0; i < visible.length; i += timeStep) ctx.fillText(formatTime(visible[i].time), xFor(i), height - 7);

    const latest = visible.at(-1)?.close;
    if (latest !== undefined) {
      const y = yFor(latest);
      ctx.strokeStyle = "rgba(32,211,226,.58)"; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotWidth, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = "#165465"; ctx.fillRect(plotWidth, y - 10, axisWidth, 20);
      ctx.fillStyle = "#e8fdff"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(formatPrice(latest, state.market.priceDecimals), plotWidth + 7, y);
    }

    if (cursor && cursor.x <= plotWidth && cursor.y <= plotHeight) {
      ctx.strokeStyle = "#587188"; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(cursor.x, 0); ctx.lineTo(cursor.x, plotHeight); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, cursor.y); ctx.lineTo(plotWidth, cursor.y); ctx.stroke(); ctx.setLineDash([]);
      const index = clamp(Math.floor(cursor.x / xStep), 0, visible.length - 1);
      const candle = visible[index];
      const hoverPrice = max - cursor.y / plotHeight * priceRange;
      ctx.fillStyle = "rgba(8,14,22,.96)"; ctx.strokeStyle = "#263a4d";
      ctx.fillRect(10, 10, 298, 34); ctx.strokeRect(10, 10, 298, 34);
      ctx.font = "9px JetBrains Mono, monospace"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#91a4ba";
      ctx.fillText(`${formatTime(candle.time, true)}  O ${formatPrice(candle.open, state.market.priceDecimals)}  H ${formatPrice(candle.high, state.market.priceDecimals)}  L ${formatPrice(candle.low, state.market.priceDecimals)}  C ${formatPrice(candle.close, state.market.priceDecimals)}`, 18, 22);
      ctx.fillStyle = "#22d3e2"; ctx.fillText(`Cursor ${formatPrice(hoverPrice, state.market.priceDecimals)}`, 18, 36);
    }

    if (replayActive) {
      ctx.fillStyle = "rgba(41,31,10,.92)"; ctx.strokeStyle = "rgba(244,189,74,.45)";
      ctx.fillRect(plotWidth - 190, plotHeight - 34, 178, 24); ctx.strokeRect(plotWidth - 190, plotHeight - 34, 178, 24);
      ctx.fillStyle = "#f4bd4a"; ctx.font = "800 9px JetBrains Mono, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("RECORDED EVENT REPLAY", plotWidth - 101, plotHeight - 22);
    }

    frameCount.current += 1;
    const elapsed = performance.now() - frameStart.current;
    if (elapsed >= 1000) {
      onFps?.(Math.round(frameCount.current * 1000 / elapsed));
      frameCount.current = 0; frameStart.current = performance.now();
    }
  }, [size, visible, state, mode, settings, replayActive, cursor, groupedBook, large, fp, onFps]);

  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = point(event); drag.current = { x: p.x, offset };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const p = point(event); setCursor(p);
    if (drag.current) {
      const step = Math.max(1, (size.width - 76) / Math.max(1, visible.length));
      const delta = Math.round((drag.current.x - p.x) / step);
      setOffset(clamp(drag.current.offset + delta, 0, Math.max(0, state.candles.length - 20)));
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
  };
  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault(); setBars((current) => clamp(current + (event.deltaY > 0 ? 10 : -10), 20, 400));
  };

  return (
    <div className="vf-chart-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="vf-chart-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => { setCursor(null); drag.current = null; }}
        onWheel={onWheel}
        aria-label={`${state.market.displayName} ${mode} chart`}
      />
      <div className="vf-chart-hud">
        <span>{visible.length} bars</span>
        <span>Zoom {bars}</span>
        <span>Large ≥ {formatNotional(large.threshold)}</span>
      </div>
    </div>
  );
}
