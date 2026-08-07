# VeilFlow 10/10 Product Handoff

## Product claim

VeilFlow is an institutional-grade **crypto spot and perpetual market-microstructure platform**. It must never present a crypto perpetual, synthetic instrument, or proxy as CME or another regulated futures product. Authoritative CME coverage is outside the product claim unless licensed CME data is integrated and separately certified.

## Definition of 10/10

A score of 10/10 is an evidence state, not a design opinion. VeilFlow may use the 10/10 claim only after every category below passes its mandatory gates, no critical data-integrity or recovery issue remains open, a seven-day production observation period passes, and the same recorded session reproduces identical analytics on two independent machines.

Accepted evidence:

- automated test output;
- production telemetry;
- reproducible benchmarks;
- source-versus-derived reconciliation reports;
- visual QA captures;
- documented calculation methodology;
- verified fault-injection and recovery results.

A visually complete feature with incomplete, unauditable, or mislabeled data does not pass.

## Current architecture boundary

The current application contains a capable browser terminal, browser-side venue adapters, price-level footprints, local order-book sequencing, session analytics, and bounded in-memory replay. These are useful foundations, but they are not the target production architecture.

Target data path:

```text
Exchange WebSocket / REST
        ↓
Server-side venue adapters
        ↓
Normalizer + sequence validator + clock discipline
        ↓
Append-only durable event log
        ↓
Checkpoint / archive / historical APIs
        ↓
Regional real-time gateways
        ↓
Defensive VeilFlow browser clients
```

The browser remains responsible for display validation and user-facing quality states. It is not the sole source of capture, reconstruction, durability, or truth.

## Canonical data-quality state machine

Every data-bearing panel, candle, metric, export, and replay session uses one of these states:

| State | Meaning |
|---|---|
| `FULL` | Source events are contiguous and the derived result passes reconciliation. |
| `LIVE PARTIAL` | Live source events exist, but the beginning or end of the calculation window is incomplete. |
| `AGGREGATE ONLY` | Only aggregate OHLCV or equivalent summary data exists; price-level reconstruction is unavailable. |
| `GAPPED` | A sequence, time, reconciliation, or source-coverage gap affects the result. |
| `STALE` | The configured freshness threshold has been crossed. |
| `REPLAY FULL` | Replay was rebuilt from a validated archive whose required event classes and hashes pass. |
| `UNAVAILABLE` | The value cannot be calculated from available evidence. |

Quality may degrade automatically. It may improve only after the recovery or reconciliation criteria for the stronger state pass. A UI component may not override the engine state.

Every displayed metric exposes, directly or through an accessible provenance inspector:

- venue;
- product type;
- canonical symbol and venue symbol;
- exchange timestamp;
- local receive timestamp;
- current data age;
- quality state;
- calculation identifier and version;
- completeness and reconciliation result.

## Normalized event contract

Every normalized event must include:

```text
schemaVersion
venue
productType
instrumentId
venueSymbol
eventType
exchangeSequence (when supplied)
exchangeTimestamp
receiveTimestamp
ingestRegion
sourceConnectionId
sourceEventId / deduplication key
payload
normalizerVersion
```

Rules:

1. Event identity is deterministic from venue-native identifiers where available.
2. Duplicate source events are idempotent.
3. Out-of-order events are buffered only inside a documented bound.
4. A sequence gap changes affected outputs to `GAPPED` before recovery begins.
5. Recovery never silently overwrites evidence; gap, reconnect, and resynchronization events are retained.
6. Instrument metadata is versioned and effective-dated so tick-size or contract changes can be replayed correctly.

## Calculation governance

Every production analytic has:

- a stable calculation ID;
- a semantic version;
- a methodology page;
- units and sign convention;
- source-event requirements;
- session-boundary behavior;
- missing-data behavior;
- deterministic golden fixtures;
- a regression test that fails when output changes without an explicit version change.

Mandatory first-class calculations include bid/ask volume by price, row and candle delta, POC, value area, diagonal and stacked imbalance, zero prints, unfinished auctions, VWAP, anchored VWAP, CVD, volume and delta profiles, liquidity/spread regimes, basis, funding, open interest, liquidations, and venue contribution/divergence.

Display grouping, zoom, palette, text size, and other presentation transforms must not alter calculation inputs or results.

## Footprint reconciliation contract

For every closed footprint candle:

```text
priceLevelExecutedVolume = Σ(row.bidVolume + row.askVolume)
sourceExecutedVolume     = venue/source candle volume for the same product and interval
reconciliationRatio      = priceLevelExecutedVolume / sourceExecutedVolume
```

The configured tolerance is versioned per venue/product. A candle can be `FULL` only when coverage is contiguous and reconciliation passes. The current candle and the first partially observed candle remain `LIVE PARTIAL`. Any known sequence or coverage gap produces `GAPPED`, including in replay.

## Replay archive contract

Persistent archives must contain:

- archive and event schema versions;
- venue, product type, instrument metadata, and metadata version;
- start and end timestamps;
- ordered event count;
- complete event hash;
- checkpoint interval and checkpoint hashes;
- quality-transition, gap, reconnect, and metadata events;
- calculation-version manifest;
- analytics-output hash for certified golden sessions.

Replay must not assume `REPLAY FULL` merely because trades are present. It must reproduce the original quality timeline and reject archives whose hashes, event counts, time range, metadata, or required event classes do not validate.

## Category gates

### 1. Design and information density

Mandatory:

- multi-panel synchronized workspaces;
- tabbed/detachable layouts and cloud presets;
- corruption-safe restore and reset;
- keyboard-first navigation and visible focus;
- bid×ask, delta, total-volume, and profile footprint modes;
- automatic/manual row scaling and text scaling;
- POC, value area, diagonal/stacked imbalance, zero-print, and unfinished-auction controls;
- explicit zoom state when numbers cannot be rendered;
- color-blind and high-contrast palettes;
- usable desktop, laptop, tablet, and mobile fallbacks.

Pass evidence:

- visual QA at 1440p, 1080p, laptop, tablet, and mobile;
- complete primary workflow by keyboard;
- exact workspace restoration after reload;
- recorded high-volume session: target 60 FPS, never below 30 FPS, pan/zoom response below 100 ms, restore below two seconds, no normal-operation main-thread task above 200 ms.

### 2. Data honesty and labeling

Mandatory:

- canonical quality state machine everywhere;
- explicit venue/product/symbol/source/age/method/completeness;
- accessible methodology panel;
- candle-level footprint reconciliation;
- visible sequence-gap and stale transitions;
- unambiguous proxy and non-CME labels.

Pass evidence:

- no incomplete footprint is shown as complete;
- formulas are reachable from every major analytic;
- closed full-quality candles reconcile inside tolerance;
- stale state is visible within one second after its threshold is crossed.

### 3. Market-data engine

Mandatory server capabilities:

- Binance Spot, Binance USDⓈ-M, and Hyperliquid adapters first;
- snapshot/diff synchronization;
- sequence validation and deduplication;
- bounded out-of-order handling;
- automatic gap backfill and resynchronization;
- reconnect backoff, heartbeat, and stale detection;
- exchange-versus-receive timestamps;
- regional relays, batching, and compression;
- versioned instrument metadata and lifecycle handling.

Pass evidence:

- disconnect, duplicate, reorder, missing-event, and stale fault-injection suites pass;
- synchronized books do not remain crossed;
- zero-quantity levels are removed;
- browser refresh does not erase server sessions;
- two clients receive equivalent normalized sequences;
- per-venue/instrument feed and recovery telemetry exists;
- seven days contain no silent corruption incident.

### 4. Analytics foundation

Mandatory:

- golden datasets for trades, aggressor side, candle boundaries, book snapshots/updates, duplicates, gaps, reordering, session reset, POC, and value area;
- property tests for volume conservation, regrouping conservation, live/replay equivalence, duplicate idempotency, display invariance, timeframe determinism, and session scope;
- versioned expected outputs in the repository.

Pass evidence:

- independent validation for each major calculation;
- live and replay outputs match for the same validated event stream;
- silent formula changes are blocked by regression tests.

### 5. Replay

Mandatory:

- durable session storage and catalogue;
- indexed timelines and periodic state checkpoints;
- compressed archives;
- deterministic server-side replay;
- play, pause, speed, event/trade/candle/time stepping, timestamp seek, event jumps, return-live, bookmarks, notes, import, and export;
- persistence of trades, book state, candles, funding, OI, liquidations, gaps, reconnects, quality transitions, and metadata.

Pass evidence:

- full high-volume day reopens later;
- checkpoint seek completes below one second;
- original live output and replay output match;
- two machines produce identical analytics;
- imported/exported hashes validate;
- book, footprint, tape, and analytics remain synchronized.

### 6. Production reliability

Mandatory:

- GitHub-connected Vercel deployment;
- immutable commit/deployment identity;
- protected-branch checks and PR previews;
- healthy-alias protection and tested rollback;
- build metadata endpoint and visible Git SHA/build time;
- no runtime CDN dependency for application code;
- TypeScript, unit, golden, reconciliation, sequence, production build, browser smoke, bundle, and vulnerability gates;
- browser/feed/replay/performance telemetry;
- repeated synthetic workflow from page load through return-to-live.

Pass evidence:

- 99.95% production availability;
- deployment success above 99%;
- MTTR below 15 minutes;
- rollback below five minutes;
- error-free browser sessions above 99.5%;
- seven continuous incident-free days;
- a failed deployment cannot replace the healthy production alias.

### 7. Institutional-grade crypto coverage

Mandatory:

- complete Binance Spot and USDⓈ-M trades/depth plus mark, index, funding, OI, liquidations, aggregate trades, and candles;
- normalized coverage from at least three major venues, expanding through Coinbase, Bybit, OKX, Hyperliquid, and Deribit;
- consolidated/venue CVD, market share, spread, basis, liquidity fragmentation, divergence, liquidation clusters, funding, and OI regimes;
- sufficient normalized retention for historical footprints, full-day replay, multi-session research, backtesting, and Parquet/CSV export;
- documented permissions, retention, schemas, missing-data treatment, clock discipline, corrections, outages, and limitations.

Pass evidence:

- three major venues have normalized trades and depth;
- historical footprints load without prior live observation;
- multi-day sessions are searchable;
- cross-venue calculations reproduce;
- outages and missing coverage remain explicit;
- source events export for independent validation.

## Delivery sequence

### Phase 1 — reliability and truth

1. Build identity and release provenance.
2. Production/browser/feed observability.
3. Synthetic browser workflow.
4. Canonical quality state machine and quality timeline.
5. Calculation registry and methodology UI.
6. Golden datasets and deterministic regression tests.
7. Footprint reconciliation dashboard.
8. Replay archive integrity manifest and corruption rejection.

Phase 1 does **not** make the product 10/10. It establishes reliable evidence and prevents false completeness claims.

### Phase 2 — durable capture and replay

1. Server-side Binance collectors.
2. Normalizer, sequence validator, and append-only event log.
3. Historical footprint API.
4. Persistent replay catalogue.
5. Checkpoints and indexed seek.
6. Import/export and analytics hashes.
7. Regional gateway and recovery telemetry.

### Phase 3 — multi-venue institutional platform

1. Coinbase, Bybit, OKX, Deribit, and production Hyperliquid adapters.
2. Consolidated tape and venue contribution.
3. Cross-venue CVD, basis, funding, OI, liquidation, and liquidity analytics.
4. Cloud workspaces and alerts.
5. Accessibility and performance certification.
6. Seven-day final reliability observation.

## Mandatory release gates

The 10/10 claim remains blocked until all are true:

- production maps to an identifiable Git commit;
- every required test and synthetic workflow passes;
- Binance Spot and Perpetual footprints contain complete price-level data;
- historical footprint sessions are available;
- replay is persistent, indexed, deterministic, and hash-validated;
- sequence gaps cannot remain silent;
- analytics pass versioned golden datasets;
- quality is visible per candle and feed;
- at least three venues are normalized;
- browser, feed, replay, and performance failures are observable;
- the seven-day observation period passes without a critical incident.

## Professional-trader definition of done

A professional trader can open a supported historical session, inspect bid×ask volume at every price, verify full/partial/stale/gapped state, replay deterministically, compare spot and perpetual flow across venues, reproduce each analytic independently, restore a workspace, survive ordinary feed failures, verify the tested Git build, and export source data for external validation.
