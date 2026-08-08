# VeilFlow Collector

This service moves authoritative capture, normalization, sequence validation, replay storage, and historical reconstruction out of the browser.

## Services

- `runtime.mjs`: long-running venue collector with deduplication, bounded out-of-order handling, sequence-gap detection, exponential reconnect, stale detection, quality transitions, periodic checkpoints, and append-only event storage.
- `binanceArchive.mjs`: checksum-verified Binance Public Data ZIP/CSV ingestion for Spot and USDⓈ-M `aggTrades`, including Spot microsecond timestamp normalization.
- `history.mjs`: archive-first historical Binance ingestion over explicit time ranges, with REST pagination used only to bridge current-day or unavailable archive ranges before durable normalized session output.
- `footprints.mjs`: canonical server-side Bid×Ask footprint aggregation with trade counts, delta, max/min delta, POC, value area, diagonal/stacked imbalance, quality, sequence boundaries, and deterministic hashes.
- `footprintStore.mjs`: immutable completed-range footprint cache keyed by event hash, timeframe, tick size, requested range, and calculation parameters.
- `api.mjs`: session catalogue, integrity verification, paged normalized events, range-based historical footprints, coverage/sequence metadata, cache HIT/MISS state, and CSV export.
- `gateway.mjs`: regional Server-Sent Events relay. Clients reconnect with a cursor and receive the same normalized sequence.
- `adapters.mjs`: Binance Spot/USDⓈ-M, Coinbase, Bybit, OKX, Hyperliquid, and Deribit normalized adapters.
- `core.mjs`: versioned normalized event contract, local-book normalization, deterministic hashing, sequence validation, durable NDJSON event log, checkpoints, and integrity verification.

## Run

Node.js 22 or newer is required because the collector uses the built-in WebSocket client.

```bash
VEILFLOW_VENUE=binance \
VEILFLOW_VENUE_SYMBOL=BTCUSDT \
VEILFLOW_SYMBOL=BTC/USDT \
VEILFLOW_PRODUCT_TYPE=spot \
VEILFLOW_DATA_DIR=.veilflow-data \
node services/collector/runtime.mjs
```

In separate processes:

```bash
VEILFLOW_DATA_DIR=.veilflow-data node services/collector/api.mjs
PORT=8790 VEILFLOW_DATA_DIR=.veilflow-data node services/collector/gateway.mjs
```

Or start the reference multi-service deployment:

```bash
docker compose -f services/collector/compose.yaml up --build
```

## Historical Binance execution backfill

The browser must not be responsible for reconstructing deep historical footprints from millions of executions. Seed the durable collector store first, then serve completed or incrementally updated footprints from the collector API.

By default this command ingests the latest 24 hours of `BTCUSDT` Spot aggregate trades:

```bash
VEILFLOW_DATA_DIR=.veilflow-data npm run collector:backfill
```

Use an explicit historical range when required:

```bash
VEILFLOW_VENUE_SYMBOL=BTCUSDT \
VEILFLOW_SYMBOL=BTC/USDT \
VEILFLOW_PRODUCT_TYPE=perpetual \
VEILFLOW_START_TIME=2026-08-08T00:00:00Z \
VEILFLOW_END_TIME=2026-08-09T00:00:00Z \
VEILFLOW_DATA_DIR=.veilflow-data \
npm run collector:backfill
```

`VEILFLOW_START_TIME` and `VEILFLOW_END_TIME` accept ISO timestamps or Unix milliseconds.

The ingestion order is:

```text
Binance Public Data daily aggTrades ZIP
  -> SHA-256 .CHECKSUM verification
  -> ZIP/CSV decode + timestamp normalization
  -> missing/current-day ranges only
  -> Binance REST aggTrades bridge
  -> sequence continuity validation
  -> normalized append-only session
```

Archive data is never accepted when its companion checksum fails. Missing archive ranges are explicit and are bridged through REST in bounded time windows with `fromId` pagination. Aggregate-trade IDs are deduplicated after archive/REST stitching. Any missing sequence range becomes an explicit `GAPPED` quality transition; the importer never fabricates execution history.

The resulting completed session is immediately available through the same `/sessions/:id/...` API used by replay and footprint reconstruction.

## API

- `GET /health`
- `GET /sessions`
- `GET /sessions/:id/manifest`
- `GET /sessions/:id/events?start=0&limit=10000`
- `GET /sessions/:id/footprints?timeframe=5m&tickSize=0.1&startTime=<ms>&endTime=<ms>`
- `GET /sessions/:id/verify`
- `GET /sessions/:id/export.csv`

The footprint response includes canonical quality, requested/available time coverage, first/last execution sequence, event count, deterministic output hash, completed footprints, and cache state. Completed immutable sessions are cached; mutable sessions bypass that cache.

The gateway exposes `GET /stream/:sessionId?cursor=0` using Server-Sent Events.

## Browser integration

The VeilFlow browser now prefers the collector for Binance historical footprints. Configure the API base URL at build time:

```bash
VITE_VEILFLOW_COLLECTOR_API=https://collector.example.com npm run build
```

For local development, start the API on port `8787` and run:

```bash
VITE_VEILFLOW_COLLECTOR_API=http://127.0.0.1:8787 npm run dev
```

A developer can also set the temporary browser override:

```js
localStorage.setItem("vf-collector-api", "http://127.0.0.1:8787");
location.reload();
```

When a matching completed collector session exists, the terminal downloads **precomputed footprint candles instead of historical raw executions**. Live WebSocket executions are stitched onto those server footprints. The collector response exposes the last historical Binance aggregate-trade sequence, and the live stream uses it to reject boundary duplicates and flag any historical→live sequence gap.

If no collector URL/session is available, the existing bounded browser REST backfill remains as a degraded fallback. That fallback is intentionally not treated as equivalent to deep historical coverage.

## Storage contract

Each session contains:

```text
sessions/<session-id>/
  manifest.json
  events.ndjson
  footprints/
    <event+range+calculation hash>.json
  checkpoints/
    000000004999.json
    000000009999.json
```

`manifest.json` records schema versions, venue, instrument, product type, event count, event hash, checkpoint count, analytics hash, manifest hash, and archive provenance when applicable. Writes use temporary files and atomic rename. Event appends are flushed with `fsync` before the manifest is advanced.

For clustered production, mount a durable replicated volume or replace `FileEventLog` behind the same contract with an object-store/database implementation. The browser must never be the only durable copy.

## Data claim

All products are explicitly crypto spot, perpetual, or options products. Nothing in this service identifies crypto perpetuals as CME or another regulated futures contract.
