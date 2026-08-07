import { Deduplicator, FileEventLog, SequenceValidator, reduceEvents } from "./core.mjs";
import { getAdapter } from "./adapters.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class CollectorRuntime {
  constructor({
    venue,
    venueSymbol,
    symbol = venueSymbol,
    productType = "spot",
    dataDir,
    checkpointEvery = 5_000,
    staleAfterMs = 8_000,
    maxBackoffMs = 15_000,
    logger = console,
  }) {
    this.context = { venue, venueSymbol, symbol, productType };
    this.adapter = getAdapter(venue);
    this.log = new FileEventLog(dataDir);
    this.checkpointEvery = checkpointEvery;
    this.staleAfterMs = staleAfterMs;
    this.maxBackoffMs = maxBackoffMs;
    this.logger = logger;
    this.deduplicator = new Deduplicator();
    this.tradeSequence = new SequenceValidator({ maxReorder: 256 });
    this.bookSequence = new SequenceValidator({ maxReorder: 256 });
    this.events = [];
    this.closed = false;
    this.socket = undefined;
    this.session = undefined;
    this.lastEventAt = 0;
    this.staleTimer = undefined;
  }

  async start() {
    this.closed = false;
    this.session = await this.log.createSession({
      venue: this.context.venue,
      venueSymbol: this.context.venueSymbol,
      symbol: this.context.symbol,
      productType: this.context.productType,
      startTime: Date.now(),
      collectorVersion: "1.0.0",
      eventSchemaVersion: 1,
    });
    this.#startStaleWatch();
    let attempt = 0;
    while (!this.closed) {
      try {
        await this.#connect();
        attempt = 0;
      } catch (error) {
        if (this.closed) break;
        attempt += 1;
        const wait = Math.min(this.maxBackoffMs, 500 * 2 ** Math.min(attempt, 5)) + Math.round(Math.random() * 250);
        this.logger.error?.("collector disconnected", { venue: this.context.venue, attempt, wait, error: error instanceof Error ? error.message : String(error) });
        await this.#recordQuality("STALE", `disconnect: ${error instanceof Error ? error.message : String(error)}`);
        await delay(wait);
      }
    }
    return this.session;
  }

  async stop() {
    this.closed = true;
    clearInterval(this.staleTimer);
    this.socket?.close();
    if (this.session) {
      const state = reduceEvents(this.events);
      await this.log.finalize(this.session.id, JSON.stringify(state));
    }
  }

  async #connect() {
    if (typeof WebSocket === "undefined") throw new Error("Node.js 22+ with global WebSocket is required");
    const url = this.adapter.wsUrl(this.context);
    this.logger.info?.("connecting", { venue: this.context.venue, symbol: this.context.venueSymbol, url });
    await this.#recordQuality("LIVE PARTIAL", "opening venue stream");
    return new Promise((resolve, reject) => {
      let opened = false;
      let settled = false;
      const socket = new WebSocket(url);
      this.socket = socket;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        this.socket = undefined;
        if (error) reject(error); else resolve();
      };
      socket.addEventListener("open", () => {
        opened = true;
        try {
          this.adapter.subscribe(socket, this.context);
          void this.#recordQuality("LIVE PARTIAL", "connected; waiting for complete synchronized coverage");
        } catch (error) { finish(error); }
      });
      socket.addEventListener("message", (message) => {
        void this.#handleMessage(typeof message.data === "string" ? message.data : String(message.data)).catch((error) => {
          this.logger.error?.("message handling failed", error);
          socket.close(1011, "message handling failed");
        });
      });
      socket.addEventListener("error", () => finish(new Error("websocket failure")));
      socket.addEventListener("close", (close) => {
        if (this.closed) finish();
        else finish(new Error(`websocket closed ${close.code}${opened ? "" : " before open"}`));
      });
    });
  }

  async #handleMessage(raw) {
    const parsed = this.adapter.parse(raw, this.context);
    if (!parsed.length) return;
    this.lastEventAt = Date.now();
    const ready = [];
    for (const event of parsed) {
      if (!this.deduplicator.accept(event.id)) continue;
      const validator = event.eventType === "trade" ? this.tradeSequence
        : event.eventType === "book-update" || event.eventType === "book-snapshot" ? this.bookSequence
          : undefined;
      if (!validator || event.eventType === "book-snapshot") {
        if (event.eventType === "book-snapshot") validator?.reset(event.sequence);
        ready.push(event);
        continue;
      }
      const result = validator.accept(event);
      ready.push(...result.ready);
      if (result.gap) {
        await this.#recordQuality("GAPPED", `${event.eventType} expected ${result.gap.expected}, received ${result.gap.received}`);
        if (result.resyncRequired) {
          this.logger.warn?.("sequence resync required", result.gap);
          this.socket?.close(1012, "sequence resync required");
          return;
        }
      }
    }
    if (!ready.length) return;
    this.events.push(...ready);
    await this.log.append(this.session.id, ready);
    if (this.events.length % this.checkpointEvery < ready.length) {
      const state = reduceEvents(this.events);
      await this.log.checkpoint(this.session.id, state, this.events.length - 1, ready.at(-1).exchangeTimestamp);
    }
    if (this.tradeSequence.gaps.length === 0 && this.bookSequence.gaps.length === 0) await this.#recordQuality("FULL", "trade and book sequences contiguous", "sequence validators passing");
  }

  async #recordQuality(to, reason, evidence) {
    if (!this.session) return;
    const now = Date.now();
    const last = this.events.at(-1);
    if (last?.eventType === "quality" && last.payload?.to === to && last.payload?.reason === reason) return;
    const qualityEvent = {
      schemaVersion: 1,
      id: `${this.context.venue}:${this.context.venueSymbol}:quality:${now}:${to}`,
      venue: this.context.venue,
      productType: this.context.productType,
      symbol: this.context.symbol,
      venueSymbol: this.context.venueSymbol,
      eventType: "quality",
      exchangeTimestamp: now,
      receiveTimestamp: now,
      quality: to,
      payload: { from: last?.quality ?? "UNAVAILABLE", to, reason, evidence },
    };
    this.events.push(qualityEvent);
    await this.log.append(this.session.id, [qualityEvent]);
  }

  #startStaleWatch() {
    this.staleTimer = setInterval(() => {
      if (!this.lastEventAt || this.closed) return;
      const age = Date.now() - this.lastEventAt;
      if (age > this.staleAfterMs) void this.#recordQuality("STALE", `no venue event for ${age} ms`);
    }, 250);
  }
}

export async function runFromEnvironment() {
  const runtime = new CollectorRuntime({
    venue: process.env.VEILFLOW_VENUE || "binance",
    venueSymbol: process.env.VEILFLOW_VENUE_SYMBOL || "BTCUSDT",
    symbol: process.env.VEILFLOW_SYMBOL || "BTC/USDT",
    productType: process.env.VEILFLOW_PRODUCT_TYPE || "spot",
    dataDir: process.env.VEILFLOW_DATA_DIR,
  });
  const shutdown = async () => { await runtime.stop(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await runtime.start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFromEnvironment().catch((error) => { console.error(error); process.exit(1); });
}
