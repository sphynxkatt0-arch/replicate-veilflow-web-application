import { createServer } from "node:http";
import { join } from "node:path";
import { FileEventLog, sha256 } from "./core.mjs";
import { JsonDocumentStore, TelemetryStore, evaluateAlert, validateWorkspaceDocument } from "./control.mjs";
import { buildFootprints, footprintCoverage } from "./footprints.mjs";
import { FootprintStore, footprintCacheKey } from "./footprintStore.mjs";

export { buildFootprints } from "./footprints.mjs";

const MAX_BODY_BYTES = 10_000_000;

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

function optionalNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("request body limit exceeded");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function csvCell(value) {
  const textValue = value === undefined || value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(textValue) ? `"${textValue.replaceAll('"', '""')}"` : textValue;
}

export function eventsToCsv(events) {
  const headers = ["schemaVersion", "id", "venue", "productType", "symbol", "venueSymbol", "eventType", "exchangeTimestamp", "receiveTimestamp", "sequence", "quality", "payload"];
  return [headers.join(","), ...events.map((event) => headers.map((header) => csvCell(event[header])).join(","))].join("\n");
}

export function createApiServer({ dataDir, port = Number(process.env.PORT || 8787), host = process.env.HOST || "127.0.0.1" } = {}) {
  const root = dataDir || process.env.VEILFLOW_DATA_DIR || join(process.cwd(), ".veilflow-data");
  const log = new FileEventLog(root);
  const footprintStore = new FootprintStore(root);
  const workspaces = new JsonDocumentStore(root, "workspaces");
  const alerts = new JsonDocumentStore(root, "alerts");
  const telemetry = new TelemetryStore(root);
  const server = createServer(async (request, response) => {
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
      response.end();
      return;
    }
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      const parts = url.pathname.split("/").filter(Boolean);
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { status: "ok", service: "veilflow-collector-api", schemaVersion: 1, sessions: (await log.listSessions()).length, time: Date.now() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/sessions") {
        json(response, 200, { sessions: await log.listSessions() });
        return;
      }
      if (parts[0] === "sessions" && parts[1]) {
        const sessionId = decodeURIComponent(parts[1]);
        if (request.method === "GET" && (parts.length === 2 || parts[2] === "manifest")) {
          json(response, 200, await log.readManifest(sessionId));
          return;
        }
        if (request.method === "GET" && parts[2] === "events") {
          const events = await log.readEvents(sessionId, { start: positiveInteger(url.searchParams.get("start"), 0), limit: positiveInteger(url.searchParams.get("limit"), 10_000, 100_000) });
          json(response, 200, { sessionId, events, eventCount: events.length });
          return;
        }
        if (request.method === "GET" && parts[2] === "footprints") {
          const timeframe = url.searchParams.get("timeframe") || "1m";
          const tickSize = Number(url.searchParams.get("tickSize") || "0.01");
          const options = {
            startTime: optionalNumber(url.searchParams.get("startTime")),
            endTime: optionalNumber(url.searchParams.get("endTime")),
            imbalanceRatio: optionalNumber(url.searchParams.get("imbalanceRatio")),
            minVolume: optionalNumber(url.searchParams.get("minVolume")),
            valueAreaRatio: optionalNumber(url.searchParams.get("valueAreaRatio")),
          };
          const manifest = await log.readManifest(sessionId);
          const cacheable = manifest.status === "complete" && typeof manifest.eventHash === "string";
          const key = cacheable ? footprintCacheKey({ sessionId, eventHash: manifest.eventHash, timeframe, tickSize, options }) : undefined;
          if (key) {
            const cached = await footprintStore.get(sessionId, key);
            if (cached) {
              json(response, 200, { ...cached.payload, cache: { state: "HIT", key, createdAt: cached.createdAt } });
              return;
            }
          }

          const events = await log.readEvents(sessionId);
          const footprints = buildFootprints(events, timeframe, tickSize, options);
          const coverage = footprintCoverage(events, footprints, options);
          const payload = {
            sessionId,
            timeframe,
            tickSize,
            requestedStartTime: options.startTime,
            requestedEndTime: options.endTime,
            footprintCount: footprints.length,
            coverage,
            outputHash: sha256(footprints),
            footprints,
          };
          if (key) {
            const cached = await footprintStore.put(sessionId, key, { payload });
            json(response, 200, { ...payload, cache: { state: "MISS", key, createdAt: cached.createdAt } });
          } else {
            json(response, 200, { ...payload, cache: { state: "BYPASS", reason: "session is still mutable" } });
          }
          return;
        }
        if (request.method === "GET" && parts[2] === "verify") {
          json(response, 200, await log.verify(sessionId));
          return;
        }
        if (request.method === "GET" && parts[2] === "export.csv") {
          const events = await log.readEvents(sessionId);
          text(response, 200, eventsToCsv(events), "text/csv; charset=utf-8");
          return;
        }
        if (request.method === "DELETE" && parts.length === 2) {
          await log.deleteSession(sessionId);
          json(response, 200, { deleted: sessionId });
          return;
        }
      }

      if (parts[0] === "workspaces") {
        if (request.method === "GET" && parts.length === 1) { json(response, 200, { workspaces: await workspaces.list() }); return; }
        if (parts[1]) {
          const id = decodeURIComponent(parts[1]);
          if (request.method === "GET") {
            const workspace = await workspaces.get(id);
            if (!workspace) { json(response, 404, { error: "workspace not found" }); return; }
            json(response, 200, workspace); return;
          }
          if (request.method === "PUT") {
            const workspace = await readJson(request);
            const errors = validateWorkspaceDocument({ ...workspace, id });
            if (errors.length) { json(response, 400, { errors }); return; }
            json(response, 200, await workspaces.put(id, { ...workspace, id })); return;
          }
          if (request.method === "DELETE") { await workspaces.delete(id); json(response, 200, { deleted: id }); return; }
        }
      }

      if (url.pathname === "/telemetry" && request.method === "POST") {
        json(response, 202, await telemetry.append(await readJson(request)));
        return;
      }
      if (url.pathname === "/telemetry/summary" && request.method === "GET") {
        json(response, 200, await telemetry.summary());
        return;
      }
      if (url.pathname === "/telemetry/events" && request.method === "GET") {
        json(response, 200, { events: await telemetry.read(positiveInteger(url.searchParams.get("limit"), 1_000)) });
        return;
      }

      if (parts[0] === "alerts") {
        if (request.method === "GET" && parts.length === 1) { json(response, 200, { alerts: await alerts.list() }); return; }
        if (request.method === "POST" && parts[1] === "evaluate") {
          const body = await readJson(request);
          const rules = body.rule ? [body.rule] : await alerts.list();
          const triggered = rules.filter((rule) => evaluateAlert(rule, body.context ?? {}));
          json(response, 200, { triggered, evaluated: rules.length, at: Date.now() }); return;
        }
        if (parts[1]) {
          const id = decodeURIComponent(parts[1]);
          if (request.method === "GET") {
            const alert = await alerts.get(id);
            if (!alert) { json(response, 404, { error: "alert not found" }); return; }
            json(response, 200, alert); return;
          }
          if (request.method === "PUT") {
            const alert = await readJson(request);
            if (!alert.metric || !alert.operator || !Number.isFinite(Number(alert.threshold))) { json(response, 400, { error: "metric, operator, and numeric threshold are required" }); return; }
            json(response, 200, await alerts.put(id, { ...alert, id }); return;
          }
          if (request.method === "DELETE") { await alerts.delete(id); json(response, 200, { deleted: id }); return; }
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
