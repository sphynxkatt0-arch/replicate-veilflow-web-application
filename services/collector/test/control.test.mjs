import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonDocumentStore, TelemetryStore, evaluateAlert, validateWorkspaceDocument } from "../control.mjs";

test("cloud workspace documents are hashed and corruption-safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "veilflow-control-"));
  const store = new JsonDocumentStore(root, "workspaces");
  const workspace = await store.put("primary", { schemaVersion: 1, name: "Primary", panels: [{ id: "chart" }] });
  assert.match(workspace.hash, /^sha256:/);
  assert.equal((await store.get("primary")).name, "Primary");
  assert.equal((await store.list()).length, 1);
  await store.delete("primary");
  assert.equal(await store.get("primary"), undefined);
});

test("workspace validation blocks incomplete layouts", () => {
  assert.deepEqual(validateWorkspaceDocument({ schemaVersion: 1, id: "x", name: "X", panels: [{ id: "chart" }] }), []);
  assert.ok(validateWorkspaceDocument({ schemaVersion: 1, id: "x", name: "X", panels: [] }).length > 0);
});

test("telemetry store retains operational evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "veilflow-telemetry-"));
  const store = new TelemetryStore(root);
  assert.deepEqual(await store.append({ events: [{ kind: "sequence-gap", at: 1 }, { kind: "reconnect", at: 2 }] }), { accepted: 2 });
  assert.deepEqual(await store.summary(), {
    eventCount: 2,
    kinds: { "sequence-gap": 1, reconnect: 1 },
    firstAt: 1,
    lastAt: 2,
    errorCount: 0,
    gapCount: 1,
    reconnectCount: 1,
  });
});

test("alert evaluator handles thresholds deterministically", () => {
  assert.equal(evaluateAlert({ metric: "spreadBps", operator: ">", threshold: 10 }, { spreadBps: 11 }), true);
  assert.equal(evaluateAlert({ metric: "spreadBps", operator: "<=", threshold: 10 }, { spreadBps: 11 }), false);
  assert.equal(evaluateAlert({ metric: "missing", operator: ">", threshold: 10 }, {}), false);
});
