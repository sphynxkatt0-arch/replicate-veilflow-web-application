import { createServer } from "node:http";
import { FileEventLog, sha256 } from "./core.mjs";

const TIMEFRAMES = Object.freeze({ "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 });

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  response.end(body);
}

function text(response, status, body, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  response.end(body);
}

function positiveInteger(value, fallback, maximum = 100_000) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, maximum) : fallback;
}

function csvCell(value) {
  const textValue = value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(textValue) ? `"${textValue.replaceAll('"', '""')}"` : textValue;
}

export function eventsToCsv(events) {
  const headers = ["schemaVersion", "id", "venue", "productType", "symbol", "venueSymbol", "eventType", "exchangeTimestamp", "receiveTimestamp", "sequence", "quality", "payload"];
  return [headers.join(","), ...events.map((event) => headers.map((header) => csvCell(event[header])).join(","))].join("\n");
}

function groupPrice(price, tickSize) {
  return Number((Math.round(price / tickSize) * tickSize).toPrecision(12));
}

export function buildFootprints(events, timeframe = "1m", tickSize = 0.01) {
  const interval = TIMEFRAMES[timeframe];
  if (!interval) throw new Error(`Unsupported timeframe ${timeframe}`);
  const buckets = new Map();
  let globalQuality = "FULL";
  for (const event of events) {
    if (event.eventType === "quality") {
      globalQuality = event.payload?.to ?? event.quality;
      continue;
    }
    if (event.eventType !== "trade") continue;
    const time = Math.floor(event.exchangeTimestamp / interval) * interval;
    let candle = buckets.get(time);
    if (!candle) {
      candle = { time, endTime: time + interval - 1, rows: new Map(), quality: globalQuality, eventCount: 0 };
      buckets.set(time, candle);
    }
    const price = groupPrice(Number(event.payload.price), tickSize);
    const size = Number(event.payload.size);
    if (!Number.isFinite(price) || !Number.isFinite(size) || size < 0) continue;
    const row = candle.rows.get(price) ?? { price, bidVolume: 0, askVolume: 0, tradeCount: 0 };
    if (event.payload.side === "buy") row.askVolume += size; else row.bidVolume += size;
    row.tradeCount += 1;
    candle.rows.set(price, row);
    candle.eventCount += 1;
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time).map((candle) => {
    const rows = [...candle.rows.values()].sort((a, b) => b.price - a.price).map((row) => ({ ...row, totalVolume: row.bidVolume + row.askVolume, delta: row.askVolume - row.bidVolume }));
    const totalBidVolume = rows.reduce((sum, row) => sum + row.bidVolume, 0);
    const totalAskVolume = rows.reduce((sum, row) => sum + row.askVolume, 0);
    const poc = rows.reduce((best, row) => !best || row.totalVolume > best.totalVolume ? row : best, undefined);
    return {
      time: candle.time,
      endTime: candle.endTime,
      rows,
      totalBidVolume,
      totalAskVolume,
      totalVolume: totalBidVolume + totalAskVolume,
      delta: totalAskVolume - totalBidVolume,
      pocPrice: poc?.price,
      eventCount: candle.eventCount,
      quality: candle.quality,
      hash: sha256(rows),
    };
  });
}

export function createApiServer({ dataDir, port = Number(process.env.PORT || 8787), host = process.env.HOST || "127.0.0.1" } = {}) {
  const log = new FileEventLog(dataDir);
  const server = createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
      response.end();
      return;
    }
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const parts = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { status: "ok", service: "veilflow-collector-api", schemaVersion: 1, time: Date.now() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/sessions") {
        json(response, 200, { sessions: await log.listSessions() });
        return;
      }
      if (request.method === "GET" && parts[0] === "sessions" && parts[1]) {
        const sessionId = decodeURIComponent(parts[1]);
        if (parts.length === 2 || parts[2] === "manifest") {
          json(response, 200, await log.readManifest(sessionId));
          return;
        }
        if (parts[2] === "events") {
          const events = await log.readEvents(sessionId, { start: positiveInteger(url.searchParams.get("start"), 0), limit: positiveInteger(url.searchParams.get("limit"), 10_000, 100_000) });
          json(response, 200, { sessionId, events, eventCount: events.length });
          return;
        }
        if (parts[2] === "footprints") {
          const events = await log.readEvents(sessionId);
          const timeframe = url.searchParams.get("timeframe") || "1m";
          const tickSize = Number(url.searchParams.get("tickSize") || "0.01");
          const footprints = buildFootprints(events, timeframe, tickSize);
          json(response, 200, { sessionId, timeframe, tickSize, footprintCount: footprints.length, outputHash: sha256(footprints), footprints });
          return;
        }
        if (parts[2] === "verify") {
          json(response, 200, await log.verify(sessionId));
          return;
        }
        if (parts[2] === "export.csv") {
          const events = await log.readEvents(sessionId);
          text(response, 200, eventsToCsv(events), "text/csv; charset=utf-8");
          return;
        }
      }
      json(response, 404, { error: "not found" });
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  return {
    server,
    start: () => new Promise((resolve) => server.listen(port, host, () => resolve({ host, port }))),
    stop: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const api = createApiServer();
  api.start().then(({ host, port }) => console.log(`VeilFlow collector API listening on http://${host}:${port}`));
}
