# VeilFlow Collector

This service moves authoritative capture, normalization, sequence validation, replay storage, and historical reconstruction out of the browser.

## Services

- `runtime.mjs`: long-running venue collector with deduplication, bounded out-of-order handling, sequence-gap detection, exponential reconnect, stale detection, quality transitions, periodic checkpoints, and append-only event storage.
- `history.mjs`: historical Binance Spot/USDⓈ-M aggregate-trade ingestion over explicit time ranges with pagination, deduplication, sequence-gap detection, and durable normalized session output.
- `api.mjs`: session catalogue, integrity verification, paged normalized events, historical footprint reconstruction, and CSV export.
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

The browser must not be responsible for reconstructing deep historical footprints from millions of executions. Seed the durable collector store first, then serve reconstructed or precomputed footprints from the collector API.

By default this command ingests the latest 24 hours of `BTCUSDT` spot aggregate trades:

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

`VEILFLOW_START_TIME` and `VEILFLOW_END_TIME` accept ISO timestamps or Unix milliseconds. The importer requests Binance in bounded time windows, continues with `fromId` when a window contains more than one page, deduplicates aggregate-trade IDs, and records any missing sequence range as an explicit `GAPPED` quality transition. It never silently fabricates execution history.

The resulting session is immediately available through the same `/sessions/:id/...` API used by replay and footprint reconstruction.

## API

- `GET /health`
- `GET /sessions`
- `GET /sessions/:id/manifest`
- `GET /sessions/:id/events?start=0&limit=10000`
- `GET /sessions/:id/footprints?timeframe=1m&tickSize=0.01`
- `GET /sessions/:id/verify`
- `GET /sessions/:id/export.csv`

The gateway exposes `GET /stream/:sessionId?cursor=0` using Server-Sent Events.

## Storage contract

Each session contains:

```text
sessions/<session-id>/
  manifest.json
  events.ndjson
  checkpoints/
    000000004999.json
    000000009999.json
```

`manifest.json` records schema versions, venue, instrument, product type, event count, event hash, checkpoint count, analytics hash, and manifest hash. Writes use temporary files and atomic rename. Event appends are flushed with `fsync` before the manifest is advanced.

For clustered production, mount a durable replicated volume or replace `FileEventLog` behind the same contract with an object-store/database implementation. The browser must never be the only durable copy.

## Data claim

All products are explicitly crypto spot, perpetual, or options products. Nothing in this service identifies crypto perpetuals as CME or another regulated futures contract.
