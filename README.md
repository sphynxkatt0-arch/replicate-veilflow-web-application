# VeilFlow

A React/Vite market-microstructure workspace with real public market data, chart replay, order-book depth, time and sales, drawing tools, CSV export, persistent settings, and technical overlays.

## Real market data

| UI symbol | Provider | Provider instrument | Notes |
|---|---|---|---|
| BTC | Binance | `BTCUSDT` spot | Real OHLCV, taker-buy volume, order book, and trades |
| NQ | Hyperliquid / trade[XYZ] | `xyz:XYZ100` | Nasdaq-100-style perpetual proxy; **not CME NQ futures** |
| ES | Hyperliquid / trade[XYZ] | `xyz:SP500` | S&P 500 perpetual proxy; **not CME ES futures** |

The app connects directly from the browser to Binance and Hyperliquid public REST and WebSocket APIs. No API key is required for market data.

Hyperliquid candle snapshots expose historical OHLCV but not historical aggressor-side volume. Therefore, NQ/ES historical footprint bars show real total volume, while buy/sell flow begins accumulating from the live trades WebSocket after connection. The interface labels this limitation instead of fabricating historical delta.

## Features

- Live candles for 1m, 3m, 5m, 15m, 30m, 1h, 4h, and 1d
- Real order-book depth heatmap and depth ladder
- Real time-and-sales stream and large-trade bubbles
- Candle, footprint, and delta views
- EMA 20, session VWAP, and real-volume histogram
- Replay mode with play, pause, step, speed, and scrub controls
- Cursor pan, wheel zoom, trend line, horizontal line, rectangle, erase, and clear tools
- CSV candle export
- Persistent symbol, timeframe, chart mode, and workspace settings
- Automatic WebSocket reconnect with visible connection status
- Responsive desktop and mobile layouts

## Development

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
npm run preview
```

## Data-source behavior

- Binance REST requests rotate through multiple official public hosts if one endpoint is unavailable.
- Binance WebSocket connections rotate between the official 9443 and 443 endpoints on reconnect.
- Hyperliquid uses `https://api.hyperliquid.xyz/info` and `wss://api.hyperliquid.xyz/ws`.
- WebSocket reconnects use capped exponential backoff and Hyperliquid ping heartbeats.
