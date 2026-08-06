# VeilFlow v4 Architecture

VeilFlow v4 replaces browser-injected correction scripts with a source-native market-data, analytics, replay, rendering and workspace architecture.

## Data truth

- `BTCUSDT` is Binance spot.
- `XYZ100 PERP` and `SP500 PERP` are Hyperliquid perpetual proxies and are never presented as CME NQ or ES.
- Every provider object carries venue, product type, units, timestamps and data-quality state.
- Historical analytics degrade explicitly to `live-only`, `aggregate`, `proxy`, `stale`, `gapped` or `unavailable` rather than silently implying full fidelity.

## Provider adapters

### Binance

The native local-book engine follows the exchange snapshot-plus-diff sequence:

1. Subscribe to diff-depth updates.
2. Buffer events while loading a REST depth snapshot.
3. Drop events already represented by the snapshot.
4. Require the first retained event to bridge `lastUpdateId + 1`.
5. Apply only contiguous updates.
6. Delete zero-quantity levels.
7. Detect gaps and resynchronize automatically.

Trades, candles and metrics are normalized into common event contracts with exchange and receipt timestamps.

### Hyperliquid

The provider loads candles, L2 depth and asset context from the info endpoint, then subscribes to candles, books, trades and active-asset context over WebSocket. A heartbeat and exponential reconnect policy keep the stream observable. The proxy quality state remains visible throughout the product.

## Analytics

- UTC-session VWAP is calculated from the full loaded session and does not change when the viewport changes.
- Session CVD uses historical aggressor splits when available and clearly falls back to live-only trade accumulation when they are not.
- Rolling Delta is explicitly a 200-bar measure.
- Depth imbalance is distance-weighted across the top 20 displayed levels.
- Microprice, spread and spread basis points use the synchronized best bid and ask.
- Large prints combine an instrument floor with a rolling percentile. Quiet tape can produce zero events; the detector never invents a minimum count.

## Replay

Every live candle, trade, book snapshot, metric update and connection-state event is recorded into a bounded normalized event log. Sessions can be exported and imported as `veilflow-session-v1` JSON. Replay reduces the event stream deterministically and is isolated from live state.

## Performance

- Provider events update a mutable model and commit to React on an 80 ms display cadence.
- Candles, trades and replay events use bounded buffers.
- The chart uses a high-DPI Canvas renderer rather than a large SVG tree.
- Dense tape panels use bounded lists.
- Event rate, receipt lag and renderer activity are exposed in the status bar.

## Workspace

The terminal provides a resizable and persistent sidebar, collapsible panels, compact/comfortable density, keyboard shortcuts, chart zoom/pan/crosshair interaction, data-quality badges and a separate small-screen layout.

## Quality gates

Pull requests and pushes to `master` run:

1. TypeScript strict type checking.
2. Unit tests for local-book sequencing, gap handling, zero deletion, crossed-book normalization, grouping conservation, session analytics and outlier detection.
3. A production Vite build.
