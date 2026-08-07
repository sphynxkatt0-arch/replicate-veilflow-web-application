import { createServer } from "node:http";
import { FileEventLog } from "./core.mjs";

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
  response.end(body);
}

export function createGateway({ dataDir, host = process.env.HOST || "127.0.0.1", port = Number(process.env.PORT || 8790), pollMs = 100, batchSize = 1_000 } = {}) {
  const log = new FileEventLog(dataDir);
  const clients = new Set();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") {
      json(response, 200, { status: "ok", service: "veilflow-regional-gateway", clients: clients.size, time: Date.now() });
      return;
    }
    if (url.pathname === "/sessions") {
      json(response, 200, { sessions: await log.listSessions() });
      return;
    }
    const match = url.pathname.match(/^\/stream\/([^/]+)$/);
    if (!match) { json(response, 404, { error: "not found" }); return; }
    const sessionId = decodeURIComponent(match[1]);
    let cursor = Math.max(0, Number.parseInt(url.searchParams.get("cursor") || request.headers["last-event-id"] || "0", 10) || 0);
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "X-Accel-Buffering": "no",
    });
    response.write(`event: ready\ndata: ${JSON.stringify({ sessionId, cursor })}\n\n`);
    const client = { sessionId, response, cursor };
    clients.add(client);
    const timer = setInterval(async () => {
      try {
        const events = await log.readEvents(sessionId, { start: client.cursor, limit: batchSize });
        if (events.length) {
          for (const event of events) {
            response.write(`id: ${client.cursor}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
            client.cursor += 1;
          }
        } else response.write(`: heartbeat ${Date.now()}\n\n`);
      } catch (error) {
        response.write(`event: error\ndata: ${JSON.stringify({ message: error instanceof Error ? error.message : String(error) })}\n\n`);
      }
    }, pollMs);
    request.on("close", () => { clearInterval(timer); clients.delete(client); });
  });
  return {
    server,
    start: () => new Promise((resolve) => server.listen(port, host, () => resolve({ host, port }))),
    stop: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    clients,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const gateway = createGateway();
  gateway.start().then(({ host, port }) => console.log(`VeilFlow gateway listening on http://${host}:${port}`));
}
