import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backfillHyperliquidHistory, collectHyperliquidNodeHistory, extractHyperliquidRecord } from "../hyperliquidHistory.mjs";

function fill({ coin = "xyz:XYZ100", tid = 11, time = 1_750_000_000_000, side = "B", crossed = true, px = "101.5", sz = "2" } = {}) {
  return {
    coin,
    px,
    sz,
    side,
    time,
    startPosition: "0",
    dir: side === "B" ? "Open Long" : "Open Short",
    closedPnl: "0",
    hash: `0x${String(tid).padStart(64, "0")}`,
    oid: tid * 10,
    crossed,
    fee: "0.01",
    tid,
    feeToken: "USDC",
  };
}

function block(number, time, events) {
  return { local_time: new Date(time + 25).toISOString(), block_time: new Date(time).toISOString(), block_number: number, events };
}

test("block fills collapse maker/taker copies into one aggressor execution", () => {
  const time = 1_750_000_000_000;
  const parsed = extractHyperliquidRecord(block(100, time, [
    ["0xbuyer", fill({ tid: 7, time, side: "B", crossed: true })],
    ["0xseller", fill({ tid: 7, time, side: "A", crossed: false })],
  ]));
  assert.equal(parsed.block.number, 100);
  assert.equal(parsed.executions.length, 2);
  assert.equal(parsed.executions[0].key, parsed.executions[1].key);
  assert.equal(parsed.executions[0].side, "buy");
  assert.equal(parsed.executions[1].side, "buy");
});

test("collector verifies block continuity and deduplicates fills per requested coin", async () => {
  const root = await mkdtemp(join(tmpdir(), "veilflow-hl-"));
  try {
    const start = 1_750_000_000_000;
    const rows = [
      block(500, start, [
        ["0xbuyer", fill({ tid: 1, time: start, crossed: true })],
        ["0xseller", fill({ tid: 1, time: start, side: "A", crossed: false })],
        ["0xother", fill({ coin: "BTC", tid: 9, time: start, px: "100000", sz: "0.1" })],
      ]),
      block(501, start + 100, []),
      block(502, start + 200, [["0xseller", fill({ tid: 2, time: start + 200, side: "A", crossed: true, px: "101", sz: "3" })]]),
    ];
    await writeFile(join(root, "14"), rows.map((row) => JSON.stringify(row)).join("\n"));
    const result = await collectHyperliquidNodeHistory({ inputPath: root, venueSymbol: "xyz:XYZ100" });
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].side, "buy");
    assert.equal(result.rows[1].side, "sell");
    assert.equal(result.rows[0].price * result.rows[0].size, 203);
    assert.equal(result.blockCount, 3);
    assert.equal(result.blockGaps.length, 0);
    assert.equal(result.continuityVerifiable, true);
    assert.equal(result.contiguous, true);
    assert.equal(result.duplicateCount, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing Hyperliquid block becomes explicit GAPPED quality evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "veilflow-hl-gap-"));
  try {
    const start = 1_750_000_000_000;
    await writeFile(join(root, "15"), [
      block(700, start, [["0xa", fill({ tid: 3, time: start })]]),
      block(702, start + 200, [["0xb", fill({ tid: 4, time: start + 200 })]]),
    ].map((row) => JSON.stringify(row)).join("\n"));
    const dataDir = join(root, "store");
    const result = await backfillHyperliquidHistory({ dataDir, inputPath: join(root, "15"), venueSymbol: "xyz:XYZ100", symbol: "XYZ100" });
    assert.equal(result.contiguous, false);
    assert.equal(result.blockGaps.length, 1);
    const events = (await readFile(join(dataDir, "sessions", result.sessionId, "events.ndjson"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(events.some((event) => event.eventType === "quality" && event.quality === "GAPPED" && event.payload.reason === "Hyperliquid node block gap"));
    assert.equal(events.filter((event) => event.eventType === "trade").length, 2);
    assert.ok(events.filter((event) => event.eventType === "trade").every((event) => event.sequence === undefined));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy node trades remain usable but never claim verified continuity", async () => {
  const root = await mkdtemp(join(tmpdir(), "veilflow-hl-legacy-"));
  try {
    const time = "2026-08-08T22:00:00.123Z";
    await writeFile(join(root, "legacy"), JSON.stringify({
      coin: "xyz:XYZ100",
      side: "B",
      time,
      px: "100.25",
      sz: "4",
      hash: "0xabc",
      trade_dir_override: "Na",
      side_info: [{ oid: 10 }, { oid: 11 }],
    }));
    const dataDir = join(root, "store");
    const result = await backfillHyperliquidHistory({ dataDir, inputPath: join(root, "legacy"), venueSymbol: "xyz:XYZ100" });
    assert.equal(result.continuityVerifiable, false);
    assert.equal(result.contiguous, false);
    const events = (await readFile(join(dataDir, "sessions", result.sessionId, "events.ndjson"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events[0].eventType, "quality");
    assert.equal(events[0].quality, "GAPPED");
    assert.equal(events.at(-1).payload.side, "buy");
  } finally { await rm(root, { recursive: true, force: true }); }
});
