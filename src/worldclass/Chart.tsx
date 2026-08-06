import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { detectLargeTrades } from "./analytics";
import { regroupFootprint } from "./footprint";
import { clamp, formatCompact, formatNotional, formatPrice, formatTime } from "./format";
import { groupBook } from "./orderBook";
import type { Candle, ChartMode, FootprintCandle, FootprintQuality, MarketState } from "./types";

interface ChartSettings {
  showGrid: boolean;
  showVolume: boolean;
  showVwap: boolean;
  showDepth: boolean;
  showLargeTrades: boolean;
  autoFollow: boolean;
  footprintTicksPerRow: number;
  footprintImbalanceRatio: number;
  footprintMinVolume: number;
  showFootprintDelta: boolean;
}

interface Props {
  state: MarketState;
  mode: ChartMode;
  settings: ChartSettings;
  replayActive: boolean;
  onFps?: (fps: number) => void;
}

type Cursor = { x: number; y: number } | null;

const QUALITY_LABEL: Record<FootprintQuality, string> = {
  full: "FULL",
  "live-partial": "PARTIAL",
  "aggregate-only": "AGG",
  gapped: "GAP",
  "replay-full": "REPLAY",
};

function qualityColor(quality: FootprintQuality): string {
  if (quality === "full" || quality === "replay-full") return "#36e2b6";
  if (quality === "gapped") return "#ff5b7f";
  if (quality === "live-partial") return "#f4bd4a";
  return "#728297";
}

function volumeText(value: number): string {
  if (Math.abs(value) >= 1000) return formatCompact(value, 1);
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

export function MarketChart({ state, mode, settings, replayActive, onFps }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 1000, height: 620 });
  const [bars, setBars] = useState(80);
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
  const footprintByTime = useMemo(() => new Map(state.footprints.map((item) => [item.time, item])), [state.footprints]);
  const large = useMemo(() => detectLargeTrades(state.trades, state.market.key === "BTC" || state.market.key === "BTCPERP" ? 75_000 : 25_000), [state.trades, state.market.key]);
  const groupedBook = useMemo(() => groupBook(state.book, Math.max(state.market.tickSize, (state.book?.asks[0]?.price ?? 1) * 0.00005), 22), [state.book, state.market.tickSize]);

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
    const axisWidth = 78;
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
    min -= padding;
    max += padding;
    const priceRange = Math.max(Number.EPSILON, max - min);
    const xStep = plotWidth / visible.length;
    const xFor = (index: number) => (index + 0.5) * xStep;
    const yFor = (price: number) => (max - price) / priceRange * plotHeight;
    const maxVolume = Math.max(1, ...visible.map((candle) => candle.volume));

    const requestedStep = state.market.tickSize * Math.max(1, settings.footprintTicksPerRow || state.market.footprintDefaultTicks);
    const pixelsPerRequestedStep = requestedStep / priceRange * plotHeight;
    const autoMultiplier = mode === "footprint" ? Math.max(1, Math.ceil(7 / Math.max(0.001, pixelsPerRequestedStep))) : 1;
    const displayStep = Number((requestedStep * autoMultiplier).toPrecision(12));

    if (settings.showGrid) {
      ctx.strokeStyle = "#111c29";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 5]);
      for (let index = 0; index <= 6; index += 1) {
        const y = plotHeight * index / 6;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotWidth, y); ctx.stroke();
      }
      const timeStep = Math.max(1, Math.ceil(visible.length / 8));
      for (let index = 0; index < visible.length; index += timeStep) {
        const x = xFor(index);
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

    const drawCandle = (candle: Candle, index: number, faint = false) => {
      const x = xFor(index);
      const up = candle.close >= candle.open;
      const color = up ? "#28dfb4" : "#ff5b7f";
      const highY = yFor(candle.high); const lowY = yFor(candle.low);
      const openY = yFor(candle.open); const closeY = yFor(candle.close);
      const bodyWidth = Math.max(1.5, xStep * (faint ? 0.18 : 0.58));
      ctx.globalAlpha = faint ? 0.38 : 1;
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, highY); ctx.lineTo(x, lowY); ctx.stroke();
      ctx.fillStyle = up ? "#17b98f" : "#d74668";
      ctx.fillRect(x - bodyWidth / 2, Math.min(openY, closeY), bodyWidth, Math.max(1.5, Math.abs(closeY - openY)));
      ctx.globalAlpha = 1;
    };

    if (mode === "delta") {
      const maxDelta = Math.max(1, ...visible.map((candle) => Math.abs((candle.buyVolume ?? 0) - (candle.sellVolume ?? 0))));
      const mid = plotHeight / 2;
      ctx.strokeStyle = "#2a384b"; ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(plotWidth, mid); ctx.stroke();
      visible.forEach((candle, index) => {
        const delta = (candle.buyVolume ?? 0) - (candle.sellVolume ?? 0);
        const barHeight = Math.abs(delta) / maxDelta * (plotHeight * 0.42);
        ctx.fillStyle = delta >= 0 ? "rgba(40,223,180,.75)" : "rgba(255,91,127,.75)";
        ctx.fillRect(xFor(index) - Math.max(1, xStep * 0.35), delta >= 0 ? mid - barHeight : mid, Math.max(2, xStep * 0.7), barHeight);
      });
    } else if (mode === "footprint") {
      visible.forEach((candle, index) => drawCandle(candle, index, true));
      visible.forEach((candle, index) => {
        const raw = footprintByTime.get(candle.time);
        const footprint = raw ? regroupFootprint(raw, candle, displayStep, settings.footprintImbalanceRatio, settings.footprintMinVolume) : undefined;
        const x = xFor(index);
        const cellWidth = Math.max(20, xStep * 0.88);
        const half = cellWidth / 2;
        const quality = footprint?.quality ?? "aggregate-only";
        const qColor = qualityColor(quality);

        ctx.fillStyle = qColor;
        ctx.globalAlpha = 0.75;
        ctx.fillRect(x - cellWidth / 2, 2, cellWidth, 2);
        ctx.globalAlpha = 1;

        if (!footprint?.rows.length) {
          if (xStep >= 32) {
            ctx.font = "700 7px JetBrains Mono, monospace";
            ctx.textAlign = "center";
            ctx.fillStyle = qColor;
            ctx.fillText(QUALITY_LABEL[quality], x, Math.min(plotHeight - 10, yFor(candle.high) - 7));
            if (candle.buyVolume !== undefined && candle.sellVolume !== undefined && xStep >= 52) {
              ctx.fillStyle = "#7f8fa4";
              ctx.fillText(`${volumeText(candle.sellVolume)} × ${volumeText(candle.buyVolume)}`, x, Math.max(12, yFor(candle.low) + 10));
            }
          }
          return;
        }

        const maxLevel = Math.max(1, ...footprint.rows.map((row) => row.totalVolume));
        const rowPixelHeight = clamp(displayStep / priceRange * plotHeight * 0.88, 6, 14);
        for (const row of footprint.rows) {
          const y = yFor(row.price);
          if (y < 0 || y > plotHeight) continue;
          const bidAlpha = clamp(row.bidVolume / maxLevel, 0.05, 0.62);
          const askAlpha = clamp(row.askVolume / maxLevel, 0.05, 0.62);

          if (row.inValueArea) {
            ctx.fillStyle = "rgba(126,147,174,.055)";
            ctx.fillRect(x - half, y - rowPixelHeight / 2, cellWidth, rowPixelHeight);
          }
          ctx.fillStyle = `rgba(255,91,127,${bidAlpha})`;
          ctx.fillRect(x - half, y - rowPixelHeight / 2, half, rowPixelHeight);
          ctx.fillStyle = `rgba(40,223,180,${askAlpha})`;
          ctx.fillRect(x, y - rowPixelHeight / 2, half, rowPixelHeight);

          if (row.price === footprint.pocPrice) {
            ctx.strokeStyle = "rgba(244,189,74,.95)";
            ctx.lineWidth = 1;
            ctx.strokeRect(x - half, y - rowPixelHeight / 2, cellWidth, rowPixelHeight);
          }
          if (row.bidImbalance) {
            ctx.strokeStyle = "#ff7895";
            ctx.lineWidth = row.stackedBid ? 2 : 1;
            ctx.strokeRect(x - half, y - rowPixelHeight / 2, half, rowPixelHeight);
          }
          if (row.askImbalance) {
            ctx.strokeStyle = "#54f1c9";
            ctx.lineWidth = row.stackedAsk ? 2 : 1;
            ctx.strokeRect(x, y - rowPixelHeight / 2, half, rowPixelHeight);
          }
          if (row.stackedBid) {
            ctx.fillStyle = "#ff7895";
            ctx.fillRect(x - half - 3, y - 1.5, 2, 3);
          }
          if (row.stackedAsk) {
            ctx.fillStyle = "#54f1c9";
            ctx.fillRect(x + half + 1, y - 1.5, 2, 3);
          }

          if (xStep >= 50 && rowPixelHeight >= 7) {
            ctx.font = `${rowPixelHeight >= 10 ? 8 : 7}px JetBrains Mono, monospace`;
            ctx.textBaseline = "middle";
            ctx.fillStyle = "#ffd3dc"; ctx.textAlign = "right"; ctx.fillText(volumeText(row.bidVolume), x - 2, y);
            ctx.fillStyle = "#b8ffe9"; ctx.textAlign = "left"; ctx.fillText(volumeText(row.askVolume), x + 2, y);
          }
        }

        if (xStep >= 40) {
          const labelY = clamp(yFor(candle.high) - 9, 12, plotHeight - 12);
          ctx.font = "700 7px JetBrains Mono, monospace";
          ctx.textAlign = "center";
          ctx.fillStyle = qColor;
          ctx.fillText(QUALITY_LABEL[quality], x, labelY);
          if (settings.showFootprintDelta) {
            const deltaY = clamp(yFor(candle.low) + 10, 12, plotHeight - 4);
            ctx.fillStyle = footprint.delta >= 0 ? "#70f2d0" : "#ff8aa1";
            ctx.fillText(`Δ ${volumeText(footprint.delta)}`, x, deltaY);
          }
        }
      });

      if (xStep < 26) {
        ctx.fillStyle = "rgba(8,14,22,.94)";
        ctx.strokeStyle = "#2b3c50";
        ctx.fillRect(12, 12, 240, 28);
        ctx.strokeRect(12, 12, 240, 28);
        ctx.fillStyle = "#91a4ba";
        ctx.font = "9px JetBrains Mono, monospace";
        ctx.textAlign = "left";
        ctx.fillText("Zoom in to reveal footprint rows", 22, 30);
      }
    } else {
      visible.forEach((candle, index) => drawCandle(candle, index));
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
        const barHeight = candle.volume / maxVolume * (volumeHeight - 24);
        ctx.fillStyle = candle.close >= candle.open ? "rgba(40,223,180,.32)" : "rgba(255,91,127,.32)";
        ctx.fillRect(xFor(index) - Math.max(1, xStep * 0.3), height - timeHeight - barHeight, Math.max(2, xStep * 0.6), barHeight);
      });
    }

    ctx.fillStyle = "#080d15"; ctx.fillRect(plotWidth, 0, axisWidth, height);
    ctx.strokeStyle = "#172331"; ctx.strokeRect(plotWidth, 0, axisWidth, height);
    ctx.font = "9px JetBrains Mono, monospace"; ctx.fillStyle = "#718299"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    for (let index = 0; index <= 6; index += 1) {
      const price = max - priceRange * index / 6;
      ctx.fillText(formatPrice(price, state.market.priceDecimals), plotWidth + 7, plotHeight * index / 6);
    }
    const timeStep = Math.max(1, Math.ceil(visible.length / 7));
    ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    for (let index = 0; index < visible.length; index += timeStep) ctx.fillText(formatTime(visible[index].time), xFor(index), height - 7);

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
      const raw = footprintByTime.get(candle.time);
      const footprint = raw ? regroupFootprint(raw, candle, displayStep, settings.footprintImbalanceRatio, settings.footprintMinVolume) : undefined;
      const nearest = footprint?.rows.reduce((best, row) => !best || Math.abs(row.price - hoverPrice) < Math.abs(best.price - hoverPrice) ? row : best, undefined as FootprintCandle["rows"][number] | undefined);
      ctx.fillStyle = "rgba(8,14,22,.96)"; ctx.strokeStyle = "#263a4d";
      ctx.fillRect(10, 10, 360, mode === "footprint" ? 50 : 34); ctx.strokeRect(10, 10, 360, mode === "footprint" ? 50 : 34);
      ctx.font = "9px JetBrains Mono, monospace"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#91a4ba";
      ctx.fillText(`${formatTime(candle.time, true)}  O ${formatPrice(candle.open, state.market.priceDecimals)}  H ${formatPrice(candle.high, state.market.priceDecimals)}  L ${formatPrice(candle.low, state.market.priceDecimals)}  C ${formatPrice(candle.close, state.market.priceDecimals)}`, 18, 22);
      ctx.fillStyle = "#22d3e2"; ctx.fillText(`Cursor ${formatPrice(hoverPrice, state.market.priceDecimals)}`, 18, 36);
      if (mode === "footprint" && footprint) {
        ctx.fillStyle = qualityColor(footprint.quality);
        ctx.fillText(`${QUALITY_LABEL[footprint.quality]}  Bid ${volumeText(nearest?.bidVolume ?? 0)} × Ask ${volumeText(nearest?.askVolume ?? 0)}  Δ ${volumeText(footprint.delta)}  POC ${formatPrice(footprint.pocPrice, state.market.priceDecimals)}`, 18, 51);
      }
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
  }, [size, visible, state, mode, settings, replayActive, cursor, groupedBook, large, footprintByTime, onFps]);

  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const position = point(event); drag.current = { x: position.x, offset };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const position = point(event); setCursor(position);
    if (drag.current) {
      const step = Math.max(1, (size.width - 78) / Math.max(1, visible.length));
      const delta = Math.round((drag.current.x - position.x) / step);
      setOffset(clamp(drag.current.offset + delta, 0, Math.max(0, state.candles.length - 20)));
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
  };
  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault(); setBars((current) => clamp(current + (event.deltaY > 0 ? 10 : -10), 10, 400));
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
        {mode === "footprint" && <span>Rows {settings.footprintTicksPerRow} ticks+ · {state.footprintCoverage.quality.toUpperCase()}</span>}
        <span>Large ≥ {formatNotional(large.threshold)}</span>
      </div>
    </div>
  );
}
