import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { detectLargeTrades } from "./analytics";
import { MarketChart } from "./Chart";
import { formatCompact, formatNotional, formatPrice, formatTime } from "./format";
import { MARKETS, TIMEFRAMES } from "./markets";
import { groupBook } from "./orderBook";
import type { ChartMode, DataQuality, FootprintQuality, MarketKey, MarketState, Timeframe } from "./types";
import { useMarketEngine } from "./useMarketEngine";
import "./worldclass.css";

interface Settings {
  showGrid: boolean;
  showVolume: boolean;
  showVwap: boolean;
  showDepth: boolean;
  showLargeTrades: boolean;
  autoFollow: boolean;
  showFootprintDelta: boolean;
  footprintTicksPerRow: number;
  footprintImbalanceRatio: number;
  footprintMinVolume: number;
  density: "compact" | "comfortable";
}

type BooleanSetting = "showGrid" | "showVolume" | "showVwap" | "showDepth" | "showLargeTrades" | "autoFollow" | "showFootprintDelta";

const DEFAULT_SETTINGS: Settings = {
  showGrid: true,
  showVolume: true,
  showVwap: true,
  showDepth: true,
  showLargeTrades: true,
  autoFollow: true,
  showFootprintDelta: true,
  footprintTicksPerRow: 10,
  footprintImbalanceRatio: 3,
  footprintMinVolume: 0.05,
  density: "compact",
};

function useStoredState<T>(key: string, fallback: T): [T, (value: T | ((current: T) => T)) => void] {
  const [state, setState] = useState<T>(() => {
    try { const raw = localStorage.getItem(key); return raw ? { ...fallback as object, ...JSON.parse(raw) as object } as T : fallback; }
    catch { return fallback; }
  });
  const update = useCallback((value: T | ((current: T) => T)) => {
    setState((current) => {
      const next = typeof value === "function" ? (value as (item: T) => T)(current) : value;
      try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* non-critical */ }
      return next;
    });
  }, [key]);
  return [state, update];
}

function QualityBadge({ quality, text }: { quality: DataQuality; text?: string }) {
  return <span className={`vf-quality vf-quality-${quality}`}>{text ?? quality.replace("-", " ")}</span>;
}

function footprintDataQuality(quality: FootprintQuality): DataQuality {
  if (quality === "full" || quality === "replay-full") return "full";
  if (quality === "gapped") return "gapped";
  if (quality === "aggregate-only") return "aggregate";
  return "live-only";
}

function marketProductText(state: MarketState): string {
  if (state.market.productType === "spot") return "SPOT";
  if (state.market.productType === "perpetual") return "USDⓈ-M PERP";
  return "PROXY · NOT CME";
}

function ConnectionChip({ state }: { state: MarketState }) {
  return (
    <div className={`vf-connection vf-connection-${state.status}`} title={state.statusDetail}>
      <i />
      <span>{state.status}</span>
      <small>{state.statusDetail}</small>
    </div>
  );
}

function MetricCard({ label, value, detail, tone }: { label: string; value: string; detail: string; tone?: "positive" | "negative" | "warning" }) {
  return (
    <div className={`vf-metric ${tone ? `vf-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function OrderBookPanel({ state, collapsed, onToggle }: { state: MarketState; collapsed: boolean; onToggle: () => void }) {
  const groupSize = Math.max(state.market.tickSize, (state.book?.asks[0]?.price ?? 1) * 0.00005);
  const book = useMemo(() => groupBook(state.book, groupSize, 15), [state.book, groupSize]);
  const levels = book ? [...book.asks.slice().reverse(), ...book.bids] : [];
  const maxSize = Math.max(1, ...levels.map((level) => level.size));
  const bestBid = book?.bids[0]; const bestAsk = book?.asks[0];
  const spread = bestBid && bestAsk ? bestAsk.price - bestBid.price : undefined;
  return (
    <section className={`vf-panel ${collapsed ? "vf-collapsed" : ""}`}>
      <header onDoubleClick={onToggle}>
        <div><small>SEQUENCE-AWARE DEPTH</small><h2>Order Book</h2></div>
        <QualityBadge quality={state.book?.quality ?? "unavailable"} text={state.book?.sequence ? `SYNC ${state.book.sequence}` : undefined} />
        <button type="button" onClick={onToggle} aria-label={collapsed ? "Expand order book" : "Collapse order book"}>{collapsed ? "+" : "−"}</button>
      </header>
      {!collapsed && <>
        <div className="vf-book-summary">
          <span>Weighted pressure <b>{state.analytics.buyPressure === undefined ? "—" : `${(state.analytics.buyPressure * 100).toFixed(1)}% buy`}</b></span>
          <div><i style={{ width: `${(state.analytics.buyPressure ?? 0.5) * 100}%` }} /></div>
        </div>
        <div className="vf-book-head"><span>Price</span><span>Size</span><span>Notional</span></div>
        <div className="vf-book-list">
          {book?.asks.slice(0, 8).reverse().map((level) => (
            <div className="vf-book-row vf-ask" key={`a-${level.price}`}>
              <i style={{ width: `${level.size / maxSize * 100}%` }} /><span>{formatPrice(level.price, state.market.priceDecimals)}</span><span>{formatCompact(level.size, 3)}</span><span>{formatNotional(level.price * level.size)}</span>
            </div>
          ))}
          <div className="vf-spread-row">
            <span><small>BEST BID</small><b>{formatPrice(bestBid?.price, state.market.priceDecimals)}</b></span>
            <strong>{spread === undefined ? "—" : `${formatPrice(spread, state.market.priceDecimals)} · ${formatPrice(state.analytics.spreadBps, 2)} bps`}</strong>
            <span><small>BEST ASK</small><b>{formatPrice(bestAsk?.price, state.market.priceDecimals)}</b></span>
          </div>
          {book?.bids.slice(0, 8).map((level) => (
            <div className="vf-book-row vf-bid" key={`b-${level.price}`}>
              <i style={{ width: `${level.size / maxSize * 100}%` }} /><span>{formatPrice(level.price, state.market.priceDecimals)}</span><span>{formatCompact(level.size, 3)}</span><span>{formatNotional(level.price * level.size)}</span>
            </div>
          ))}
        </div>
        <footer><span>Microprice <b>{formatPrice(state.analytics.microprice, state.market.priceDecimals)}</b></span><span>Group <b>{formatPrice(groupSize, state.market.priceDecimals)}</b></span></footer>
      </>}
    </section>
  );
}

function LargePrintsPanel({ state, collapsed, onToggle }: { state: MarketState; collapsed: boolean; onToggle: () => void }) {
  const result = useMemo(() => detectLargeTrades(state.trades, state.market.key === "BTC" || state.market.key === "BTCPERP" ? 75_000 : 25_000), [state.trades, state.market.key]);
  return (
    <section className={`vf-panel ${collapsed ? "vf-collapsed" : ""}`}>
      <header onDoubleClick={onToggle}>
        <div><small>STATISTICAL OUTLIERS</small><h2>Large Prints</h2></div>
        <span className="vf-threshold">≥ {formatNotional(result.threshold)}</span>
        <button type="button" onClick={onToggle}>{collapsed ? "+" : "−"}</button>
      </header>
      {!collapsed && <div className="vf-print-list">
        {!result.events.length && <div className="vf-empty">No statistically unusual prints in the current sample. Quiet tape is allowed to be quiet.</div>}
        {result.events.slice(0, 25).map((item) => (
          <div className={`vf-print vf-${item.side}`} key={item.id}>
            <span className="vf-side"><i />{item.side.toUpperCase()}</span>
            <span>{formatTime(item.time, true)}</span>
            <span>{formatPrice(item.price, state.market.priceDecimals)}</span>
            <strong>{formatNotional(item.notional)}</strong>
            <small>{item.count > 1 ? `${item.count} trades · ` : ""}z {item.zScore.toFixed(1)}</small>
          </div>
        ))}
      </div>}
    </section>
  );
}

function TapePanel({ state, collapsed, onToggle }: { state: MarketState; collapsed: boolean; onToggle: () => void }) {
  return (
    <section className={`vf-panel ${collapsed ? "vf-collapsed" : ""}`}>
      <header onDoubleClick={onToggle}>
        <div><small>AGGRESSOR-CLASSIFIED</small><h2>Time & Sales</h2></div>
        <span className="vf-count">{state.trades.length}</span>
        <button type="button" onClick={onToggle}>{collapsed ? "+" : "−"}</button>
      </header>
      {!collapsed && <>
        <div className="vf-tape-head"><span>Time</span><span>Price</span><span>Size</span></div>
        <div className="vf-tape-list">
          {state.trades.slice(-120).reverse().map((trade) => (
            <div className={`vf-tape-row vf-${trade.side}`} key={trade.id}>
              <span>{formatTime(trade.exchangeTime, true)}</span><span>{formatPrice(trade.price, state.market.priceDecimals)}</span><span>{formatCompact(trade.size, 4)}</span>
            </div>
          ))}
          {!state.trades.length && <div className="vf-empty">Waiting for trade events…</div>}
        </div>
      </>}
    </section>
  );
}

function ReplayBar({ engine }: { engine: ReturnType<typeof useMarketEngine> }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const active = engine.replay.mode === "events";
  return (
    <div className={`vf-replaybar ${active ? "vf-active" : ""}`}>
      <div className="vf-replay-title"><b>{active ? "EVENT REPLAY" : "SESSION RECORDER"}</b><small>{active ? `${engine.replay.events.length.toLocaleString()} normalized events` : "Recording candles, trades, footprints, books and metrics"}</small></div>
      {!active ? <button type="button" onClick={engine.enterReplay}>Open Replay</button> : <>
        <button type="button" onClick={engine.toggleReplay}>{engine.replay.playing ? "Pause" : "Play"}</button>
        <button type="button" onClick={() => engine.setReplayCursor(Math.max(0, engine.replay.cursor - 1))}>Step −</button>
        <button type="button" onClick={() => engine.setReplayCursor(Math.min(engine.replay.events.length - 1, engine.replay.cursor + 1))}>Step +</button>
        <input aria-label="Replay event cursor" type="range" min="0" max={Math.max(0, engine.replay.events.length - 1)} value={engine.replay.cursor} onChange={(event: ChangeEvent<HTMLInputElement>) => engine.setReplayCursor(Number(event.target.value))} />
        <select aria-label="Replay speed" value={engine.replay.speed} onChange={(event: ChangeEvent<HTMLSelectElement>) => engine.setReplaySpeed(Number(event.target.value))}><option value="0.5">0.5×</option><option value="1">1×</option><option value="2">2×</option><option value="5">5×</option><option value="10">10×</option></select>
        <span>{engine.replay.cursor + 1} / {engine.replay.events.length}</span>
        <button type="button" className="vf-close-replay" onClick={engine.exitReplay}>Return Live</button>
      </>}
      <button type="button" onClick={engine.exportReplay}>Export</button>
      <button type="button" onClick={() => inputRef.current?.click()}>Import</button>
      <input ref={inputRef} hidden type="file" accept="application/json,.json" onChange={(event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (file) void engine.importReplay(file); event.currentTarget.value = ""; }} />
    </div>
  );
}

function SettingsDrawer({ settings, setSettings, onClose }: { settings: Settings; setSettings: (value: Settings | ((current: Settings) => Settings)) => void; onClose: () => void }) {
  const toggle = (key: BooleanSetting) => setSettings((current) => ({ ...current, [key]: !current[key] }));
  return <div className="vf-drawer-backdrop" onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => event.target === event.currentTarget && onClose()}>
    <aside className="vf-settings-drawer">
      <header><div><small>WORKSPACE</small><h2>Display & Footprint</h2></div><button type="button" onClick={onClose}>×</button></header>
      {([
        ["showGrid", "Chart grid", "Reference lines for price and time"],
        ["showVolume", "Volume profile strip", "Per-candle base volume"],
        ["showVwap", "Session VWAP", "UTC-session anchored; independent of zoom"],
        ["showDepth", "Depth heatmap", "Synchronized live book only"],
        ["showLargeTrades", "Large trade markers", "Statistical outliers; no forced events"],
        ["showFootprintDelta", "Footprint candle delta", "Show ask-minus-bid volume under each footprint"],
        ["autoFollow", "Auto follow", "Keep latest bar in view while live"],
      ] as const).map(([key, label, detail]) => <button className="vf-setting-row" type="button" key={key} onClick={() => toggle(key)}><span><b>{label}</b><small>{detail}</small></span><i className={settings[key] ? "vf-on" : ""}><span /></i></button>)}
      <div className="vf-density"><span><b>Footprint row grouping</b><small>Minimum exchange ticks per displayed row; chart may group further when zoomed out</small></span><select value={settings.footprintTicksPerRow} onChange={(event: ChangeEvent<HTMLSelectElement>) => setSettings((current) => ({ ...current, footprintTicksPerRow: Number(event.target.value) }))}><option value="1">1 tick</option><option value="5">5 ticks</option><option value="10">10 ticks</option><option value="25">25 ticks</option><option value="50">50 ticks</option></select></div>
      <div className="vf-density"><span><b>Diagonal imbalance</b><small>Ask versus bid one row lower; bid versus ask one row higher</small></span><select value={settings.footprintImbalanceRatio} onChange={(event: ChangeEvent<HTMLSelectElement>) => setSettings((current) => ({ ...current, footprintImbalanceRatio: Number(event.target.value) }))}><option value="2">200%</option><option value="3">300%</option><option value="4">400%</option><option value="5">500%</option></select></div>
      <div className="vf-density"><span><b>Minimum imbalance volume</b><small>Suppress ratios caused by tiny prints</small></span><select value={settings.footprintMinVolume} onChange={(event: ChangeEvent<HTMLSelectElement>) => setSettings((current) => ({ ...current, footprintMinVolume: Number(event.target.value) }))}><option value="0">No minimum</option><option value="0.01">0.01</option><option value="0.05">0.05</option><option value="0.1">0.10</option><option value="0.5">0.50</option><option value="1">1.00</option></select></div>
      <div className="vf-density"><span><b>Information density</b><small>Choose row height and spacing</small></span><select value={settings.density} onChange={(event: ChangeEvent<HTMLSelectElement>) => setSettings((current) => ({ ...current, density: event.target.value as Settings["density"] }))}><option value="compact">Compact</option><option value="comfortable">Comfortable</option></select></div>
      <div className="vf-disclaimer"><b>FOOTPRINT INTEGRITY</b><p>FULL candles reconcile contiguous price-level trades to candle volume. PARTIAL is the current or first observed candle. AGG means only OHLCV totals exist. GAP means a sequence or reconciliation failure was detected.</p></div>
      <button className="vf-reset" type="button" onClick={() => setSettings(DEFAULT_SETTINGS)}>Reset workspace settings</button>
    </aside>
  </div>;
}

export default function WorldclassApp() {
  const engine = useMarketEngine();
  const [mode, setMode] = useStoredState<ChartMode>("vf-chart-mode", "candles");
  const [settings, setSettings] = useStoredState<Settings>("vf-settings-v5", DEFAULT_SETTINGS);
  const [sidebarWidth, setSidebarWidth] = useStoredState<number>("vf-sidebar-width", 360);
  const [collapsed, setCollapsed] = useStoredState<Record<string, boolean>>("vf-panels", { book: false, prints: false, tape: false });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fps, setFps] = useState(0);
  const resizeRef = useRef<{ x: number; width: number } | null>(null);

  const marketChange = (event: ChangeEvent<HTMLSelectElement>) => engine.setMarket(event.target.value as MarketKey);
  const timeframeChange = (event: ChangeEvent<HTMLSelectElement>) => engine.setTimeframe(event.target.value as Timeframe);
  const togglePanel = (panel: string) => setCollapsed((current) => ({ ...current, [panel]: !current[panel] }));

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!resizeRef.current) return;
      const delta = resizeRef.current.x - event.clientX;
      setSidebarWidth(Math.max(290, Math.min(520, resizeRef.current.width + delta)));
    };
    const onUp = () => { resizeRef.current = null; document.body.classList.remove("vf-resizing"); };
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp);
    return () => { window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
  }, [setSidebarWidth]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.matches("input,select,textarea")) return;
      if (event.key.toLowerCase() === "r") engine.replay.mode === "live" ? engine.enterReplay() : engine.exitReplay();
      if (event.code === "Space" && engine.replay.mode === "events") { event.preventDefault(); engine.toggleReplay(); }
      if (event.key === "1") setMode("candles");
      if (event.key === "2") setMode("footprint");
      if (event.key === "3") setMode("delta");
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [engine, setMode]);

  const price = engine.state.metrics.markPrice ?? engine.state.candles.at(-1)?.close;
  const first = engine.state.candles[0]?.open;
  const change = price !== undefined && first ? (price - first) / first * 100 : undefined;
  const replayActive = engine.replay.mode === "events";
  const rootStyle = { "--vf-sidebar": `${sidebarWidth}px` } as CSSProperties;
  const footprintQuality = footprintDataQuality(engine.state.footprintCoverage.quality);
  const fullFootprints = engine.state.footprints.filter((item) => item.quality === "full" || item.quality === "replay-full").length;

  return (
    <div className={`vf-app vf-density-${settings.density} ${replayActive ? "vf-replay-mode" : ""}`} style={rootStyle}>
      <header className="vf-topbar">
        <div className="vf-brand"><span>V</span><div><b>VEILFLOW</b><small>ORDER FLOW INTELLIGENCE</small></div></div>
        <nav><button className="vf-active">Workspace</button><button onClick={engine.enterReplay}>Replay</button></nav>
        <div className="vf-top-actions">
          <ConnectionChip state={engine.liveState} />
          <button type="button" onClick={engine.refresh} title="Reconnect and refresh">↻</button>
          <button type="button" onClick={() => setSettingsOpen(true)} title="Settings">⚙</button>
        </div>
      </header>

      <div className="vf-controlbar">
        <select aria-label="Market" value={engine.liveState.market.key} onChange={marketChange}>{Object.values(MARKETS).map((market) => <option key={market.key} value={market.key}>{market.shortName} · {market.venue}</option>)}</select>
        <select aria-label="Timeframe" value={engine.liveState.timeframe} onChange={timeframeChange}>{TIMEFRAMES.map((item) => <option key={item}>{item}</option>)}</select>
        <span className="vf-separator" />
        <div className="vf-mode-tabs">{(["candles", "footprint", "delta"] as ChartMode[]).map((item, index) => <button key={item} className={mode === item ? "vf-active" : ""} onClick={() => setMode(item)}>{index + 1} · {item}</button>)}</div>
        <span className="vf-separator" />
        <div className="vf-quality-strip"><QualityBadge quality={engine.state.market.quality} text={marketProductText(engine.state)} /><QualityBadge quality={footprintQuality} text={`FP ${engine.state.footprintCoverage.quality.toUpperCase()}`} /><QualityBadge quality={engine.state.analytics.dataQuality} text={`CVD ${engine.state.analytics.dataQuality.toUpperCase()}`} /><QualityBadge quality={engine.state.book?.quality ?? "unavailable"} text={`BOOK ${(engine.state.book?.quality ?? "OFF").toUpperCase()}`} /></div>
        <span className="vf-source">{engine.state.market.disclosure}</span>
      </div>

      <ReplayBar engine={engine} />

      <main className="vf-workspace">
        <section className="vf-chart-column">
          <header className="vf-market-header">
            <div><small>{engine.state.market.venue} · {engine.state.market.productType.toUpperCase()}</small><h1>{engine.state.market.displayName}</h1></div>
            <div className="vf-price"><strong>{formatPrice(price, engine.state.market.priceDecimals)}</strong><span className={change !== undefined && change >= 0 ? "vf-positive" : "vf-negative"}>{change === undefined ? "—" : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}</span></div>
            <div className="vf-market-meta"><span>Mark<b>{formatPrice(engine.state.metrics.markPrice, engine.state.market.priceDecimals)}</b></span><span>Index/Oracle<b>{formatPrice(engine.state.metrics.oraclePrice, engine.state.market.priceDecimals)}</b></span><span>Funding<b>{engine.state.metrics.fundingRate === undefined ? "—" : `${(engine.state.metrics.fundingRate * 100).toFixed(4)}%`}</b></span><span>OI<b>{formatCompact(engine.state.metrics.openInterest)}</b></span><span>24h volume<b>{formatCompact(engine.state.metrics.dayVolume)} {engine.state.metrics.dayVolumeUnit === "base" ? engine.state.market.quantityUnit : "USD"}</b></span></div>
          </header>
          <MarketChart state={engine.state} mode={mode} settings={settings} replayActive={replayActive} onFps={setFps} />
          <div className="vf-metrics">
            <MetricCard label="Footprint Coverage" value={`${fullFootprints} full`} detail={`${engine.state.footprintCoverage.eventCount.toLocaleString()} price-level trade events · ${engine.state.footprintCoverage.detail}`} tone={engine.state.footprintCoverage.quality === "gapped" ? "warning" : undefined} />
            <MetricCard label="Session VWAP" value={formatPrice(engine.state.analytics.sessionVwap, engine.state.market.priceDecimals)} detail="UTC session · zoom invariant" />
            <MetricCard label="Session CVD" value={formatCompact(engine.state.analytics.sessionCvd, 2)} detail={engine.state.analytics.dataQuality === "live-only" ? "Live-complete; historical aggressor split unavailable" : "Aggressor volume since UTC session open"} tone={(engine.state.analytics.sessionCvd ?? 0) >= 0 ? "positive" : "negative"} />
            <MetricCard label="Rolling Delta" value={formatCompact(engine.state.analytics.rollingDelta, 2)} detail="Last 200 candles" tone={(engine.state.analytics.rollingDelta ?? 0) >= 0 ? "positive" : "negative"} />
            <MetricCard label="Weighted Imbalance" value={engine.state.analytics.weightedImbalance === undefined ? "—" : `${(engine.state.analytics.weightedImbalance * 100).toFixed(1)}%`} detail="Distance-weighted top 20 levels" tone={(engine.state.analytics.weightedImbalance ?? 0) >= 0 ? "positive" : "negative"} />
            <MetricCard label="Spread / Feed" value={formatPrice(engine.state.analytics.spread, engine.state.market.priceDecimals)} detail={`${formatPrice(engine.state.analytics.spreadBps, 2)} bps · ${engine.state.eventLagMs.toFixed(0)}ms · ${engine.state.eventRate}/s · ${fps} FPS`} tone={engine.state.eventLagMs > 2000 ? "warning" : undefined} />
          </div>
        </section>

        <div className="vf-resize-handle" onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => { resizeRef.current = { x: event.clientX, width: sidebarWidth }; document.body.classList.add("vf-resizing"); }} />
        <aside className="vf-sidebar">
          <OrderBookPanel state={engine.state} collapsed={Boolean(collapsed.book)} onToggle={() => togglePanel("book")} />
          <LargePrintsPanel state={engine.state} collapsed={Boolean(collapsed.prints)} onToggle={() => togglePanel("prints")} />
          <TapePanel state={engine.state} collapsed={Boolean(collapsed.tape)} onToggle={() => togglePanel("tape")} />
        </aside>
      </main>

      <footer className="vf-statusbar"><span><i className={`vf-status-${engine.state.status}`} />{engine.state.statusDetail}</span><span>Exchange time {engine.state.lastEventAt ? formatTime(engine.state.lastEventAt, true) : "—"}</span><span>Footprint {engine.state.footprintCoverage.quality}</span><span>Events {engine.state.eventRate}/s</span><span>Lag {engine.state.eventLagMs.toFixed(0)}ms</span><span>Renderer {fps} FPS</span><span>Shortcuts: 1/2/3 chart · R replay · Space play/pause</span></footer>
      {settingsOpen && <SettingsDrawer settings={settings} setSettings={setSettings} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
