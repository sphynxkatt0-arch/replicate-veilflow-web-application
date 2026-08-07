import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const EVENT_SCHEMA_VERSION = 1;
export const SESSION_SCHEMA_VERSION = 1;

export function stableStringify(value) {
  const normalize = (item) => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (typeof item === "bigint") return item.toString();
    if (Array.isArray(item)) return item.map(normalize);
    if (typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().filter((key) => item[key] !== undefined).map((key) => [key, normalize(item[key])]));
    }
    return null;
  };
  return JSON.stringify(normalize(value));
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex")}`;
}

export function normalizedEvent(input) {
  const event = {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: String(input.id),
    venue: String(input.venue),
    productType: String(input.productType),
    symbol: String(input.symbol),
    venueSymbol: String(input.venueSymbol ?? input.symbol),
    eventType: String(input.eventType),
    exchangeTimestamp: Number(input.exchangeTimestamp),
    receiveTimestamp: Number(input.receiveTimestamp ?? Date.now()),
    sequence: input.sequence === undefined ? undefined : String(input.sequence),
    quality: String(input.quality ?? "FULL"),
    payload: input.payload ?? {},
  };
  const errors = validateEvent(event);
  if (errors.length) throw new Error(`Invalid normalized event: ${errors.join(", ")}`);
  return event;
}

export function validateEvent(event) {
  const errors = [];
  if (event.schemaVersion !== EVENT_SCHEMA_VERSION) errors.push("schemaVersion");
  for (const key of ["id", "venue", "productType", "symbol", "venueSymbol", "eventType", "quality"]) {
    if (!event[key] || typeof event[key] !== "string") errors.push(key);
  }
  if (!Number.isFinite(event.exchangeTimestamp) || event.exchangeTimestamp <= 0) errors.push("exchangeTimestamp");
  if (!Number.isFinite(event.receiveTimestamp) || event.receiveTimestamp <= 0) errors.push("receiveTimestamp");
  if (event.receiveTimestamp < event.exchangeTimestamp - 120_000) errors.push("clock-order");
  return errors;
}

export class Deduplicator {
  #seen = new Map();
  constructor(limit = 500_000) { this.limit = limit; }
  accept(id) {
    if (this.#seen.has(id)) return false;
    this.#seen.set(id, Date.now());
    if (this.#seen.size > this.limit) {
      const remove = this.#seen.size - this.limit;
      let count = 0;
      for (const key of this.#seen.keys()) {
        this.#seen.delete(key);
        count += 1;
        if (count >= remove) break;
      }
    }
    return true;
  }
}

function asBigInt(value) {
  if (value === undefined || value === null || value === "") return undefined;
  try { return BigInt(value); } catch { return undefined; }
}

export class SequenceValidator {
  constructor({ allowEqual = true, maxReorder = 128 } = {}) {
    this.allowEqual = allowEqual;
    this.maxReorder = maxReorder;
    this.last = undefined;
    this.buffer = new Map();
    this.gaps = [];
  }

  reset(last) {
    this.last = asBigInt(last);
    this.buffer.clear();
    this.gaps.length = 0;
  }

  accept(event, sequence = event.sequence) {
    const current = asBigInt(sequence);
    if (current === undefined) return { status: "unsequenced", ready: [event] };
    if (this.last === undefined) {
      this.last = current;
      return { status: "accepted", ready: [event] };
    }
    if (current < this.last || (current === this.last && !this.allowEqual)) return { status: "duplicate", ready: [] };
    if (current === this.last && this.allowEqual) return { status: "duplicate", ready: [] };
    const expected = this.last + 1n;
    if (current === expected) {
      const ready = [event];
      this.last = current;
      while (this.buffer.has((this.last + 1n).toString())) {
        const nextKey = (this.last + 1n).toString();
        ready.push(this.buffer.get(nextKey));
        this.buffer.delete(nextKey);
        this.last += 1n;
      }
      return { status: "accepted", ready };
    }
    this.buffer.set(current.toString(), event);
    const gap = { expected: expected.toString(), received: current.toString(), at: event.exchangeTimestamp };
    this.gaps.push(gap);
    if (this.buffer.size > this.maxReorder) return { status: "gap", ready: [], gap, resyncRequired: true };
    return { status: "buffered", ready: [], gap };
  }
}

export function normalizeBook({ bids = [], asks = [], depth = 1_000 }) {
  const side = (rows, descending) => rows
    .map((row) => ({ price: Number(row.price ?? row[0]), size: Number(row.size ?? row[1]) }))
    .filter((row) => Number.isFinite(row.price) && Number.isFinite(row.size) && row.price > 0 && row.size > 0)
    .sort((a, b) => descending ? b.price - a.price : a.price - b.price)
    .slice(0, depth);
  const normalized = { bids: side(bids, true), asks: side(asks, false) };
  while (normalized.bids[0] && normalized.asks[0] && normalized.bids[0].price >= normalized.asks[0].price) {
    if (normalized.bids[0].size <= normalized.asks[0].size) normalized.bids.shift();
    else normalized.asks.shift();
  }
  return normalized;
}

export class LocalBook {
  constructor() { this.reset(); }
  reset() { this.bids = new Map(); this.asks = new Map(); this.sequence = undefined; this.quality = "UNAVAILABLE"; }
  snapshot(snapshot, sequence) {
    this.reset();
    for (const [price, size] of snapshot.bids ?? []) this.#apply(this.bids, price, size);
    for (const [price, size] of snapshot.asks ?? []) this.#apply(this.asks, price, size);
    this.sequence = asBigInt(sequence ?? snapshot.lastUpdateId);
    this.quality = "FULL";
    return this.value();
  }
  update(update, sequence) {
    for (const [price, size] of update.bids ?? update.b ?? []) this.#apply(this.bids, price, size);
    for (const [price, size] of update.asks ?? update.a ?? []) this.#apply(this.asks, price, size);
    this.sequence = asBigInt(sequence ?? update.sequence ?? update.u) ?? this.sequence;
    return this.value();
  }
  #apply(side, price, size) {
    const p = Number(price); const q = Number(size);
    if (!Number.isFinite(p) || !Number.isFinite(q)) return;
    if (q === 0) side.delete(p); else side.set(p, q);
  }
  value(depth = 1_000) {
    const book = normalizeBook({ bids: [...this.bids], asks: [...this.asks], depth });
    return { ...book, sequence: this.sequence?.toString(), quality: this.quality };
  }
}

export class FileEventLog {
  constructor(root = process.env.VEILFLOW_DATA_DIR || join(process.cwd(), ".veilflow-data")) { this.root = root; }

  sessionDir(sessionId) { return join(this.root, "sessions", sessionId); }
  eventsPath(sessionId) { return join(this.sessionDir(sessionId), "events.ndjson"); }
  manifestPath(sessionId) { return join(this.sessionDir(sessionId), "manifest.json"); }
  checkpointsDir(sessionId) { return join(this.sessionDir(sessionId), "checkpoints"); }

  async createSession(metadata) {
    const id = metadata.id || `${metadata.venue}-${metadata.venueSymbol}-${metadata.startTime ?? Date.now()}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    const directory = this.sessionDir(id);
    await mkdir(this.checkpointsDir(id), { recursive: true });
    const manifest = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "recording",
      eventCount: 0,
      eventHash: sha256(""),
      checkpointCount: 0,
      ...metadata,
    };
    await this.#atomicJson(this.manifestPath(id), manifest);
    await writeFile(this.eventsPath(id), "", { flag: "a" });
    return manifest;
  }

  async append(sessionId, events) {
    if (!events.length) return this.readManifest(sessionId);
    const valid = events.map(normalizedEvent);
    const handle = await open(this.eventsPath(sessionId), "a");
    try {
      await handle.write(valid.map((event) => `${stableStringify(event)}\n`).join(""));
      await handle.sync();
    } finally { await handle.close(); }
    const manifest = await this.readManifest(sessionId);
    manifest.eventCount += valid.length;
    manifest.startTime ??= valid[0].exchangeTimestamp;
    manifest.endTime = valid.at(-1).exchangeTimestamp;
    manifest.updatedAt = Date.now();
    manifest.eventHash = await this.hashEvents(sessionId);
    await this.#atomicJson(this.manifestPath(sessionId), manifest);
    return manifest;
  }

  async checkpoint(sessionId, state, cursor, exchangeTimestamp) {
    const manifest = await this.readManifest(sessionId);
    const checkpoint = {
      schemaVersion: 1,
      sessionId,
      cursor,
      exchangeTimestamp,
      state,
      stateHash: sha256(state),
      createdAt: Date.now(),
    };
    const path = join(this.checkpointsDir(sessionId), `${String(cursor).padStart(12, "0")}.json`);
    await this.#atomicJson(path, checkpoint);
    manifest.checkpointCount += 1;
    manifest.updatedAt = Date.now();
    await this.#atomicJson(this.manifestPath(sessionId), manifest);
    return checkpoint;
  }

  async readManifest(sessionId) {
    return JSON.parse(await readFile(this.manifestPath(sessionId), "utf8"));
  }

  async readEvents(sessionId, { start = 0, limit = Number.POSITIVE_INFINITY } = {}) {
    const text = await readFile(this.eventsPath(sessionId), "utf8");
    return text.split("\n").filter(Boolean).slice(start, start + limit).map((line) => JSON.parse(line));
  }

  async hashEvents(sessionId) {
    const content = await readFile(this.eventsPath(sessionId));
    return `sha256:${createHash("sha256").update(content).digest("hex")}`;
  }

  async finalize(sessionId, analyticsHash) {
    const manifest = await this.readManifest(sessionId);
    manifest.status = "complete";
    manifest.updatedAt = Date.now();
    manifest.eventHash = await this.hashEvents(sessionId);
    manifest.analyticsHash = analyticsHash;
    manifest.manifestHash = sha256({ ...manifest, manifestHash: undefined });
    await this.#atomicJson(this.manifestPath(sessionId), manifest);
    return manifest;
  }

  async verify(sessionId) {
    const manifest = await this.readManifest(sessionId);
    const eventHash = await this.hashEvents(sessionId);
    const errors = [];
    if (eventHash !== manifest.eventHash) errors.push("event hash mismatch");
    if (manifest.manifestHash && manifest.manifestHash !== sha256({ ...manifest, manifestHash: undefined })) errors.push("manifest hash mismatch");
    const events = await this.readEvents(sessionId);
    if (events.length !== manifest.eventCount) errors.push("event count mismatch");
    for (const event of events) errors.push(...validateEvent(event).map((error) => `event ${event.id}: ${error}`));
    return { passed: errors.length === 0, errors, manifest, eventCount: events.length };
  }

  async listSessions() {
    const root = join(this.root, "sessions");
    try {
      const names = await readdir(root);
      const manifests = await Promise.all(names.map(async (name) => {
        try { return await this.readManifest(name); } catch { return undefined; }
      }));
      return manifests.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch { return []; }
  }

  async deleteSession(sessionId) { await rm(this.sessionDir(sessionId), { recursive: true, force: true }); }

  async #atomicJson(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${stableStringify(value)}\n`);
    await rename(temporary, path);
  }
}

export function reduceEvents(events) {
  const state = { trades: [], book: null, metrics: {}, quality: "UNAVAILABLE", lastEventAt: 0 };
  for (const event of events) {
    state.lastEventAt = event.exchangeTimestamp;
    if (event.eventType === "trade") state.trades.push(event.payload);
    else if (event.eventType === "book-snapshot" || event.eventType === "book-update") state.book = event.payload;
    else if (event.eventType === "metrics") state.metrics = { ...state.metrics, ...event.payload };
    else if (event.eventType === "quality") state.quality = event.payload.to ?? event.quality;
  }
  return state;
}
