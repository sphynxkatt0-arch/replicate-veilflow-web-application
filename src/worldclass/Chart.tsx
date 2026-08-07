import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
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

interface RenderMeta {
  dpr: number;
  width: number;
  height: number;
  plotWidth: number;
  plotHeight: number;
  min: number;
  max: number;
  priceRange: number;
  xStep: number;
  displayStep: number;
  visible: Candle[];
  footprints: Map<number, FootprintCandle>;
}

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

function bigOrderLabel(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(1)}B`;
  if (absolute >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (absolute >= 100_000) return `$${Math.round(value / 1_000)}K`;
  if (absolute >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${Math.round(value)}`;
}

function prepareCanvas(canvas: HTMLCanvasElement, width: number, height: number, dpr: number): CanvasRenderingContext2D | null {
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
  if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
  if (canvas.style.width !== `${width}px`) canvas.style.width = `${width}px`;
  if (canvas.style.height !== `${height}px`) canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

export function MarketChart({ state, mode, settings, replayActive, onFps }: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ width: 1000, height: 620 });
  const [bars, setBars] = useState(80);
  const [offset, setOffset] = useState(0);
  const cursorRef = useRef<Cursor>(null);
  const drag = useRef<{ x: number; offset: number } | null>(null);
  const renderMetaRef = useRef<RenderMeta | null>(null);
  const overlayFrameRef = useRef<number | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const pendingOffsetRef = useRef<number | null>(null);

  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const resize = () => {
      const next = { width: Math.max(300, element.clientWidth), height: Math.max(320, element.clientHeight) };
      setSize((current) => current.width === next.width && current.height === next.height ? current : next);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!onFps) return;
    let frame = 0;
    let count = 0;
    let started = performance.now();
    const tick = (now: number) => {
      count += 1;
      if (now - started >= 1000) {
        onFps(Math.round(count * 1000 / (now - started)));
        count = 0;
        started = now;
      }
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [onFps]);

  useEffect(() => () => {
    if (overlayFrameRef.current !== null) window.cancelAnimationFrame(overlayFrameRef.current);
    if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
  }, []);

  useEffect(() => { if (settings.autoFollow && !replayActive) setOffset(0); }, [state.candles.length, settings.autoFollow, replayActive]);

  const end = Math.max(0, state.candles.length - offset);
  const start = Math.max(0, end - bars);
  const visible = useMemo(() => state.candles.slice(start, end), [state.candles, start, end]);
  const footprintByTime = useMemo(() => new Map(state.footprints.map((item) => [item.time, item])), [state.footprints]);
  const large = useMemo(() => detectLargeTrades(state.trades, state.market.key === "BTC" || state.market.key === "BTCPERP" ? 75_000 : 25_000), [state.trades, state.market.key]);
  const groupedBook = useMemo(() => groupBook(state.book, Math.max(state.market.tickSize, (state.book?.asks[0]?.price ?? 1) * 0.00005), 22), [state.book, state.market.tickSize]);

  const drawOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    const meta = renderMetaRef.current;
    if (!canvas || !meta) return;
    const ctx = prepareCanvas(canvas, meta.width, meta.height, meta.dpr);
    if (!ctx) return;
    ctx.clearRect(0, 0, meta.width, meta.height);
    const cursor = cursorRef.current;
    if (!cursor || cursor.x > meta.plotWidth || cursor.y > meta.plotHeight || cursor.x < 0 || cursor.y < 0 || !meta.visible.length) return;

    ctx.strokeStyle = "#587188";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(cursor.x, 0); ctx.lineTo(cursor.x, meta.plotHeight); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, cursor.y); ctx.lineTo(meta.plotWidth, cursor.y); ctx.stroke();
    ctx.setLineDash([]);

    const index = clamp(Math.floor(cursor.x / meta.xStep), 0, meta.visible.length - 1);
    const candle = meta.visible[index];
    const hoverPrice = meta.max - cursor.y / meta.plotHeight * meta.priceRange;
    const footprint = meta.footprints.get(candle.time);
    const nearest = footprint?.rows.reduce((best, row) => !best || Math.abs(row.price - hoverPrice) < Math.abs(best.price - hoverPrice) ? row : best, undefined as FootprintCandle["rows"][number] | undefined);
    const tooltipHeight = mode === "footprint" ? 50 : 34;
    ctx.fillStyle = "rgba(8,14,22,.96)";
    ctx.strokeStyle = "#263a4d";
    ctx.fillRect(10, 10, 360, tooltipHeight);
    ctx.strokeRect(10, 10, 360, tooltipHeight);
    ctx.font = "9px JetBrains Mono, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#91a4ba";
    ctx.fillText(`${formatTime(candle.time, true)}  O ${formatPrice(candle.open, state.market.priceDecimals)}  H ${formatPrice(candle.high, state.market.priceDecimals)}  L ${formatPrice(candle.low, state.market.priceDecimals)}  C ${formatPrice(candle.close, state.market.priceDecimals)}`, 18, 22);
    ctx.fillStyle = "#22d3e2";
    ctx.fillText(`Cursor ${formatPrice(hoverPrice, state.market.priceDecimals)}`, 18, 36);
    if (mode === "footprint" && footprint) {
      ctx.fillStyle = qualityColor(footprint.quality);
      ctx.fillText(`${QUALITY_LABEL[footprint.quality]}  Bid ${volumeText(nearest?.bidVolume ?? 0)} × Ask ${volumeText(nearest?.askVolume ?? 0)}  Δ ${volumeText(footprint.delta)}  POC ${formatPrice(footprint.pocPrice, state.market.priceDecimals)}`, 18, 51);
    }
  }, [mode, state.market.priceDecimals]);

  const queueOverlay = useCallback(() => {
    if (overlayFrameRef.current !== null) return;
    overlayFrameRef.current = window.requestAnimationFrame(() => {
      overlayFrameRef.current = null;
      drawOverlay();
    });
  }, [drawOverlay]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const ctx = prepareCanvas(canvas, size.width, size.height, dpr);
    prepareCanvas(overlay, size.width, size.height, dpr);
    if (!ctx) return;

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
      renderMetaRef.current = null;
      ctx.fillStyle = "#6d7c91";
      ctx.font = "12px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Waiting for market data…", width / 2, height / 2);
      queueOverlay();
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
    const displayFootprints = new Map<number, FootprintCandle>();

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
        if (footprint) displayFootprints.set(candle.time, footprint);
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

    if (settings.showLargeTrades) {
      const visibleStart = visible[0].time;
      const visibleEnd = visible.at(-1)!.endTime;
      for (const item of large.events) {
        if (item.time < visibleStart || item.time > visibleEnd) continue;
        const candleIndex = visible.findIndex((candle) => item.time >= candle.time && item.time <= candle.endTime);
        if (candleIndex < 0) continue;
        const x = xFor(candleIndex);
        const y = yFor(item.price);
        if (y < -32 || y > plotHeight + 32) continue;
        const relative = Math.max(1, item.notional / Math.max(1, large.threshold));
        const radius = clamp(9 + Math.log2(relative + 1) * 5 + Math.min(4, Math.max(0, item.count - 1)), 10, 29);
        const buy = item.side === "buy";
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = buy ? "rgba(40,223,180,.28)" : "rgba(255,91,127,.28)";
        ctx.fill();
        ctx.strokeStyle = buy ? "rgba(65,241,197,.9)" : "rgba(255,120,149,.92)";
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, Math.max(2.5, radius * 0.16), 0, Math.PI * 2);
        ctx.fillStyle = buy ? "#41f1c5" : "#ff7895";
        ctx.fill();
        ctx.font = `800 ${radius >= 18 ? 8 : 7}px JetBrains Mono, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#f6fbff";
        ctx.fillText(bigOrderLabel(item.notional), x, y);
        if (item.count > 1 && radius >= 17) {
          ctx.font = "700 6px JetBrains Mono, monospace";
          ctx.fillStyle = buy ? "#9effe5" : "#ffc0cf";
          ctx.fillText(`×${item.count}`, x, y + radius * 0.48);
        }
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

    if (replayActive) {
      ctx.fillStyle = "rgba(41,31,10,.92)"; ctx.strokeStyle = "rgba(244,189,74,.45)";
      ctx.fillRect(plotWidth - 190, plotHeight - 34, 178, 24); ctx.strokeRect(plotWidth - 190, plotHeight - 34, 178, 24);
      ctx.fillStyle = "#f4bd4a"; ctx.font = "800 9px JetBrains Mono, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("RECORDED EVENT REPLAY", plotWidth - 101, plotHeight - 22);
    }

    renderMetaRef.current = { dpr, width, height, plotWidth, plotHeight, min, max, priceRange, xStep, displayStep, visible, footprints: displayFootprints };
    queueOverlay();
  }, [size, visible, state.analytics.sessionVwap, state.market.tickSize, state.market.footprintDefaultTicks, state.market.priceDecimals, mode, settings, replayActive, groupedBook, large, footprintByTime, queueOverlay]);

  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const queueOffset = useCallback((next: number) => {
    pendingOffsetRef.current = next;
    if (dragFrameRef.current !== null) return;
    dragFrameRef.current = window.requestAnimationFrame(() => {
      dragFrameRef.current = null;
      if (pendingOffsetRef.current !== null) setOffset(pendingOffsetRef.current);
      pendingOffsetRef.current = null;
    });
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const position = point(event);
    cursorRef.current = position;
    drag.current = { x: position.x, offset };
    queueOverlay();
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const position = point(event);
    cursorRef.current = position;
    queueOverlay();
    if (drag.current) {
      const step = Math.max(1, (size.width - 78) / Math.max(1, visible.length));
      const delta = Math.round((drag.current.x - position.x) / step);
      queueOffset(clamp(drag.current.offset + delta, 0, Math.max(0, state.candles.length - 20)));
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
  };

  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    setBars((current) => clamp(current + (event.deltaY > 0 ? 10 : -10), 10, 400));
  };

  return (
    <div className="vf-chart-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="vf-chart-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => { cursorRef.current = null; drag.current = null; queueOverlay(); }}
        onWheel={onWheel}
        aria-label={`${state.market.displayName} ${mode} chart`}
      />
      <canvas
        ref={overlayRef}
        aria-hidden="true"
        style={{ position: "absolute", inset: 0, pointerEvents: "none", width: "100%", height: "100%" }}
      />
      <div className="vf-chart-hud">
        <span>{visible.length} bars</span>
        <span>Zoom {bars}</span>
        {mode === "footprint" && <span>Rows {settings.footprintTicksPerRow} ticks+ · {state.footprintCoverage.quality.toUpperCase()}</span>}
        <span>Big orders ≥ {formatNotional(large.threshold)}</span>
      </div>
    </div>
  );
}
