import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { FileEventLog, normalizedEvent, sha256 } from "./core.mjs";

const RANGE_TOLERANCE_MS = 2_000;

function finite(value, fallback = Number.NaN) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseHyperliquidTime(value) {
  const numeric = finite(value);
  if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) throw new Error(`Invalid Hyperliquid timestamp: ${value}`);
  return parsed;
}

function normalizeSide(value) {
  const normalized = String(value ?? "").toUpperCase();
  if (normalized === "B" || normalized === "BUY") return "buy";
  if (normalized === "A" || normalized === "S" || normalized === "SELL") return "sell";
  throw new Error(`Unsupported Hyperliquid side: ${value}`);
}

function opposite(side) { return side === "buy" ? "sell" : "buy"; }

function isTradeLike(value) {
  return value && typeof value === "object" && value.coin !== undefined && value.px !== undefined && value.sz !== undefined && value.side !== undefined;
}

function eventFill(value) {
  if (isTradeLike(value)) return value;
  if (Array.isArray(value) && value.length >= 2 && isTradeLike(value[1])) return value[1];
  if (value && typeof value === "object" && isTradeLike(value.fill)) return value.fill;
  return undefined;
}

function eventUser(value) {
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  if (value && typeof value === "object" && typeof value.user === "string") return value.user;
  return undefined;
}

function legacyTradeKey(raw) {
  const buyer = raw.side_info?.[0]?.oid ?? raw.users?.[0] ?? "";
  const seller = raw.side_info?.[1]?.oid ?? raw.users?.[1] ?? "";
  return `${raw.time}|${raw.coin}|${raw.hash ?? ""}|${raw.px}|${raw.sz}|${buyer}|${seller}`;
}

function fillTradeKey(raw) {
  if (raw.tid !== undefined && raw.tid !== null) return `${raw.time}|${raw.coin}|${raw.tid}`;
  return legacyTradeKey(raw);
}

function normalizeExecution(raw, metadata = {}) {
  const time = parseHyperliquidTime(raw.time ?? metadata.blockTime);
  const price = finite(raw.px);
  const size = finite(raw.sz);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(size) || size < 0) throw new Error("Invalid Hyperliquid execution price/size");
  const fillSide = normalizeSide(raw.side);
  const aggressorSide = raw.crossed === false ? opposite(fillSide) : fillSide;
  const key = fillTradeKey({ ...raw, time });
  return {
    key,
    coin: String(raw.coin),
    time,
    price,
    size,
    side: aggressorSide,
    tid: raw.tid === undefined ? undefined : String(raw.tid),
    hash: raw.hash === undefined ? undefined : String(raw.hash),
    crossed: raw.crossed,
    user: metadata.user,
    blockNumber: metadata.blockNumber,
    blockTime: metadata.blockTime,
    sourceFormat: metadata.sourceFormat,
  };
}

export function extractHyperliquidRecord(record) {
  if (!record || typeof record !== "object") return { block: undefined, executions: [] };
  if (Array.isArray(record.events)) {
    const blockTime = parseHyperliquidTime(record.block_time ?? record.local_time);
    const parsedBlockNumber = finite(record.block_number);
    const blockNumber = Number.isFinite(parsedBlockNumber) ? parsedBlockNumber : undefined;
    const executions = [];
    for (const rawEvent of record.events) {
      const fill = eventFill(rawEvent);
      if (!fill) continue;
      executions.push(normalizeExecution(fill, {
        user: eventUser(rawEvent),
        blockNumber,
        blockTime,
        sourceFormat: "node_fills_by_block",
      }));
    }
    return { block: { number: blockNumber, time: blockTime }, executions };
  }

  const fill = eventFill(record);
  if (!fill) return { block: undefined, executions: [] };
  return { block: undefined, executions: [normalizeExecution(fill, { sourceFormat: fill.tid !== undefined ? "node_fills" : "node_trades" })] };
}

async function inputFiles(inputPath) {
  const root = resolve(inputPath);
  const info = await stat(root);
  if (info.isFile()) return [root];
  if (!info.isDirectory()) throw new Error(`Hyperliquid input is neither a file nor directory: ${root}`);
  const files = [];
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && !entry.name.startsWith(".")) files.push(path);
    }
  };
  await visit(root);
  return files;
}

function lineStream(path) {
  if (!path.toLowerCase().endsWith(".lz4")) return { stream: createReadStream(path, { encoding: "utf8" }), done: Promise.resolve() };
  const child = spawn(process.env.VEILFLOW_LZ4_BIN || "lz4", ["-dc", path], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolveDone, rejectDone) => {
    child.once("error", (error) => rejectDone(new Error(`Unable to launch lz4 for ${basename(path)}: ${error.message}`)));
    child.once("close", (code) => code === 0 ? resolveDone() : rejectDone(new Error(`lz4 failed for ${basename(path)} with exit ${code}: ${stderr.trim()}`)));
  });
  return { stream: child.stdout, done };
}

async function consumeFile(path, onRecord) {
  const source = lineStream(path);
  const lines = createInterface({ input: source.stream, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed;
      try { parsed = JSON.parse(trimmed); }
      catch (error) { throw new Error(`${basename(path)}:${lineNumber}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
      await onRecord(parsed, { path, lineNumber });
    }
    await source.done;
  } finally { lines.close(); }
}

function qualityEvent(context, exchangeTimestamp, id, reason, payload = {}) {
  return normalizedEvent({
    id: `hyperliquid:${context.venueSymbol}:quality:${id}`,
    venue: "hyperliquid",
    productType: context.productType,
    symbol: context.symbol,
    venueSymbol: context.venueSymbol,
    eventType: "quality",
    exchangeTimestamp,
    receiveTimestamp: Date.now(),
    quality: "GAPPED",
    payload: { from: "FULL", to: "GAPPED", reason, ...payload },
  });
}

function tradeEvent(context, execution, source) {
  return normalizedEvent({
    id: `hyperliquid:${context.venueSymbol}:trade:${execution.key}`,
    venue: "hyperliquid",
    productType: context.productType,
    symbol: context.symbol,
    venueSymbol: context.venueSymbol,
    eventType: "trade",
    exchangeTimestamp: execution.time,
    receiveTimestamp: Date.now(),
    quality: "FULL",
    payload: {
      price: execution.price,
      size: execution.size,
      notional: execution.price * execution.size,
      side: execution.side,
      tradeId: execution.tid,
      hash: execution.hash,
      crossed: execution.crossed,
      user: execution.user,
      blockNumber: execution.blockNumber,
      blockTime: execution.blockTime,
      source,
    },
  });
}

export async function collectHyperliquidNodeHistory({ inputPath, venueSymbol, startTime, endTime, onProgress } = {}) {
  if (!inputPath) throw new Error("inputPath is required");
  if (!venueSymbol) throw new Error("venueSymbol is required");
  const requestedStart = startTime === undefined || startTime === "" ? undefined : parseHyperliquidTime(startTime);
  const requestedEnd = endTime === undefined || endTime === "" ? undefined : parseHyperliquidTime(endTime);
  if (requestedStart !== undefined && requestedEnd !== undefined && requestedEnd < requestedStart) throw new Error("endTime must be greater than or equal to startTime");

  const files = await inputFiles(inputPath);
  if (!files.length) throw new Error("No Hyperliquid node-data files found");
  const executions = new Map();
  const blocks = new Map();
  let legacyRecordCount = 0;
  let selectedRawExecutionCount = 0;

  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const path = files[fileIndex];
    await consumeFile(path, (record) => {
      const parsed = extractHyperliquidRecord(record);
      if (parsed.block?.number !== undefined && Number.isFinite(parsed.block.number)) blocks.set(parsed.block.number, parsed.block.time);
      else if (parsed.executions.length) legacyRecordCount += 1;
      for (const execution of parsed.executions) {
        if (execution.coin.toLowerCase() !== String(venueSymbol).toLowerCase()) continue;
        if (requestedStart !== undefined && execution.time < requestedStart) continue;
        if (requestedEnd !== undefined && execution.time > requestedEnd) continue;
        selectedRawExecutionCount += 1;
        const existing = executions.get(execution.key);
        if (!existing || (existing.crossed !== true && execution.crossed === true)) executions.set(execution.key, execution);
      }
    });
    onProgress?.({ fileIndex: fileIndex + 1, fileCount: files.length, path, executionCount: executions.size, blockCount: blocks.size });
  }

  const orderedBlocks = [...blocks.entries()].sort((left, right) => left[0] - right[0]);
  const blockGaps = [];
  for (let index = 1; index < orderedBlocks.length; index += 1) {
    const previous = orderedBlocks[index - 1][0];
    const current = orderedBlocks[index][0];
    if (current > previous + 1) blockGaps.push({ expected: previous + 1, received: current, time: orderedBlocks[index][1] });
  }

  const rows = [...executions.values()].sort((left, right) => left.time - right.time || left.key.localeCompare(right.key));
  const firstBlockTime = orderedBlocks[0]?.[1];
  const lastBlockTime = orderedBlocks.at(-1)?.[1];
  const rangeGaps = [];
  if (requestedStart !== undefined && firstBlockTime !== undefined && firstBlockTime > requestedStart + RANGE_TOLERANCE_MS) rangeGaps.push({ kind: "start", requested: requestedStart, available: firstBlockTime, time: rows[0]?.time ?? firstBlockTime });
  if (requestedEnd !== undefined && lastBlockTime !== undefined && lastBlockTime < requestedEnd - RANGE_TOLERANCE_MS) rangeGaps.push({ kind: "end", requested: requestedEnd, available: lastBlockTime, time: rows.at(-1)?.time ?? lastBlockTime });
  const continuityVerifiable = orderedBlocks.length > 0 && legacyRecordCount === 0;
  const contiguous = continuityVerifiable && blockGaps.length === 0 && rangeGaps.length === 0;

  return {
    files,
    rows,
    rawExecutionCount: selectedRawExecutionCount,
    blockCount: orderedBlocks.length,
    firstBlock: orderedBlocks[0]?.[0],
    lastBlock: orderedBlocks.at(-1)?.[0],
    firstBlockTime,
    lastBlockTime,
    blockGaps,
    rangeGaps,
    continuityVerifiable,
    contiguous,
    duplicateCount: Math.max(0, selectedRawExecutionCount - rows.length),
  };
}

export async function backfillHyperliquidHistory({ dataDir, inputPath, sessionId, venueSymbol, symbol, productType = "perpetual", startTime, endTime, onProgress } = {}) {
  const context = {
    venueSymbol: String(venueSymbol || "xyz:XYZ100"),
    symbol: String(symbol || venueSymbol || "XYZ100"),
    productType: productType === "spot" ? "spot" : "perpetual",
  };
  const result = await collectHyperliquidNodeHistory({ inputPath, venueSymbol: context.venueSymbol, startTime, endTime, onProgress });
  if (!result.rows.length) throw new Error(`No Hyperliquid executions found for ${context.venueSymbol}`);

  const source = result.continuityVerifiable ? "hyperliquid-node-fills-by-block" : "hyperliquid-legacy-node-history";
  const requestedStart = startTime === undefined || startTime === "" ? result.firstBlockTime ?? result.rows[0].time : parseHyperliquidTime(startTime);
  const requestedEnd = endTime === undefined || endTime === "" ? result.lastBlockTime ?? result.rows.at(-1).time : parseHyperliquidTime(endTime);
  const id = sessionId || `hyperliquid-${context.venueSymbol}-${Math.floor(requestedStart)}-${Math.floor(requestedEnd)}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const log = new FileEventLog(dataDir);
  await log.createSession({
    id,
    venue: "hyperliquid",
    venueSymbol: context.venueSymbol,
    symbol: context.symbol,
    productType: context.productType,
    source,
    requestedStartTime: requestedStart,
    requestedEndTime: requestedEnd,
    contiguous: result.contiguous,
    continuityMode: result.continuityVerifiable ? "block-number" : "unverified-legacy",
    blockCount: result.blockCount,
    firstBlock: result.firstBlock,
    lastBlock: result.lastBlock,
    blockGapCount: result.blockGaps.length,
    rangeGapCount: result.rangeGaps.length,
    inputFileCount: result.files.length,
  });

  const events = [];
  if (!result.continuityVerifiable) events.push(qualityEvent(context, result.rows[0].time, "legacy-unverified", "Hyperliquid legacy node history has no block-by-block continuity evidence"));
  for (const gap of result.blockGaps) events.push(qualityEvent(context, gap.time, `block-gap-${gap.expected}-${gap.received}`, "Hyperliquid node block gap", { expectedBlock: gap.expected, receivedBlock: gap.received }));
  for (const gap of result.rangeGaps) events.push(qualityEvent(context, gap.time, `range-${gap.kind}`, `Hyperliquid requested ${gap.kind} coverage is incomplete`, gap));
  for (const execution of result.rows) events.push(tradeEvent(context, execution, source));
  events.sort((left, right) => left.exchangeTimestamp - right.exchangeTimestamp || left.id.localeCompare(right.id));
  await log.append(id, events);

  const analyticsHash = sha256({ source, venueSymbol: context.venueSymbol, requestedStart, requestedEnd, tradeCount: result.rows.length, rawExecutionCount: result.rawExecutionCount, duplicateCount: result.duplicateCount, blockCount: result.blockCount, firstBlock: result.firstBlock, lastBlock: result.lastBlock, blockGaps: result.blockGaps, rangeGaps: result.rangeGaps });
  const manifest = await log.finalize(id, analyticsHash);
  return { sessionId: id, tradeCount: result.rows.length, manifest, ...result };
}

async function main() {
  const inputPath = process.env.VEILFLOW_HL_INPUT;
  const venueSymbol = process.env.VEILFLOW_VENUE_SYMBOL || "xyz:XYZ100";
  const symbol = process.env.VEILFLOW_SYMBOL || venueSymbol;
  const result = await backfillHyperliquidHistory({
    dataDir: process.env.VEILFLOW_DATA_DIR,
    inputPath,
    sessionId: process.env.VEILFLOW_SESSION_ID,
    venueSymbol,
    symbol,
    productType: process.env.VEILFLOW_PRODUCT_TYPE === "spot" ? "spot" : "perpetual",
    startTime: process.env.VEILFLOW_START_TIME,
    endTime: process.env.VEILFLOW_END_TIME,
    onProgress: ({ fileIndex, fileCount, executionCount, blockCount }) => {
      if (fileIndex === 1 || fileIndex === fileCount || fileIndex % 10 === 0) console.log(`[hyperliquid] files=${fileIndex}/${fileCount} executions=${executionCount} blocks=${blockCount}`);
    },
  });
  console.log(JSON.stringify({ sessionId: result.sessionId, tradeCount: result.tradeCount, duplicateCount: result.duplicateCount, blockCount: result.blockCount, blockGapCount: result.blockGaps.length, continuityVerifiable: result.continuityVerifiable, contiguous: result.contiguous }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
