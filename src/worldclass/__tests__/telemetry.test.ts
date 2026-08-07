import { describe, expect, it } from "vitest";
import { TelemetryBuffer, summarizeTelemetry } from "../telemetry";

describe("telemetry", () => {
  it("aggregates reliability and performance evidence", () => {
    const events = [
      { id: "1", kind: "chart-fps" as const, at: 1, value: 60 },
      { id: "2", kind: "chart-fps" as const, at: 2, value: 30 },
      { id: "3", kind: "replay-seek" as const, at: 3, value: 900 },
      { id: "4", kind: "replay-seek" as const, at: 4, value: 100 },
      { id: "5", kind: "sequence-gap" as const, at: 5 },
      { id: "6", kind: "stale-duration" as const, at: 6, value: 1_500 },
      { id: "7", kind: "javascript-error" as const, at: 7 },
      { id: "8", kind: "long-task" as const, at: 8, value: 220 },
    ];
    expect(summarizeTelemetry(events)).toMatchObject({
      eventCount: 8,
      errorCount: 1,
      gapCount: 1,
      staleDurationMs: 1_500,
      averageFps: 45,
      maxLongTaskMs: 220,
    });
  });

  it("bounds and drains telemetry deterministically", () => {
    const buffer = new TelemetryBuffer(2, "abc");
    buffer.record({ kind: "reconnect", at: 1 });
    buffer.record({ kind: "sequence-gap", at: 2 });
    buffer.record({ kind: "chart-fps", at: 3, value: 60 });
    expect(buffer.snapshot().map((event) => event.at)).toEqual([2, 3]);
    expect(buffer.drain(1)).toHaveLength(1);
    expect(buffer.snapshot()).toHaveLength(1);
  });
});
