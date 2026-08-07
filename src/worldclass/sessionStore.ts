import { createReplayArchive, validateReplayArchive, type ReplayArchiveV3 } from "./recorder";
import type { MarketDefinition, NormalizedEvent } from "./types";

export interface StoredSessionSummary {
  id: string;
  name: string;
  marketKey: string;
  venue: string;
  productType: string;
  timeframe: string;
  startTime?: number;
  endTime?: number;
  eventCount: number;
  eventHash: string;
  createdAt: number;
  updatedAt: number;
  bytes: number;
}

export interface StoredSession extends StoredSessionSummary {
  archive: ReplayArchiveV3;
}

export interface SessionStore {
  put(session: StoredSession): Promise<void>;
  get(id: string): Promise<StoredSession | undefined>;
  list(): Promise<StoredSessionSummary[]>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

function safeId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "session";
}

export function sessionId(market: MarketDefinition, timeframe: string, createdAt: number, eventHash: string): string {
  return `${safeId(market.key)}-${safeId(timeframe)}-${createdAt}-${eventHash.slice(-12)}`;
}

export function sessionFromArchive(name: string, archive: ReplayArchiveV3): StoredSession {
  validateReplayArchive(archive);
  const raw = JSON.stringify(archive);
  const id = sessionId(archive.market, archive.timeframe, archive.createdAt, archive.eventHash);
  return {
    id,
    name: name.trim() || `${archive.market.displayName} ${archive.timeframe}`,
    marketKey: archive.market.key,
    venue: archive.market.venue,
    productType: archive.market.productType,
    timeframe: archive.timeframe,
    startTime: archive.startTime,
    endTime: archive.endTime,
    eventCount: archive.eventCount,
    eventHash: archive.eventHash,
    createdAt: archive.createdAt,
    updatedAt: Date.now(),
    bytes: new TextEncoder().encode(raw).byteLength,
    archive,
  };
}

export function createStoredSession(
  name: string,
  market: MarketDefinition,
  timeframe: string,
  events: NormalizedEvent[],
  createdAt = Date.now(),
): StoredSession {
  return sessionFromArchive(name, createReplayArchive(market, timeframe, events, createdAt));
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, StoredSession>();

  async put(session: StoredSession): Promise<void> {
    validateReplayArchive(session.archive);
    this.sessions.set(session.id, structuredClone(session));
  }

  async get(id: string): Promise<StoredSession | undefined> {
    const session = this.sessions.get(id);
    return session ? structuredClone(session) : undefined;
  }

  async list(): Promise<StoredSessionSummary[]> {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ archive: _archive, ...summary }) => structuredClone(summary));
  }

  async delete(id: string): Promise<void> { this.sessions.delete(id); }
  async clear(): Promise<void> { this.sessions.clear(); }
}

const DB_NAME = "veilflow-sessions";
const DB_VERSION = 1;
const STORE_NAME = "sessions";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")));
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed")));
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  if (!("indexedDB" in globalThis)) throw new Error("IndexedDB unavailable");
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.addEventListener("upgradeneeded", () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(STORE_NAME)) {
      const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
      store.createIndex("updatedAt", "updatedAt");
      store.createIndex("marketKey", "marketKey");
      store.createIndex("eventHash", "eventHash", { unique: false });
    }
  });
  return requestResult(request);
}

export class IndexedDbSessionStore implements SessionStore {
  private database?: Promise<IDBDatabase>;

  private db(): Promise<IDBDatabase> {
    this.database ??= openDatabase();
    return this.database;
  }

  async put(session: StoredSession): Promise<void> {
    validateReplayArchive(session.archive);
    const database = await this.db();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(structuredClone(session));
    await transactionDone(transaction);
  }

  async get(id: string): Promise<StoredSession | undefined> {
    const database = await this.db();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const result = await requestResult(transaction.objectStore(STORE_NAME).get(id)) as StoredSession | undefined;
    await transactionDone(transaction);
    if (result) validateReplayArchive(result.archive);
    return result;
  }

  async list(): Promise<StoredSessionSummary[]> {
    const database = await this.db();
    const transaction = database.transaction(STORE_NAME, "readonly");
    const rows = await requestResult(transaction.objectStore(STORE_NAME).getAll()) as StoredSession[];
    await transactionDone(transaction);
    return rows.sort((a, b) => b.updatedAt - a.updatedAt).map(({ archive: _archive, ...summary }) => summary);
  }

  async delete(id: string): Promise<void> {
    const database = await this.db();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    await transactionDone(transaction);
  }

  async clear(): Promise<void> {
    const database = await this.db();
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).clear();
    await transactionDone(transaction);
  }
}

let sharedStore: SessionStore | undefined;

export function defaultSessionStore(): SessionStore {
  sharedStore ??= "indexedDB" in globalThis ? new IndexedDbSessionStore() : new MemorySessionStore();
  return sharedStore;
}
