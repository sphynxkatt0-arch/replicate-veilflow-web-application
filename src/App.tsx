import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildCryptoDataset, buildDataset, SYMBOLS, TIMEFRAMES, type Dataset, type Timeframe } from "./lib/chartData";
import { fetchBinanceKlines, fetchBinancePrice, subscribeBinanceLive } from "./lib/binance";

/* ---------------- icons ---------------- */
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    chart: "M2 8h4l2-7 4 14 3-9 2 2h5",
    pulse: "M2 12h4l2-7 4 14 3-9 2 2h5",
    gauge: "M4 17a8 8 0 1 1 16 0m-4-4l4-4m-4 4l4 4m-4-4c-1.5 0-3 1.5-3 3",
    history: "M4 6v5h5M5.5 16A8 8 0 1 0 4 11m8-5v5l3 2",
    settings: "M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9-4.03-9-9-9zm0 2c3.86 0 7 3.14 7 7s-3.14 7-7 7-7-3.14-7-7 3.14-7 7-7zm-1 2h2v2h-2zm0 4h2v6h-2z",
    menu: "M4 6h16M4 12h16M4 18h16",
    line: "M5 18L19 5M12 5h7v7",
    arrow: "M5 19L19 5M12 5h7v7",
    horizontal: "M4 12h16",
    rect: "M4 6h16v12H4z",
    ruler: "M5 12h14M9 8v8M15 8v8",
    trash: "M4 7h16M9 7V4h6v3m-8 0l1 13h8l1-13",
    reset: "M5 7v5h5M6 17a7 7 0 1 0-1-5",
    cursor: "M5 3l14 8-6 1-2 6z",
    discord: "M8 8a12 12 0 0 1 8 0l1.5 3.5a9 9 0 0 1-3 2l-.8-1.1M10.3 12.4l-.8 1.1a9 9 0 0 1-3-2L8 8",
    close: "M7 7L17 17M17 7L7 17",
    check: "M5 12l5 5 9-11",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={paths[name]} />
    </svg>
  );
}

/* ---------------- dropdown ---------------- */
function Dropdown({
  value,
  options,
  onChange,
  className = "",
  minWidth,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  className?: string;
  minWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div className={`dropdown ${className}`} ref={ref} style={minWidth ? { minWidth } : undefined}>
      <button className="dropdown-trigger" onClick={() => setOpen((o) => !o)}>
        <span>{value}</span>
        <span className={`chevron ${open ? "up" : ""}`} />
      </button>
      {open && (
        <div className="dropdown-menu">
          {options.map((opt) => (
            <button
              key={opt}
              className={`dropdown-item ${opt === value ? "sel" : ""}`}
              onClick={() => {
                onChange(opt);
                setOpen(false);
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- top bar ---------------- */
function TopBar({ latency, clock }: { latency: number; clock: string }) {
  return (
    <header className="topbar">
      <div className="wordmark">VEILFLOW</div>
      <nav className="main-nav">
        <button className="active">图表</button>
        <button>回放</button>
      </nav>
      <div className="topbar-right">
        <span className="latency">
          <i />
          {latency}ms
        </span>
        <span className="expiry">
          <em>有效期至</em> 2026-08-07&nbsp; {clock}
        </span>
        <button className="icon-btn">
          <Icon name="discord" size={18} />
        </button>
        <button className="icon-btn">
          <Icon name="settings" size={18} />
        </button>
      </div>
    </header>
  );
}

/* ---------------- toolbar ---------------- */
type OverlayState = { heat: boolean; bubbles: boolean; levels: boolean; signal: boolean };

function Toolbar({
  symbol,
  setSymbol,
  chartType,
  setChartType,
  flowMode,
  setFlowMode,
  axisMode,
  setAxisMode,
  timeframe,
  setTimeframe,
  session,
  setSession,
  overlays,
  toggleOverlay,
  formulaOpen,
  onFormula,
}: {
  symbol: string;
  setSymbol: (s: string) => void;
  chartType: string;
  setChartType: (s: string) => void;
  flowMode: string;
  setFlowMode: (s: string) => void;
  axisMode: string;
  setAxisMode: (s: string) => void;
  timeframe: string;
  setTimeframe: (s: string) => void;
  session: string;
  setSession: (s: string) => void;
  overlays: OverlayState;
  toggleOverlay: (k: keyof OverlayState) => void;
  formulaOpen: boolean;
  onFormula: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!settingsOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setSettingsOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [settingsOpen]);

  return (
    <div className="toolbar">
      <Icon name="pulse" size={18} />
      <Dropdown value={symbol} options={Object.keys(SYMBOLS)} onChange={setSymbol} minWidth={82} />
      <Dropdown value={chartType} options={["足迹", "买×卖", "K线"]} onChange={setChartType} minWidth={82} />
      <Dropdown value={flowMode} options={["买×卖", "买入", "卖出"]} onChange={setFlowMode} minWidth={90} />
      <Dropdown value={axisMode} options={["时间", "成交量", "Ticks"]} onChange={setAxisMode} minWidth={90} />
      <Dropdown value={timeframe} options={[...TIMEFRAMES]} onChange={setTimeframe} minWidth={72} />

      <div className="dropdown" ref={ref}>
        <button className={`plain-icon ${settingsOpen ? "on" : ""}`} onClick={() => setSettingsOpen((o) => !o)}>
          <Icon name="settings" size={16} />
        </button>
        {settingsOpen && (
          <div className="dropdown-menu wide">
            <div className="menu-head">显示图层</div>
            {(Object.keys(overlays) as (keyof OverlayState)[]).map((k) => (
              <button
                key={k}
                className="dropdown-item"
                onClick={() => toggleOverlay(k)}
              >
                <span className={`switch ${overlays[k] ? "on" : ""}`}>
                  <span />
                </span>
                {k === "heat" ? "流动性热力" : k === "bubbles" ? "聚合大单" : k === "levels" ? "期权水位" : "FADE / FOLLOW 信号"}
              </button>
            ))}
          </div>
        )}
      </div>

      <Dropdown value={session} options={["逐笔3天", "逐笔1天", "逐笔7天"]} onChange={setSession} minWidth={100} />
      <button className={`formula ${formulaOpen ? "on" : ""}`} onClick={onFormula} title="公式">
        <b>ƒ</b>
        <sub>x</sub>
      </button>
      <span className="toolbar-live" />
    </div>
  );
}

/* ---------------- drawing tools ---------------- */
type Tool = "cursor" | "trend" | "arrow" | "hline" | "rect" | "ruler";
type Drawing =
  | { id: number; tool: "trend" | "arrow" | "rect" | "ruler"; x1: number; y1: number; x2: number; y2: number }
  | { id: number; tool: "hline"; y1: number };

function shiftDrawing(d: Drawing, dx: number, dy: number): Drawing {
  if (d.tool === "hline") return { ...d, y1: d.y1 + dy };
  return { ...d, x1: d.x1 + dx, y1: d.y1 + dy, x2: d.x2 + dx, y2: d.y2 + dy };
}

function distToSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function DrawingTools({
  tool,
  setTool,
  onClear,
  onReset,
}: {
  tool: Tool;
  setTool: (t: Tool) => void;
  onClear: () => void;
  onReset: () => void;
}) {
  const btns: Array<{ t?: Tool; icon: string; title: string; action?: () => void; red?: boolean }> = [
    { t: "cursor", icon: "cursor", title: "光标" },
    { t: "trend", icon: "line", title: "趋势线" },
    { t: "arrow", icon: "arrow", title: "箭头" },
    { t: "hline", icon: "horizontal", title: "水平线" },
    { t: "rect", icon: "rect", title: "矩形" },
    { t: "ruler", icon: "ruler", title: "测量" },
  ];
  return (
    <div className="drawing-tools">
      {btns.map((b) => (
        <button
          key={b.icon}
          className={tool === b.t ? "on" : ""}
          title={b.title}
          onClick={() => b.t && setTool(b.t)}
        >
          <Icon name={b.icon} />
        </button>
      ))}
      <button className="red" title="清除绘图" onClick={onClear}>
        <Icon name="trash" />
      </button>
      <button title="重置视图" onClick={onReset}>
        <Icon name="reset" />
      </button>
    </div>
  );
}

/* ---------------- chart ---------------- */
const toneColor = {
  cyan: "#16c4da",
  green: "#35c896",
  gold: "#efb53d",
  red: "#f16669",
  purple: "#a34ef5",
} as const;

type Viewport = { start: number; count: number };

function Chart({
  data,
  chartType,
  flowMode,
  overlays,
  tool,
  drawings,
  setDrawings,
  viewport,
  setViewport,
  resetSignal,
  formulas,
}: {
  data: Dataset;
  chartType: string;
  flowMode: string;
  overlays: OverlayState;
  tool: Tool;
  drawings: Drawing[];
  setDrawings: React.Dispatch<React.SetStateAction<Drawing[]>>;
  viewport: Viewport;
  setViewport: React.Dispatch<React.SetStateAction<Viewport>>;
  resetSignal: number;
  formulas: number[];
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1200, h: 700 });
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<Drawing | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const dragRef = useRef<{
    mode: "pan" | "draw" | "move";
    startX: number;
    startY: number;
    startVpStart: number;
    drawId?: number;
    orig?: Drawing;
  } | null>(null);
  const idRef = useRef(1);

  useLayoutEffect(() => {
    if (!wrapRef.current) return;
    const el = wrapRef.current;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const AXIS_W = 84;
  const plotW = size.w - AXIS_W;
  const plotH = size.h;

  const visible = useMemo(() => {
    const start = Math.max(0, Math.floor(viewport.start));
    const end = Math.min(data.count, start + viewport.count);
    return { start, end };
  }, [viewport, data.count]);

  const candleW = plotW / (visible.end - visible.start);

  const priceScale = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = visible.start; i < visible.end; i++) {
      const c = data.candles[i];
      if (!c) continue;
      lo = Math.min(lo, c.low);
      hi = Math.max(hi, c.high);
    }
    if (!isFinite(lo)) {
      lo = data.priceMin;
      hi = data.priceMax;
    }
    if (overlays.levels) {
      for (const lvl of data.levels) {
        if (lvl.price > lo - (hi - lo) && lvl.price < hi + (hi - lo)) {
          lo = Math.min(lo, lvl.price);
          hi = Math.max(hi, lvl.price);
        }
      }
    }
    const pad = (hi - lo) * 0.06 || 1;
    return { min: lo - pad, max: hi + pad };
  }, [visible, data, overlays.levels]);

  const priceToY = useCallback(
    (p: number) => ((priceScale.max - p) / (priceScale.max - priceScale.min)) * plotH,
    [priceScale, plotH]
  );
  const yToPrice = useCallback(
    (y: number) => priceScale.max - (y / plotH) * (priceScale.max - priceScale.min),
    [priceScale, plotH]
  );
  const indexToX = useCallback(
    (i: number) => (i - visible.start + 0.5) * candleW,
    [visible.start, candleW]
  );

  const hitTest = useCallback(
    (x: number, y: number): Drawing | null => {
      for (let k = drawings.length - 1; k >= 0; k--) {
        const d = drawings[k];
        if (d.tool === "hline") {
          if (Math.abs(d.y1 - y) <= 7 && x <= plotW) return d;
        } else if (d.tool === "rect") {
          const rx1 = Math.min(d.x1, d.x2);
          const rx2 = Math.max(d.x1, d.x2);
          const ry1 = Math.min(d.y1, d.y2);
          const ry2 = Math.max(d.y1, d.y2);
          if (x < rx1 || x > rx2 || y < ry1 || y > ry2) continue;
          const nearEdge =
            Math.min(Math.abs(x - rx1), Math.abs(x - rx2)) <= 6 ||
            Math.min(Math.abs(y - ry1), Math.abs(y - ry2)) <= 6;
          if (nearEdge || (rx2 - rx1) * (ry2 - ry1) < 400) return d;
        } else {
          if (distToSeg(x, y, d.x1, d.y1, d.x2, d.y2) <= 7) return d;
        }
      }
      return null;
    },
    [drawings, plotW]
  );

  useEffect(() => {
    setDraft(null);
    setSelectedId(null);
  }, [resetSignal]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId !== null) {
        e.preventDefault();
        setDrawings((ds) => ds.filter((d) => d.id !== selectedId));
        setSelectedId(null);
      } else if (e.key === "Escape") {
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, setDrawings]);

  const relPos = (e: React.MouseEvent | React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = relPos(e);
    if (x > plotW) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (tool === "cursor") {
      const hit = hitTest(x, y);
      if (hit) {
        setSelectedId(hit.id);
        dragRef.current = { mode: "move", startX: x, startY: y, startVpStart: 0, drawId: hit.id, orig: hit };
      } else {
        setSelectedId(null);
        dragRef.current = { mode: "pan", startX: x, startY: 0, startVpStart: viewport.start };
      }
    } else if (tool === "hline") {
      setDrawings((d) => [...d, { id: idRef.current++, tool: "hline", y1: y }]);
    } else {
      dragRef.current = { mode: "draw", startX: x, startY: 0, startVpStart: 0 };
      setDraft({ id: idRef.current++, tool, x1: x, y1: y, x2: x, y2: y });
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = relPos(e);
    setCursor(x <= plotW ? { x, y } : null);
    const drag = dragRef.current;
    if (!drag) {
      setHoverId(tool === "cursor" && x <= plotW ? (hitTest(x, y)?.id ?? null) : null);
      return;
    }
    if (drag.mode === "pan") {
      const dxCandles = (drag.startX - x) / candleW;
      setViewport((vp) => {
        const maxStart = data.count - vp.count;
        const next = Math.max(0, Math.min(maxStart, drag.startVpStart + dxCandles));
        return { ...vp, start: next };
      });
    } else if (drag.mode === "draw" && draft && draft.tool !== "hline") {
      setDraft({ ...draft, x2: x, y2: y });
    } else if (drag.mode === "move" && drag.orig !== undefined && drag.drawId !== undefined) {
      const dx = x - drag.startX;
      const dy = y - drag.startY;
      setDrawings((ds) => ds.map((d) => (d.id === drag.drawId ? shiftDrawing(d, dx, dy) : d)));
    }
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    if (drag?.mode === "draw" && draft && draft.tool !== "hline") {
      const dx = Math.abs(draft.x2 - draft.x1);
      const dy = Math.abs(draft.y2 - draft.y1);
      if (dx + dy > 6) setDrawings((d) => [...d, draft]);
    }
    dragRef.current = null;
    setDraft(null);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const { x, y } = relPos(e);
    const hit = hitTest(x, y);
    if (hit) {
      setDrawings((ds) => ds.filter((d) => d.id !== hit.id));
      setSelectedId(null);
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x > plotW) return;
    const anchorIndex = visible.start + (x / plotW) * (visible.end - visible.start);
    const factor = e.deltaY > 0 ? 1.12 : 0.89;
    setViewport((vp) => {
      const newCount = Math.max(20, Math.min(data.count, Math.round(vp.count * factor)));
      const frac = (anchorIndex - vp.start) / vp.count;
      let newStart = anchorIndex - frac * newCount;
      newStart = Math.max(0, Math.min(data.count - newCount, newStart));
      return { start: newStart, count: newCount };
    });
  };

  const gridLines = useMemo(() => {
    const lines: number[] = [];
    const range = priceScale.max - priceScale.min;
    const rough = range / 9;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? mag;
    const first = Math.ceil(priceScale.min / step) * step;
    for (let p = first; p <= priceScale.max; p += step) lines.push(p);
    return lines;
  }, [priceScale]);

  const dec = data.spec.decimals;
  const cursorPrice = cursor ? yToPrice(cursor.y) : null;
  const cursorIndex = cursor ? Math.floor(visible.start + (cursor.x / plotW) * (visible.end - visible.start)) : null;

  return (
    <div
      ref={wrapRef}
      className="chart-canvas"
      style={{ cursor: hoverId !== null && tool === "cursor" ? "pointer" : undefined }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        setCursor(null);
        setHoverId(null);
      }}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
    >
      <svg width={size.w} height={size.h}>
        {/* grain texture */}
        <filter id="grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2" />
          <feColorMatrix type="matrix" values="0 0 0 0 0, 0 0 0 0 0, 0 0 0 0 0, 0 0 0 0.05 0" />
        </filter>
        <rect width={size.w} height={size.h} filter="url(#grain)" opacity="0.7" />
        {/* scanline */}
        <pattern id="scan" patternUnits="userSpaceOnUse" width="100%" height="4">
          <rect width="100%" height="1" fill="rgba(2,4,8,0.22)" />
        </pattern>
        <rect width={size.w} height={size.h} fill="url(#scan)" opacity="0.35" />
        <defs>
          <radialGradient id="chartShade" cx="45%" cy="35%" r="80%">
            <stop offset="0" stopColor="#1a2028" />
            <stop offset="1" stopColor="#07090d" />
          </radialGradient>
          <filter id="softGlow">
            <feGaussianBlur stdDeviation="1.2" />
          </filter>
        </defs>
        <rect width={plotW} height={plotH} fill="url(#chartShade)" />
        <rect x={plotW} width={AXIS_W} height={plotH} fill="#080b10" />

        {/* grid */}
        {gridLines.map((p) => (
          <g key={p}>
            <line x1={0} x2={plotW} y1={priceToY(p)} y2={priceToY(p)} stroke="#21252c" strokeWidth="0.7" opacity="0.28" />
            <text x={size.w - 4} y={priceToY(p) + 4} textAnchor="end" fill="#a9afba" fontSize="9.5" fontFamily="var(--font-mono)" fontWeight="600">
              {p.toFixed(dec)}
            </text>
          </g>
        ))}

        {/* liquidity heat */}
        {overlays.heat &&
          data.heat.map((line, k) => {
            const color = toneColor[line.tone];
            const x1 = indexToX(line.i);
            const x2 = indexToX(Math.min(data.count - 1, line.i + line.span));
            if (x2 < 0 || x1 > plotW) return null;
            const y = priceToY(line.price);
            return (
              <g key={`h${k}`} opacity={line.opacity}>
                <line
                  x1={Math.max(0, x1)}
                  x2={Math.min(plotW, x2)}
                  y1={y}
                  y2={y}
                  stroke={color}
                  strokeWidth={line.thick ? 5.5 : 1.6}
                  strokeDasharray={line.thick ? undefined : `${2 + (k % 4)} ${1 + (k % 3)}`}
                />
              </g>
            );
          })}

        {/* candlesticks */}
        {data.candles.map((c, i) => {
          if (i < visible.start || i >= visible.end) return null;
          const x = indexToX(i);
          const up = c.close >= c.open;
          const col = up ? "#cfd7e6" : "#8791a5";
          const yO = priceToY(c.open);
          const yC = priceToY(c.close);
          const yH = priceToY(c.high);
          const yL = priceToY(c.low);
          const bodyW = Math.max(1.4, Math.min(9, candleW * 0.62));
          return (
            <g key={i}>
              <line x1={x} x2={x} y1={yH} y2={yL} stroke={col} strokeWidth={1.35} opacity="0.88" />
              <rect
                x={x - bodyW / 2}
                y={Math.min(yO, yC)}
                width={bodyW}
                height={Math.max(1.4, Math.abs(yC - yO))}
                fill={up ? "rgba(203,213,225,0.74)" : "rgba(73,82,99,0.92)"}
                stroke={up ? "#d6dde9" : "#9ba5b8"}
                strokeWidth={1}
              />
              {chartType === "足迹" && candleW > 6 && (
                <>
                  <text x={x + bodyW / 2 + 1} y={yH + 8} fill="#3f9c7f" fontSize="6.5" fontFamily="var(--font-mono)">
                    {c.buyVol}
                  </text>
                  <text x={x + bodyW / 2 + 1} y={yL} fill="#b25a5f" fontSize="6.5" fontFamily="var(--font-mono)">
                    {c.sellVol}
                  </text>
                </>
              )}
            </g>
          );
        })}

        {/* aggregated bubbles */}
        {overlays.bubbles &&
          data.flows
            .filter((f) => flowMode === "买×卖" || (flowMode === "买入" && f.side === "buy") || (flowMode === "卖出" && f.side === "sell"))
            .map((f, k) => {
              if (f.i < visible.start || f.i >= visible.end) return null;
              const x = indexToX(f.i);
              const y = priceToY(f.price);
              const r = 7 + Math.min(13, (f.value - 40) / 9);
              const buy = f.side === "buy";
              return (
                <g key={`f${k}`} className="flow-bubble">
                  <circle cx={x} cy={y} r={r} fill={buy ? "#123f35" : "#4b2529"} stroke={buy ? "#2aaa82" : "#b44f54"} strokeWidth="1" opacity="0.85" />
                  <text x={x} y={y + 3} textAnchor="middle" fill="#d5dde5" fontSize="8.5" fontFamily="var(--font-mono)" fontWeight="700">
                    {f.value}
                  </text>
                </g>
              );
            })}

        {/* option levels */}
        {overlays.levels &&
          data.levels.map((lvl) => {
            const y = priceToY(lvl.price);
            if (y < 0 || y > plotH) return null;
            return (
              <g key={lvl.tag + lvl.price}>
                <line x1={plotW - 110} x2={plotW} y1={y} y2={y} stroke={lvl.color} strokeWidth="1" opacity="0.55" />
                <rect x={plotW - 1} y={y - 10} width={AXIS_W} height="20" rx="3" fill="#0d1118" stroke={lvl.color} />
                <rect x={plotW - 1} y={y - 10} width="26" height="20" rx="3" fill={lvl.color} />
                <text x={plotW + 12} y={y + 4} fill="#091014" textAnchor="middle" fontSize="8.5" fontFamily="var(--font-mono)" fontWeight="800">
                  {lvl.tag}
                </text>
                <text x={plotW + 50} y={y + 4} fill={lvl.color} textAnchor="middle" fontSize="9" fontFamily="var(--font-mono)" fontWeight="700">
                  {lvl.price.toFixed(dec)}
                </text>
              </g>
            );
          })}

        {/* last price line */}
        {(() => {
          const y = priceToY(data.lastPrice);
          return (
            <g>
              <line x1={0} x2={plotW} y1={y} y2={y} stroke="#8090a5" strokeWidth="0.7" strokeDasharray="4 3" opacity="0.7" />
              <rect x={plotW - 1} y={y - 10} width={AXIS_W} height="20" rx="3" fill="#131b27" stroke="#8290aa" />
              <text x={plotW + AXIS_W / 2} y={y + 4} fill="#cbd7e8" textAnchor="middle" fontSize="10" fontFamily="var(--font-mono)" fontWeight="700">
                {data.lastPrice.toFixed(dec)}
              </text>
            </g>
          );
        })()}

        {/* formula lines */}
        {formulas.map((p, k) => {
          const y = priceToY(p);
          if (y < 0 || y > plotH) return null;
          return (
            <g key={`gx${k}`}>
              <line x1={0} x2={plotW} y1={y} y2={y} stroke="#22f3de" strokeWidth="1" strokeDasharray="8 5" opacity="0.7" />
              <rect x={plotW - 1} y={y - 9} width={AXIS_W} height="18" rx="2" fill="#0e2328" stroke="#22f3de" />
              <text x={plotW + AXIS_W / 2} y={y + 3} fill="#6df7e8" textAnchor="middle" fontSize="9.5" fontFamily="var(--font-mono)" fontWeight="700">
                ƒ{p.toFixed(dec)}
              </text>
            </g>
          );
        })}

        {/* user drawings */}
        {[...drawings, ...(draft ? [draft] : [])].map((d) => {
          const sel = d.id === selectedId;
          if (d.tool === "hline") {
            return (
              <g key={d.id}>
                <line x1={0} x2={plotW} y1={d.y1} y2={d.y1} stroke={sel ? "#22f3de" : "#efb53d"} strokeWidth={sel ? 1.6 : 1.2} strokeDasharray="6 4" />
                {sel && <circle cx={plotW - 8} cy={d.y1} r={3.5} fill="#22f3de" />}
              </g>
            );
          }
          if (d.tool === "rect") {
            const rx1 = Math.min(d.x1, d.x2);
            const ry1 = Math.min(d.y1, d.y2);
            const rw = Math.abs(d.x2 - d.x1);
            const rh = Math.abs(d.y2 - d.y1);
            return (
              <g key={d.id}>
                <rect x={rx1} y={ry1} width={rw} height={rh} fill="#28d9c822" stroke={sel ? "#22f3de" : "#28d9c8"} strokeWidth={sel ? 1.6 : 1.2} />
                {sel && (
                  <>
                    <circle cx={rx1} cy={ry1} r={3} fill="#22f3de" />
                    <circle cx={rx1 + rw} cy={ry1} r={3} fill="#22f3de" />
                    <circle cx={rx1} cy={ry1 + rh} r={3} fill="#22f3de" />
                    <circle cx={rx1 + rw} cy={ry1 + rh} r={3} fill="#22f3de" />
                  </>
                )}
              </g>
            );
          }
          const color = sel ? "#22f3de" : d.tool === "ruler" ? "#9eb8e0" : "#28d9c8";
          return (
            <g key={d.id}>
              <line x1={d.x1} y1={d.y1} x2={d.x2} y2={d.y2} stroke={color} strokeWidth={sel ? 1.8 : 1.4} markerEnd={d.tool === "arrow" ? "url(#arrowHead)" : undefined} />
              {d.tool === "ruler" && (
                <text x={(d.x1 + d.x2) / 2} y={(d.y1 + d.y2) / 2 - 5} fill="#9eb8e0" fontSize="10" fontFamily="var(--font-mono)" textAnchor="middle">
                  {(yToPrice(d.y2) - yToPrice(d.y1)).toFixed(dec)}
                </text>
              )}
              {sel && (
                <>
                  <circle cx={d.x1} cy={d.y1} r={3} fill="#22f3de" />
                  <circle cx={d.x2} cy={d.y2} r={3} fill="#22f3de" />
                </>
              )}
            </g>
          );
        })}
        <defs>
          <marker id="arrowHead" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto">
            <path d="M0 0 L9 4.5 L0 9 Z" fill="#28d9c8" />
          </marker>
        </defs>

        {/* crosshair */}
        {cursor && (
          <g pointerEvents="none">
            <line x1={cursor.x} x2={cursor.x} y1={0} y2={plotH} stroke="#5a6675" strokeWidth="0.6" strokeDasharray="3 3" />
            <line x1={0} x2={plotW} y1={cursor.y} y2={cursor.y} stroke="#5a6675" strokeWidth="0.6" strokeDasharray="3 3" />
            <rect x={plotW - 1} y={cursor.y - 9} width={AXIS_W} height="18" rx="2" fill="#2a3140" />
            <text x={plotW + AXIS_W / 2} y={cursor.y + 4} fill="#e6ecf3" textAnchor="middle" fontSize="9.5" fontFamily="var(--font-mono)" fontWeight="700">
              {cursorPrice?.toFixed(dec)}
            </text>
          </g>
        )}
      </svg>

      {/* crosshair tooltip */}
      {cursor && cursorIndex !== null && data.candles[cursorIndex] && (
        <div className="ohlc-tip" style={{ left: Math.min(cursor.x + 14, plotW - 190), top: 8 }}>
          {(() => {
            const c = data.candles[cursorIndex];
            const up = c.close >= c.open;
            return (
              <>
                <span>O <b>{c.open.toFixed(dec)}</b></span>
                <span>H <b>{c.high.toFixed(dec)}</b></span>
                <span>L <b>{c.low.toFixed(dec)}</b></span>
                <span>C <b className={up ? "up" : "dn"}>{c.close.toFixed(dec)}</b></span>
                <span>Δ <b className={c.buyVol - c.sellVol >= 0 ? "up" : "dn"}>{c.buyVol - c.sellVol > 0 ? "+" : ""}{c.buyVol - c.sellVol}</b></span>
              </>
            );
          })()}
        </div>
      )}

      {/* FOLLOW annotation */}
      {overlays.signal && (
        <div className="follow-callout">
          <strong>FOLLOW 顺势</strong>
          <span>价在 ZG 下方 168 点</span>
          <span>量信 强 · ODTE 净γ -2k 印证</span>
        </div>
      )}
    </div>
  );
}

/* ---------------- sidebar ---------------- */
function Sidebar() {
  return (
    <aside className="sidebar">
      <button className="side-main active">
        <Icon name="chart" size={22} />
        <span>盘面</span>
      </button>
      <button className="side-main">
        <Icon name="gauge" size={21} />
        <span>情报</span>
      </button>
      <button className="side-main muted">
        <Icon name="history" size={21} />
        <span>复盘</span>
      </button>
    </aside>
  );
}

/* ---------------- indicator overlay ---------------- */
function IndicatorOverlay({ overlays }: { overlays: OverlayState }) {
  return (
    <div className="indicator-overlay">
      <div className="indicator-text">
        <span className={overlays.levels ? "" : "off"}>期权水位(10)</span>
        <span className={overlays.signal ? "" : "off"}>FADE / FOLLOW</span>
        <span className={overlays.bubbles ? "" : "off"}>聚合大单(40手)</span>
      </div>
    </div>
  );
}

/* ---------------- formula panel ---------------- */
function FormulaPanel({
  lastPrice,
  onAdd,
  onClose,
}: {
  lastPrice: number;
  onAdd: (price: number) => void;
  onClose: () => void;
}) {
  const [expr, setExpr] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [value, setValue] = useState<string | null>(null);

  const tryEval = (): number | null => {
    const e = expr.replace(/P/gi, String(lastPrice)).trim();
    if (!e) {
      setError(null);
      return null;
    }
    if (!/^[0-9+\-*/().\s]+$/.test(e)) {
      setError("仅支持数字、P(现价) 与 + - * / ( )");
      setValue(null);
      return null;
    }
    try {
      const v = new Function(`"use strict"; return (${e});`)() as unknown;
      if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("bad result");
      setError(null);
      setValue(String(v));
      return v;
    } catch {
      setError("表达式无法计算");
      setValue(null);
      return null;
    }
  };

  const submit = () => {
    const v = tryEval();
    if (v !== null) {
      onAdd(v);
      setExpr("");
      setValue(null);
    }
  };

  return (
    <div className="formula-panel">
      <div className="formula-panel-head">ƒₓ 公式</div>
      <input
        autoFocus
        value={expr}
        onChange={(e) => {
          setExpr(e.target.value);
          setValue(null);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="如 (P + 1000) / 2 · P=现价"
      />
      <div className="formula-panel-foot">
        <em className={error ? "err" : ""}>{error ?? (value !== null ? `ƒ = ${value}` : "回车计算结果并画线")}</em>
        <button onClick={submit}>绘图</button>
        <button onClick={onClose}>×</button>
      </div>
    </div>
  );
}

/* ---------------- app ---------------- */
export default function App() {
  const [symbol, setSymbol] = useState("NQ");
  const [chartType, setChartType] = useState("足迹");
  const [flowMode, setFlowMode] = useState("买×卖");
  const [axisMode, setAxisMode] = useState("时间");
  const [timeframe, setTimeframe] = useState<Timeframe>("1m");
  const [session, setSession] = useState("逐笔3天");
  const [latency, setLatency] = useState(173);
  const [clock, setClock] = useState("10:55:54");

  const [overlays, setOverlays] = useState<OverlayState>({ heat: true, bubbles: true, levels: true, signal: true });
  const toggleOverlay = (k: keyof OverlayState) => setOverlays((o) => ({ ...o, [k]: !o[k] }));

  const [tool, setTool] = useState<Tool>("cursor");
  const [drawings, setDrawings] = useState<Drawing[]>([]);

  const [data, setData] = useState<Dataset>(() => buildDataset(symbol, timeframe));
  const [loading, setLoading] = useState(false);
  const [mockMode, setMockMode] = useState(false);
  const [formulaOpen, setFormulaOpen] = useState(false);
  const [formulaLines, setFormulaLines] = useState<number[]>([]);

  useEffect(() => {
    const spec = SYMBOLS[symbol];
    if (spec.source !== "binance") {
      setData(buildDataset(symbol, timeframe));
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchBinanceKlines(spec.pair!, timeframe)
      .then((klines) => {
        if (cancelled) return;
        setData(buildCryptoDataset(spec, timeframe, klines));
        setMockMode(false);
      })
      .catch((err) => {
        console.warn("Binance 数据获取失败，回退模拟数据:", err);
        if (!cancelled) {
          setData(buildDataset(symbol, timeframe));
          setMockMode(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe]);

  // live updates for crypto pairs: WebSocket candle/trade streams + REST price polling
  useEffect(() => {
    const spec = SYMBOLS[symbol];
    if (spec.source !== "binance") return;
    const pair = spec.pair!;
    let cancelled = false;

    const applyLive = (patch: (d: Dataset) => Dataset) => {
      if (cancelled) return;
      setData((d) => (d ? patch(d) : d));
    };

    const offLive = subscribeBinanceLive(pair, timeframe, (k) => {
      applyLive((d) => {
        if (d.candles.length === 0) return d;
        const last = d.candles[d.candles.length - 1];
        const lastOpen = (last as { openTime?: number }).openTime ?? 0;
        if (k.openTime !== lastOpen) return d;
        const candles = [...d.candles];
        const i = candles.length - 1;
        candles[i] = {
          ...last,
          high: Math.max(last.high, k.high),
          low: Math.min(last.low, k.low),
          close: k.close,
          buyVol: Math.max(last.buyVol, k.buyVol),
          sellVol: Math.max(last.sellVol, k.sellVol),
        };
        return {
          ...d,
          candles,
          lastPrice: k.close,
          priceMax: Math.max(d.priceMax, k.high),
          priceMin: Math.min(d.priceMin, k.low),
        };
      });
      if (k.isClosed) {
        fetchBinanceKlines(pair, timeframe)
          .then((klines) => {
            if (cancelled || klines.length === 0) return;
            setData(buildCryptoDataset(SYMBOLS[symbol], timeframe, klines));
            setMockMode(false);
          })
          .catch(() => {});
      }
    });

    // safety net: keep the price real even if the WebSocket is blocked
    const id = window.setInterval(() => {
      fetchBinancePrice(pair)
        .then((p) => {
          applyLive((d) => {
            if (d.candles.length === 0) return d;
            const candles = [...d.candles];
            const i = candles.length - 1;
            const last = candles[i];
            candles[i] = { ...last, high: Math.max(last.high, p), low: Math.min(last.low, p), close: p };
            return { ...d, candles, lastPrice: p, priceMax: Math.max(d.priceMax, p), priceMin: Math.min(d.priceMin, p) };
          });
        })
        .catch(() => {});
    }, 5000);

    return () => {
      cancelled = true;
      offLive();
      window.clearInterval(id);
    };
  }, [symbol, timeframe]);

  const [viewport, setViewport] = useState<Viewport>({ start: 0, count: data.count });
  const [resetSignal, setResetSignal] = useState(0);

  useEffect(() => {
    setViewport({ start: 0, count: data.count });
    setDrawings([]);
    setFormulaLines([]);
    setResetSignal((s) => s + 1);
  }, [symbol, timeframe, data.count]);

  const resetView = () => {
    setViewport({ start: 0, count: data.count });
    setResetSignal((s) => s + 1);
  };

  useEffect(() => {
    const t = window.setInterval(() => {
      setLatency(166 + Math.floor(Math.random() * 18));
      setClock(
        new Date().toLocaleTimeString("en-GB", { hour12: false }).replace(/^24/, "00")
      );
    }, 1500);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="terminal-shell">
      <TopBar latency={latency} clock={clock} />
      <Sidebar />

      <main className="workspace">
        {/* status dots */}
        <div className="status-dot blink" style={{ right: "138px", top: "108px", width: "12px", height: "12px", background: "#22f3de" }} />
        <div className="status-dot" style={{ right: "620px", top: "45px", width: "8px", height: "8px", background: "#ffc95f" }} />
        <div className="status-dot" style={{ bottom: "28px", left: "28%", width: "11px", height: "11px", background: "#c35cff" }} />
        <div className="tabstrip">
          <div className="chart-tab">
            <Icon name="pulse" size={17} />
            <span>图表1</span>
          </div>
          <button className="tab-close">
            <Icon name="close" size={13} />
          </button>
        </div>

        <Toolbar
          symbol={symbol}
          setSymbol={setSymbol}
          chartType={chartType}
          setChartType={setChartType}
          flowMode={flowMode}
          setFlowMode={setFlowMode}
          axisMode={axisMode}
          setAxisMode={setAxisMode}
          timeframe={timeframe}
          setTimeframe={(v) => setTimeframe(v as Timeframe)}
          session={session}
          setSession={setSession}
          overlays={overlays}
          toggleOverlay={toggleOverlay}
          formulaOpen={formulaOpen}
          onFormula={() => setFormulaOpen((o) => !o)}
        />

        <div className="chart-stage">
          <Chart
            data={data}
            chartType={chartType}
            flowMode={flowMode}
            overlays={overlays}
            tool={tool}
            drawings={drawings}
            setDrawings={setDrawings}
            viewport={viewport}
            setViewport={setViewport}
            resetSignal={resetSignal}
            formulas={formulaLines}
          />
          {loading && <div className="chart-loading">连接 Binance · 加载中…</div>}
          {mockMode && <div className="chart-loading warn">Binance 不可用 · 当前显示模拟数据</div>}
          {formulaOpen && (
            <FormulaPanel
              lastPrice={data.lastPrice}
              onAdd={(p) => setFormulaLines((ls) => [...ls, p])}
              onClose={() => setFormulaOpen(false)}
            />
          )}
          <IndicatorOverlay overlays={overlays} />
          <DrawingTools tool={tool} setTool={setTool} onClear={() => setDrawings([])} onReset={resetView} />
        </div>
      </main>
    </div>
  );
}