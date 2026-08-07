import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256, stableStringify } from "./core.mjs";

function safeId(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "document";
}

export class JsonDocumentStore {
  constructor(root, namespace) {
    this.root = join(root, "control", safeId(namespace));
  }

  path(id) { return join(this.root, `${safeId(id)}.json`); }

  async put(id, document) {
    const normalized = { ...document, id: String(id), updatedAt: Date.now() };
    normalized.hash = sha256({ ...normalized, hash: undefined });
    await this.#atomic(this.path(id), normalized);
    return normalized;
  }

  async get(id) {
    try {
      const document = JSON.parse(await readFile(this.path(id), "utf8"));
      const expected = sha256({ ...document, hash: undefined });
      if (document.hash !== expected) throw new Error(`${id} integrity hash mismatch`);
      return document;
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async list() {
    try {
      const files = (await readdir(this.root)).filter((name) => name.endsWith(".json"));
      const documents = await Promise.all(files.map((file) => this.get(file.slice(0, -5))));
      return documents.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async delete(id) { await rm(this.path(id), { force: true }); }

  async #atomic(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${stableStringify(value)}\n`);
    await rename(temporary, path);
  }
}

export class TelemetryStore {
  constructor(root) { this.path = join(root, "telemetry", "events.ndjson"); }

  async append(envelope) {
    const events = Array.isArray(envelope?.events) ? envelope.events : [];
    const accepted = events.filter((event) => event && typeof event.kind === "string" && Number.isFinite(event.at)).slice(0, 5_000);
    if (!accepted.length) return { accepted: 0 };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, accepted.map((event) => `${stableStringify({ ...event, receivedAt: Date.now() })}\n`).join(""));
    return { accepted: accepted.length };
  }

  async read(limit = 1_000) {
    try {
      const lines = (await readFile(this.path, "utf8")).split("\n").filter(Boolean);
      return lines.slice(-Math.max(0, Math.min(limit, 100_000))).map((line) => JSON.parse(line));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async summary() {
    const events = await this.read(100_000);
    const kinds = {};
    for (const event of events) kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
    return {
      eventCount: events.length,
      kinds,
      firstAt: events[0]?.at,
      lastAt: events.at(-1)?.at,
      errorCount: events.filter((event) => ["javascript-error", "react-error", "api-failure", "websocket-failure"].includes(event.kind)).length,
      gapCount: events.filter((event) => event.kind === "sequence-gap").length,
      reconnectCount: events.filter((event) => event.kind === "reconnect").length,
    };
  }
}

export function validateWorkspaceDocument(workspace) {
  const errors = [];
  if (!workspace || typeof workspace !== "object") return ["workspace object is required"];
  if (workspace.schemaVersion !== 1) errors.push("unsupported workspace schema");
  if (!workspace.id || typeof workspace.id !== "string") errors.push("workspace id is required");
  if (!workspace.name || typeof workspace.name !== "string") errors.push("workspace name is required");
  if (!Array.isArray(workspace.panels) || workspace.panels.length === 0) errors.push("workspace panels are required");
  if ((workspace.panels?.length ?? 0) > 24) errors.push("workspace panel limit exceeded");
  return errors;
}

export function evaluateAlert(rule, context) {
  const value = Number(context?.[rule.metric]);
  const threshold = Number(rule.threshold);
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) return false;
  if (rule.operator === ">") return value > threshold;
  if (rule.operator === ">=") return value >= threshold;
  if (rule.operator === "<") return value < threshold;
  if (rule.operator === "<=") return value <= threshold;
  if (rule.operator === "==") return value === threshold;
  return false;
}
