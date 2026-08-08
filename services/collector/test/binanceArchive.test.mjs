import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import test from "node:test";
import {
  binanceArchiveUrl,
  collectBinanceArchiveTrades,
  parseBinanceAggTradeCsv,
  unzipSingleFile,
} from "../binanceArchive.mjs";

function zipSingleFile(fileName, content) {
  const name = Buffer.from(fileName);
  const body = Buffer.from(content);
  const compressed = deflateRawSync(body);

  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(0, 10);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(0, 18);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(0, 12);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length + compressed.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([local, compressed, central, eocd]);
}

function response(body, status = 200) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
    text: async () => buffer.toString("utf8"),
  };
}

test("archive URLs distinguish spot and USD-M perpetual data", () => {
  const day = Date.UTC(2026, 7, 8);
  assert.equal(binanceArchiveUrl("btcusdt", "spot", day), "https://data.binance.vision/data/spot/daily/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2026-08-08.zip");
  assert.equal(binanceArchiveUrl("BTCUSDT", "perpetual", day), "https://data.binance.vision/data/futures/um/daily/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2026-08-08.zip");
});

test("ZIP extraction and CSV parsing preserve aggressor semantics and normalize spot microseconds", () => {
  const csv = [
    "Aggregate tradeId,Price,Quantity,First tradeId,Last tradeId,Timestamp,Was the buyer the maker,Was the trade the best price match",
    "10,100.5,0.25,20,20,1735689600010866,False,True",
    "11,100.4,0.50,21,22,1735689600011866,True,True",
  ].join("\n");
  const archive = zipSingleFile("BTCUSDT-aggTrades-2025-01-01.csv", csv);
  const extracted = unzipSingleFile(archive);
  const rows = parseBinanceAggTradeCsv(extracted.body.toString("utf8"));
  assert.equal(extracted.fileName, "BTCUSDT-aggTrades-2025-01-01.csv");
  assert.equal(rows[0].T, 1_735_689_600_010);
  assert.equal(rows[0].m, false);
  assert.equal(rows[1].m, true);
});

test("archive collector verifies CHECKSUM and returns missing current-day range for REST stitching", async () => {
  const day = Date.UTC(2026, 7, 8);
  const nextDay = day + 86_400_000;
  const csv = [
    `100,65000.0,0.1,200,200,${day + 1_000},false,true`,
    `101,65001.0,0.2,201,201,${day + 2_000},true,true`,
  ].join("\n");
  const archive = zipSingleFile("BTCUSDT-aggTrades-2026-08-08.csv", csv);
  const checksum = createHash("sha256").update(archive).digest("hex");
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith(".CHECKSUM")) return response(`${checksum}  BTCUSDT-aggTrades-2026-08-08.zip\n`);
    return response(archive);
  };

  const result = await collectBinanceArchiveTrades({
    symbol: "BTCUSDT",
    productType: "spot",
    startTime: day,
    endTime: nextDay + 3_000,
    now: nextDay + 60_000,
    fetchImpl,
  });
  assert.deepEqual(result.rows.map((row) => row.a), [100, 101]);
  assert.equal(result.coveredRanges.length, 1);
  assert.equal(result.missingRanges.length, 1);
  assert.match(result.missingRanges[0].reason, /current-day/);
  assert.equal(result.archives[0].checksum, checksum);
  assert.equal(calls.length, 2);
});

test("checksum mismatch rejects corrupted archive evidence", async () => {
  const day = Date.UTC(2026, 7, 8);
  const archive = zipSingleFile("BTCUSDT-aggTrades-2026-08-08.csv", `1,1,1,1,1,${day + 1_000},false,true\n`);
  const fetchImpl = async (url) => String(url).endsWith(".CHECKSUM")
    ? response(`${"0".repeat(64)}  BTCUSDT-aggTrades-2026-08-08.zip\n`)
    : response(archive);
  await assert.rejects(() => collectBinanceArchiveTrades({ symbol: "BTCUSDT", startTime: day, endTime: day + 2_000, now: day + 86_400_000, fetchImpl }), /checksum mismatch/);
});
