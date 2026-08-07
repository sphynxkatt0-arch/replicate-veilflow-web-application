export type TelemetryKind =
  | "javascript-error"
  | "react-error"
  | "websocket-failure"
  | "reconnect"
  | "sequence-gap"
  | "book-resync"
  | "stale-duration"
  | "api-failure"
  | "long-task"
  | "memory"
  | "chart-fps"
  | "replay-seek"
  | "quality-transition"
  | "synthetic-check";

export interface TelemetryEvent {
  id: string;
  kind: TelemetryKind;
  at: number;
  market?: string;
  venue?: string;
  value?: number;
  unit?: string;
  detail?: string;
  tags?: Record<string, string | number | boolean>;
  buildSha?: string;
}

export interface TelemetrySummary {
  eventCount: number;
  errorCount: number;
  reconnectCount: number;
  gapCount: number;
  staleDurationMs: number;
  averageFps?: number;
  p95ReplaySeekMs?: number;
  maxLongTaskMs?: number;
}

function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

export function summarizeTelemetry(events: readonly TelemetryEvent[]): TelemetrySummary {
  const fps = events.filter((event) => event.kind === "chart-fps" && event.value !== undefined).map((event) => event.value as number);
  const seek = events.filter((event) => event.kind === "replay-seek" && event.value !== undefined).map((event) => event.value as number);
  const longTasks = events.filter((event) => event.kind === "long-task" && event.value !== undefined).map((event) => event.value as number);
  return {
    eventCount: events.length,
    errorCount: events.filter((event) => event.kind === "javascript-error" || event.kind === "react-error" || event.kind === "api-failure" || event.kind === "websocket-failure").length,
    reconnectCount: events.filter((event) => event.kind === "reconnect").length,
    gapCount: events.filter((event) => event.kind === "sequence-gap").length,
    staleDurationMs: events.filter((event) => event.kind === "stale-duration").reduce((sum, event) => sum + Math.max(0, event.value ?? 0), 0),
    averageFps: fps.length ? fps.reduce((sum, value) => sum + value, 0) / fps.length : undefined,
    p95ReplaySeekMs: percentile(seek, 0.95),
    maxLongTaskMs: longTasks.length ? Math.max(...longTasks) : undefined,
  };
}

export class TelemetryBuffer {
  private readonly events: TelemetryEvent[] = [];
  private counter = 0;

  constructor(private readonly maxEvents = 10_000, private readonly buildSha?: string) {}

  record(event: Omit<TelemetryEvent, "id" | "at" | "buildSha"> & { at?: number }): TelemetryEvent {
    const item: TelemetryEvent = {
      ...event,
      id: `${event.kind}-${event.at ?? Date.now()}-${this.counter += 1}`,
      at: event.at ?? Date.now(),
      buildSha: this.buildSha,
    };
    this.events.push(item);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    return item;
  }

  snapshot(): TelemetryEvent[] { return this.events.slice(); }
  summary(): TelemetrySummary { return summarizeTelemetry(this.events); }
  clear(): void { this.events.length = 0; }

  drain(limit = this.events.length): TelemetryEvent[] {
    return this.events.splice(0, Math.max(0, Math.min(limit, this.events.length)));
  }
}

export interface TelemetryTransport {
  send(events: TelemetryEvent[]): Promise<void>;
}

export class FetchTelemetryTransport implements TelemetryTransport {
  constructor(private readonly endpoint = "/api/telemetry") {}

  async send(events: TelemetryEvent[]): Promise<void> {
    if (!events.length) return;
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, sentAt: Date.now(), events }),
      keepalive: true,
    });
    if (!response.ok) throw new Error(`Telemetry upload failed: ${response.status}`);
  }
}

export interface TelemetryController {
  buffer: TelemetryBuffer;
  stop: () => void;
  flush: () => Promise<void>;
}

export function installBrowserTelemetry(
  transport?: TelemetryTransport,
  buildSha?: string,
  flushIntervalMs = 15_000,
): TelemetryController {
  const buffer = new TelemetryBuffer(10_000, buildSha);
  const cleanup: Array<() => void> = [];

  const onError = (event: ErrorEvent) => {
    buffer.record({ kind: "javascript-error", detail: event.message, tags: { filename: event.filename, line: event.lineno, column: event.colno } });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    buffer.record({ kind: "javascript-error", detail: event.reason instanceof Error ? event.reason.message : String(event.reason), tags: { source: "unhandledrejection" } });
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  cleanup.push(() => window.removeEventListener("error", onError), () => window.removeEventListener("unhandledrejection", onRejection));

  if ("PerformanceObserver" in window) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= 50) buffer.record({ kind: "long-task", value: entry.duration, unit: "ms", detail: entry.name });
        }
      });
      observer.observe({ type: "longtask", buffered: true });
      cleanup.push(() => observer.disconnect());
    } catch { /* unsupported entry type */ }
  }

  const memoryTimer = window.setInterval(() => {
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    if (memory) buffer.record({ kind: "memory", value: memory.usedJSHeapSize, unit: "bytes" });
  }, 30_000);
  cleanup.push(() => window.clearInterval(memoryTimer));

  const flush = async () => {
    if (!transport) return;
    const events = buffer.drain(500);
    try { await transport.send(events); }
    catch {
      for (const event of events) buffer.record({ ...event, id: undefined as never, at: event.at });
    }
  };
  const flushTimer = window.setInterval(() => { void flush(); }, flushIntervalMs);
  cleanup.push(() => window.clearInterval(flushTimer));

  return {
    buffer,
    flush,
    stop: () => cleanup.splice(0).forEach((dispose) => dispose()),
  };
}
