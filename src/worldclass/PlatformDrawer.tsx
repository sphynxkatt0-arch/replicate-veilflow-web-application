import { useEffect, useMemo, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from "react";
import { METHODOLOGY, VENUES, canonicalQuality, reconcileFootprint } from "./platform";
import type { EngineApi } from "./useMarketEngine";

interface BuildMetadata {
  gitSha?: string;
  gitRef?: string;
  builtAt?: string;
  environment?: string;
  deploymentId?: string;
}

function formatTime(value?: number | string): string {
  if (value === undefined) return "—";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function BuildCard() {
  const [metadata, setMetadata] = useState<BuildMetadata>({});
  useEffect(() => {
    const controller = new AbortController();
    fetch("/build-meta.json", { signal: controller.signal, cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<BuildMetadata> : Promise.reject(new Error(String(response.status))))
      .then(setMetadata)
      .catch(() => setMetadata({ environment: "metadata unavailable" }));
    return () => controller.abort();
  }, []);
  return <section className="vf-platform-card" aria-labelledby="vf-build-title">
    <header><div><small>IMMUTABLE RELEASE</small><h3 id="vf-build-title">Build identity</h3></div><span className="vf-platform-state">{metadata.environment ?? "loading"}</span></header>
    <dl className="vf-platform-grid">
      <div><dt>Git SHA</dt><dd title={metadata.gitSha}>{metadata.gitSha?.slice(0, 12) ?? "—"}</dd></div>
      <div><dt>Git ref</dt><dd>{metadata.gitRef ?? "—"}</dd></div>
      <div><dt>Build time</dt><dd>{formatTime(metadata.builtAt)}</dd></div>
      <div><dt>Deployment</dt><dd title={metadata.deploymentId}>{metadata.deploymentId?.slice(0, 18) ?? "—"}</dd></div>
    </dl>
  </section>;
}

function ProvenanceCard({ engine }: { engine: EngineApi }) {
  const state = engine.state;
  const quality = canonicalQuality(state.footprintCoverage.quality, engine.replay.mode === "events");
  const age = state.lastEventAt ? Math.max(0, Date.now() - state.lastEventAt) : undefined;
  return <section className="vf-platform-card" aria-labelledby="vf-provenance-title">
    <header><div><small>DATA HONESTY</small><h3 id="vf-provenance-title">Active provenance</h3></div><span className={`vf-platform-state vf-platform-${quality.toLowerCase().replaceAll(" ", "-")}`}>{quality}</span></header>
    <dl className="vf-platform-grid">
      <div><dt>Venue</dt><dd>{state.market.venue}</dd></div>
      <div><dt>Product</dt><dd>{state.market.productType}</dd></div>
      <div><dt>Symbol</dt><dd>{state.market.displayName}</dd></div>
      <div><dt>Venue symbol</dt><dd>{state.market.providerSymbol}</dd></div>
      <div><dt>Source timestamp</dt><dd>{formatTime(state.lastEventAt)}</dd></div>
      <div><dt>Local age</dt><dd>{age === undefined ? "—" : `${age.toLocaleString()} ms`}</dd></div>
      <div><dt>Footprint source</dt><dd>{state.footprintCoverage.source}</dd></div>
      <div><dt>Completeness</dt><dd>{state.footprintCoverage.contiguous ? "contiguous" : "gapped"}</dd></div>
    </dl>
    <p className="vf-platform-detail">{state.market.disclosure}</p>
  </section>;
}

function ReconciliationCard({ engine }: { engine: EngineApi }) {
  const rows = useMemo(() => engine.state.footprints.slice(-20).map((footprint) => {
    const candle = engine.state.candles.find((item) => item.time === footprint.time);
    const result = reconcileFootprint(footprint, candle?.volume ?? 0);
    return { footprint, result };
  }).reverse(), [engine.state.candles, engine.state.footprints]);
  const passing = rows.filter((row) => row.result.passed).length;
  return <section className="vf-platform-card" aria-labelledby="vf-reconciliation-title">
    <header><div><small>FOOTPRINT AUDIT</small><h3 id="vf-reconciliation-title">Candle reconciliation</h3></div><span className="vf-platform-state">{passing}/{rows.length} pass</span></header>
    <div className="vf-reconciliation-table" role="table" aria-label="Footprint reconciliation results">
      <div className="vf-reconciliation-head" role="row"><span>Time</span><span>Derived</span><span>Source</span><span>Ratio</span><span>State</span></div>
      {rows.map(({ footprint, result }) => <div className="vf-reconciliation-row" role="row" key={footprint.time}>
        <span>{new Date(footprint.time).toLocaleTimeString()}</span>
        <span>{result.derivedVolume.toFixed(4)}</span>
        <span>{result.sourceVolume.toFixed(4)}</span>
        <span>{result.ratio === undefined ? "—" : `${(result.ratio * 100).toFixed(2)}%`}</span>
        <span className={result.passed ? "vf-positive" : "vf-negative"}>{result.passed ? "PASS" : footprint.quality.toUpperCase()}</span>
      </div>)}
      {!rows.length && <div className="vf-empty">No footprint candles available for reconciliation.</div>}
    </div>
  </section>;
}

function SessionsCard({ engine }: { engine: EngineApi }) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try { await engine.saveSession(name || undefined); setName(""); setMessage("Session stored with integrity hashes."); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };
  return <section className="vf-platform-card" aria-labelledby="vf-sessions-title">
    <header><div><small>DURABLE BROWSER CATALOGUE</small><h3 id="vf-sessions-title">Replay sessions</h3></div><span className="vf-platform-state">{engine.sessions.length}</span></header>
    <form className="vf-session-save" onSubmit={submit}>
      <label><span>Session name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="BTC opening session" /></label>
      <button type="submit">Save current</button>
    </form>
    {message && <p className="vf-platform-detail" role="status">{message}</p>}
    <div className="vf-session-list">
      {engine.sessions.map((session) => <article key={session.id}>
        <div><b>{session.name}</b><small>{session.venue} · {session.productType} · {session.timeframe} · {session.eventCount.toLocaleString()} events</small><small>{formatTime(session.updatedAt)} · {session.eventHash.slice(-12)}</small></div>
        <button type="button" onClick={() => void engine.openSession(session.id).catch((error) => setMessage(error instanceof Error ? error.message : String(error)))}>Open</button>
        <button type="button" className="vf-danger" onClick={() => void engine.deleteSession(session.id)}>Delete</button>
      </article>)}
      {!engine.sessions.length && <div className="vf-empty">No stored sessions yet. Live capture autosaves every five seconds.</div>}
    </div>
  </section>;
}

function TelemetryCard({ engine }: { engine: EngineApi }) {
  const summary = engine.telemetry.summary();
  return <section className="vf-platform-card" aria-labelledby="vf-telemetry-title">
    <header><div><small>PRODUCTION EVIDENCE</small><h3 id="vf-telemetry-title">Runtime telemetry</h3></div><span className="vf-platform-state">{summary.eventCount} events</span></header>
    <dl className="vf-platform-grid">
      <div><dt>Errors</dt><dd>{summary.errorCount}</dd></div>
      <div><dt>Reconnects</dt><dd>{summary.reconnectCount}</dd></div>
      <div><dt>Sequence gaps</dt><dd>{summary.gapCount}</dd></div>
      <div><dt>Stale duration</dt><dd>{summary.staleDurationMs.toLocaleString()} ms</dd></div>
      <div><dt>Average FPS</dt><dd>{summary.averageFps?.toFixed(1) ?? "—"}</dd></div>
      <div><dt>P95 replay seek</dt><dd>{summary.p95ReplaySeekMs?.toFixed(1) ?? "—"} ms</dd></div>
      <div><dt>Longest task</dt><dd>{summary.maxLongTaskMs?.toFixed(1) ?? "—"} ms</dd></div>
    </dl>
  </section>;
}

function MethodologyCard() {
  return <section className="vf-platform-card" aria-labelledby="vf-methodology-title">
    <header><div><small>VERSIONED CALCULATIONS</small><h3 id="vf-methodology-title">Methodology registry</h3></div><span className="vf-platform-state">{METHODOLOGY.length}</span></header>
    <div className="vf-methodology-list">
      {METHODOLOGY.map((item) => <details key={item.id}>
        <summary><span><b>{item.title}</b><small>{item.id} · v{item.version}</small></span><i>+</i></summary>
        <p><strong>Method:</strong> {item.formula}</p>
        <p><strong>Inputs:</strong> {item.inputs.join(", ")}</p>
        <p><strong>Limitations:</strong> {item.limitations}</p>
      </details>)}
    </div>
  </section>;
}

function VenueCard() {
  return <section className="vf-platform-card" aria-labelledby="vf-venues-title">
    <header><div><small>NORMALIZED COVERAGE</small><h3 id="vf-venues-title">Venue capability registry</h3></div><span className="vf-platform-state">{VENUES.length} venues</span></header>
    <div className="vf-venue-list">
      {VENUES.map((venue) => <article key={venue.id}>
        <div><b>{venue.name}</b><small>{venue.products.join(" · ")}</small></div>
        <span>{venue.trades ? "TRADES" : "—"}</span><span>{venue.depth ? "DEPTH" : "—"}</span><span>{venue.funding ? "FUNDING" : "—"}</span><span>{venue.openInterest ? "OI" : "—"}</span><span>{venue.liquidations ? "LIQ" : "—"}</span>
        <p>{venue.disclosure}</p>
      </article>)}
    </div>
  </section>;
}

export function PlatformDrawer({ engine, onClose }: { engine: EngineApi; onClose: () => void }) {
  return <div className="vf-drawer-backdrop" onMouseDown={(event: ReactMouseEvent<HTMLDivElement>) => event.target === event.currentTarget && onClose()}>
    <aside className="vf-platform-drawer" role="dialog" aria-modal="true" aria-labelledby="vf-platform-title">
      <header><div><small>VEILFLOW PLATFORM CONTROL</small><h2 id="vf-platform-title">Trust, replay, and methodology</h2></div><button type="button" onClick={onClose} aria-label="Close platform inspector">×</button></header>
      <BuildCard />
      <ProvenanceCard engine={engine} />
      <ReconciliationCard engine={engine} />
      <SessionsCard engine={engine} />
      <TelemetryCard engine={engine} />
      <MethodologyCard />
      <VenueCard />
    </aside>
  </div>;
}
