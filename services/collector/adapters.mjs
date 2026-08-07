import { normalizedEvent } from "./core.mjs";

function number(value, fallback = 0) {
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function timestamp(value) {
  const result = number(value, Date.now());
  return result < 10_000_000_000 ? result * 1_000 : result;
}

function product(context) { return context.productType ?? "spot"; }
function symbol(context) { return context.symbol ?? context.venueSymbol; }

function event(context, eventType, id, exchangeTimestamp, payload, sequence, quality = "FULL") {
  return normalizedEvent({
    id: `${context.venue}:${context.venueSymbol}:${eventType}:${id}`,
    venue: context.venue,
    productType: product(context),
    symbol: symbol(context),
    venueSymbol: context.venueSymbol,
    eventType,
    exchangeTimestamp: timestamp(exchangeTimestamp),
    receiveTimestamp: Date.now(),
    sequence,
    quality,
    payload,
  });
}

function tradePayload(price, size, side, raw = {}) {
  const normalizedPrice = number(price);
  const normalizedSize = number(size);
  return {
    price: normalizedPrice,
    size: normalizedSize,
    notional: normalizedPrice * normalizedSize,
    side: side === "buy" ? "buy" : "sell",
    raw,
  };
}

function bookRows(rows = []) {
  return rows.map((row) => [number(row.price ?? row.px ?? row[0]), number(row.size ?? row.sz ?? row[1])]).filter(([price, size]) => price > 0 && size >= 0);
}

export const binanceAdapter = {
  id: "binance",
  wsUrl(context) {
    const base = product(context) === "perpetual" ? "wss://fstream.binance.com/stream" : "wss://stream.binance.com:9443/stream";
    const stream = context.venueSymbol.toLowerCase();
    return `${base}?streams=${stream}@aggTrade/${stream}@depth@100ms/${stream}@kline_1m/${stream}@markPrice@1s/${stream}@forceOrder`;
  },
  subscribe() {},
  parse(message, context) {
    const envelope = JSON.parse(message);
    const data = envelope.data ?? envelope;
    const type = data.e;
    if (type === "aggTrade") {
      return [event(context, "trade", data.a, data.T, tradePayload(data.p, data.q, data.m ? "sell" : "buy", { maker: data.m }), data.a)];
    }
    if (type === "depthUpdate") {
      return [event(context, "book-update", data.u, data.E, { bids: bookRows(data.b), asks: bookRows(data.a), firstSequence: String(data.U), finalSequence: String(data.u), previousSequence: data.pu === undefined ? undefined : String(data.pu) }, data.u)];
    }
    if (type === "kline") {
      const k = data.k;
      return [event(context, "candle", `${k.t}-${k.i}`, k.T, { timeframe: k.i, time: k.t, endTime: k.T, open: number(k.o), high: number(k.h), low: number(k.l), close: number(k.c), volume: number(k.v), buyVolume: number(k.V), trades: number(k.n), closed: Boolean(k.x) }, k.t)];
    }
    if (type === "markPriceUpdate") {
      return [event(context, "metrics", data.E, data.E, { markPrice: number(data.p), indexPrice: number(data.i), fundingRate: number(data.r), nextFundingTime: number(data.T) }, data.E)];
    }
    if (type === "forceOrder") {
      const order = data.o;
      return [event(context, "liquidation", `${order.T}-${order.S}-${order.p}`, order.T, tradePayload(order.p, order.q, order.S === "BUY" ? "buy" : "sell", { status: order.X }), order.T)];
    }
    return [];
  },
};

export const coinbaseAdapter = {
  id: "coinbase",
  wsUrl() { return "wss://advanced-trade-ws.coinbase.com"; },
  subscribe(socket, context) {
    for (const channel of ["market_trades", "level2", "ticker", "heartbeats"]) {
      socket.send(JSON.stringify({ type: "subscribe", product_ids: [context.venueSymbol], channel }));
    }
  },
  parse(message, context) {
    const data = JSON.parse(message);
    const events = [];
    for (const packet of data.events ?? []) {
      if (packet.type === "update" && data.channel === "market_trades") {
        for (const trade of packet.trades ?? []) events.push(event(context, "trade", trade.trade_id, trade.time, tradePayload(trade.price, trade.size, trade.side === "BUY" ? "buy" : "sell"), trade.trade_id));
      } else if (data.channel === "l2_data") {
        const bids = []; const asks = [];
        for (const update of packet.updates ?? []) (update.side === "bid" ? bids : asks).push([number(update.price_level), number(update.new_quantity)]);
        events.push(event(context, "book-update", data.sequence_num, data.timestamp, { bids, asks }, data.sequence_num));
      } else if (data.channel === "ticker") {
        for (const ticker of packet.tickers ?? []) events.push(event(context, "metrics", data.sequence_num, data.timestamp, { price: number(ticker.price), bestBid: number(ticker.best_bid), bestAsk: number(ticker.best_ask), volume24h: number(ticker.volume_24_h) }, data.sequence_num));
      }
    }
    return events;
  },
};

export const bybitAdapter = {
  id: "bybit",
  wsUrl(context) { return product(context) === "spot" ? "wss://stream.bybit.com/v5/public/spot" : "wss://stream.bybit.com/v5/public/linear"; },
  subscribe(socket, context) {
    socket.send(JSON.stringify({ op: "subscribe", args: [`publicTrade.${context.venueSymbol}`, `orderbook.200.${context.venueSymbol}`, `tickers.${context.venueSymbol}`, `liquidation.${context.venueSymbol}`] }));
  },
  parse(message, context) {
    const data = JSON.parse(message);
    if (!data.topic) return [];
    if (data.topic.startsWith("publicTrade.")) return (data.data ?? []).map((trade) => event(context, "trade", trade.i ?? `${trade.T}-${trade.p}`, trade.T, tradePayload(trade.p, trade.v, trade.S === "Buy" ? "buy" : "sell", { tickDirection: trade.L }), trade.seq ?? trade.i));
    if (data.topic.startsWith("orderbook.")) {
      const payload = data.data ?? {};
      return [event(context, data.type === "snapshot" ? "book-snapshot" : "book-update", data.seq ?? payload.u, data.ts, { bids: bookRows(payload.b), asks: bookRows(payload.a), updateId: payload.u }, data.seq ?? payload.u)];
    }
    if (data.topic.startsWith("tickers.")) {
      const ticker = data.data ?? {};
      return [event(context, "metrics", data.cs ?? data.ts, data.ts, { price: number(ticker.lastPrice), markPrice: number(ticker.markPrice), indexPrice: number(ticker.indexPrice), fundingRate: number(ticker.fundingRate), openInterest: number(ticker.openInterest), volume24h: number(ticker.volume24h), bestBid: number(ticker.bid1Price), bestAsk: number(ticker.ask1Price) }, data.cs ?? data.ts)];
    }
    if (data.topic.startsWith("liquidation.")) {
      const liquidation = data.data ?? {};
      return [event(context, "liquidation", `${liquidation.updatedTime}-${liquidation.side}`, liquidation.updatedTime ?? data.ts, tradePayload(liquidation.price, liquidation.size, liquidation.side === "Buy" ? "buy" : "sell"), liquidation.updatedTime ?? data.ts)];
    }
    return [];
  },
};

export const okxAdapter = {
  id: "okx",
  wsUrl() { return "wss://ws.okx.com:8443/ws/v5/public"; },
  subscribe(socket, context) {
    socket.send(JSON.stringify({ op: "subscribe", args: [
      { channel: "trades", instId: context.venueSymbol },
      { channel: "books", instId: context.venueSymbol },
      { channel: "tickers", instId: context.venueSymbol },
      { channel: "funding-rate", instId: context.venueSymbol },
      { channel: "open-interest", instId: context.venueSymbol },
      { channel: "liquidation-orders", instType: product(context) === "spot" ? "SPOT" : "SWAP", instId: context.venueSymbol },
    ] }));
  },
  parse(message, context) {
    const data = JSON.parse(message);
    const channel = data.arg?.channel;
    if (!channel || !Array.isArray(data.data)) return [];
    if (channel === "trades") return data.data.map((trade) => event(context, "trade", trade.tradeId, trade.ts, tradePayload(trade.px, trade.sz, trade.side), trade.tradeId));
    if (channel === "books") return data.data.map((book) => event(context, data.action === "snapshot" ? "book-snapshot" : "book-update", book.seqId ?? book.ts, book.ts, { bids: bookRows(book.bids), asks: bookRows(book.asks), previousSequence: book.prevSeqId }, book.seqId));
    if (channel === "tickers") return data.data.map((ticker) => event(context, "metrics", ticker.ts, ticker.ts, { price: number(ticker.last), bestBid: number(ticker.bidPx), bestAsk: number(ticker.askPx), volume24h: number(ticker.vol24h), notional24h: number(ticker.volCcy24h) }, ticker.ts));
    if (channel === "funding-rate") return data.data.map((row) => event(context, "metrics", row.ts, row.ts, { fundingRate: number(row.fundingRate), nextFundingTime: number(row.nextFundingTime) }, row.ts));
    if (channel === "open-interest") return data.data.map((row) => event(context, "metrics", row.ts, row.ts, { openInterest: number(row.oi), openInterestUsd: number(row.oiUsd) }, row.ts));
    if (channel === "liquidation-orders") return data.data.flatMap((row) => (row.details ?? []).map((detail) => event(context, "liquidation", `${detail.ts}-${detail.side}-${detail.px}`, detail.ts, tradePayload(detail.px, detail.sz, detail.side), detail.ts)));
    return [];
  },
};

export const hyperliquidAdapter = {
  id: "hyperliquid",
  wsUrl() { return "wss://api.hyperliquid.xyz/ws"; },
  subscribe(socket, context) {
    socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin: context.venueSymbol } }));
    socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "l2Book", coin: context.venueSymbol } }));
    socket.send(JSON.stringify({ method: "subscribe", subscription: { type: "activeAssetCtx", coin: context.venueSymbol } }));
  },
  parse(message, context) {
    const data = JSON.parse(message);
    const channel = data.channel;
    if (channel === "trades") return (data.data ?? []).map((trade) => event(context, "trade", trade.tid ?? `${trade.time}-${trade.px}`, trade.time, tradePayload(trade.px, trade.sz, trade.side === "B" ? "buy" : "sell", { hash: trade.hash }), trade.tid ?? trade.time));
    if (channel === "l2Book") {
      const book = data.data ?? {};
      return [event(context, "book-snapshot", book.time, book.time, { bids: bookRows(book.levels?.[0]), asks: bookRows(book.levels?.[1]) }, book.time)];
    }
    if (channel === "activeAssetCtx") {
      const ctx = data.data?.ctx ?? data.data ?? {};
      return [event(context, "metrics", data.data?.time ?? Date.now(), data.data?.time ?? Date.now(), { markPrice: number(ctx.markPx), indexPrice: number(ctx.oraclePx), fundingRate: number(ctx.funding), openInterest: number(ctx.openInterest), volume24h: number(ctx.dayNtlVlm) }, data.data?.time ?? Date.now())];
    }
    return [];
  },
};

export const deribitAdapter = {
  id: "deribit",
  wsUrl() { return "wss://www.deribit.com/ws/api/v2"; },
  subscribe(socket, context) {
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "public/subscribe", params: { channels: [`trades.${context.venueSymbol}.raw`, `book.${context.venueSymbol}.raw`, `ticker.${context.venueSymbol}.raw`] } }));
  },
  parse(message, context) {
    const data = JSON.parse(message);
    const channel = data.params?.channel;
    const payload = data.params?.data;
    if (!channel || payload === undefined) return [];
    if (channel.startsWith("trades.")) return (Array.isArray(payload) ? payload : [payload]).map((trade) => event(context, "trade", trade.trade_id, trade.timestamp, tradePayload(trade.price, trade.amount, trade.direction), trade.trade_seq));
    if (channel.startsWith("book.")) return [event(context, payload.type === "snapshot" ? "book-snapshot" : "book-update", payload.change_id, payload.timestamp, { bids: bookRows(payload.bids), asks: bookRows(payload.asks), previousSequence: payload.prev_change_id }, payload.change_id)];
    if (channel.startsWith("ticker.")) return [event(context, "metrics", payload.timestamp, payload.timestamp, { price: number(payload.last_price), markPrice: number(payload.mark_price), indexPrice: number(payload.index_price), fundingRate: number(payload.current_funding), openInterest: number(payload.open_interest), bestBid: number(payload.best_bid_price), bestAsk: number(payload.best_ask_price) }, payload.timestamp)];
    return [];
  },
};

export const VENUE_ADAPTERS = Object.freeze({
  binance: binanceAdapter,
  coinbase: coinbaseAdapter,
  bybit: bybitAdapter,
  okx: okxAdapter,
  hyperliquid: hyperliquidAdapter,
  deribit: deribitAdapter,
});

export function getAdapter(venue) {
  const adapter = VENUE_ADAPTERS[venue];
  if (!adapter) throw new Error(`Unsupported venue ${venue}`);
  return adapter;
}
