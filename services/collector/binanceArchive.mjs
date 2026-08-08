import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

const BINANCE_DATA_ROOT = "https://data.binance.vision/data";
const DAY_MS = 86_400_000;
const ZIP_LOCAL_FILE = 0x04034b50;
const ZIP_CENTRAL_FILE = 0x02014b50;
const ZIP_END = 0x06054b50;

function utcDayStart(timestamp) {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function dateToken(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function normalizeArchiveTimestamp(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) throw new Error(`Invalid Binance archive timestamp ${value}`);
  return raw >= 100_000_000_000_000 ? Math.floor(raw / 1_000) : Math.floor(raw);
}

export function binanceArchiveUrl(symbol, productType, timestamp) {
  const venueSymbol = String(symbol).toUpperCase();
  const date = dateToken(timestamp);
  const productPath = productType === "perpetual" ? "futures/um" : "spot";
  return `${BINANCE_DATA_ROOT}/${productPath}/daily/aggTrades/${venueSymbol}/${venueSymbol}-aggTrades-${date}.zip`;
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END) return offset;
  }
  throw new Error("Invalid ZIP: end-of-central-directory record was not found");
}

export function unzipSingleFile(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount < 1) throw new Error("Invalid ZIP: no files");
  if (buffer.readUInt32LE(centralOffset) !== ZIP_CENTRAL_FILE) throw new Error("Invalid ZIP: central-directory entry missing");

  const compression = buffer.readUInt16LE(centralOffset + 10);
  const compressedSize = buffer.readUInt32LE(centralOffset + 20);
  const uncompressedSize = buffer.readUInt32LE(centralOffset + 24);
  const fileNameLength = buffer.readUInt16LE(centralOffset + 28);
  const extraLength = buffer.readUInt16LE(centralOffset + 30);
  const commentLength = buffer.readUInt16LE(centralOffset + 32);
  const localOffset = buffer.readUInt32LE(centralOffset + 42);
  const fileName = buffer.subarray(centralOffset + 46, centralOffset + 46 + fileNameLength).toString("utf8");
  if (!fileName || fileName.endsWith("/")) throw new Error("Invalid ZIP: first entry is not a file");
  if (fileNameLength + extraLength + commentLength + centralOffset + 46 > buffer.length) throw new Error("Invalid ZIP: central-directory bounds");
  if (buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_FILE) throw new Error("Invalid ZIP: local-file entry missing");

  const localNameLength = buffer.readUInt16LE(localOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localOffset + 28);
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
  let body;
  if (compression === 0) body = Buffer.from(compressed);
  else if (compression === 8) body = inflateRawSync(compressed);
  else throw new Error(`Unsupported ZIP compression method ${compression}`);
  if (uncompressedSize && body.length !== uncompressedSize) throw new Error(`ZIP size mismatch: expected ${uncompressedSize}, received ${body.length}`);
  return { fileName, body };
}

function bool(value) {
  return String(value).trim().toLowerCase() === "true";
}

export function parseBinanceAggTradeCsv(csv) {
  const rows = [];
  const lines = String(csv).split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = line.split(",");
    if (!/^\d+$/.test(fields[0]?.trim() ?? "")) continue;
    if (fields.length < 7) throw new Error(`Malformed Binance aggTrades CSV row: ${line.slice(0, 160)}`);
    const row = {
      a: Number(fields[0]),
      p: String(fields[1]),
      q: String(fields[2]),
      f: Number(fields[3]),
      l: Number(fields[4]),
      T: normalizeArchiveTimestamp(fields[5]),
      m: bool(fields[6]),
    };
    if (![row.a, row.f, row.l, row.T, Number(row.p), Number(row.q)].every(Number.isFinite)) {
      throw new Error(`Invalid Binance aggTrades CSV values: ${line.slice(0, 160)}`);
    }
    rows.push(row);
  }
  return rows.sort((left, right) => left.a - right.a);
}

function expectedChecksum(text) {
  const match = String(text).trim().match(/^([a-fA-F0-9]{64})(?:\s+|$)/);
  if (!match) throw new Error("Invalid Binance archive CHECKSUM payload");
  return match[1].toLowerCase();
}

function actualChecksum(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function fetchArchiveDay({ symbol, productType, dayStart, fetchImpl }) {
  const url = binanceArchiveUrl(symbol, productType, dayStart);
  const response = await fetchImpl(url, { headers: { Accept: "application/zip" } });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Binance archive ${response.status} for ${url}`);
  const archive = Buffer.from(await response.arrayBuffer());

  const checksumResponse = await fetchImpl(`${url}.CHECKSUM`, { headers: { Accept: "text/plain" } });
  if (!checksumResponse.ok) throw new Error(`Binance archive checksum ${checksumResponse.status} for ${url}.CHECKSUM`);
  const expected = expectedChecksum(await checksumResponse.text());
  const actual = actualChecksum(archive);
  if (actual !== expected) throw new Error(`Binance archive checksum mismatch for ${dateToken(dayStart)}`);

  const extracted = unzipSingleFile(archive);
  return {
    url,
    checksum: actual,
    fileName: extracted.fileName,
    rows: parseBinanceAggTradeCsv(extracted.body.toString("utf8")),
  };
}

export async function collectBinanceArchiveTrades({
  symbol,
  productType = "spot",
  startTime,
  endTime,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  onProgress,
} = {}) {
  if (!symbol) throw new Error("symbol is required");
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  const start = Number(startTime);
  const end = Number(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end < start) throw new Error("A valid startTime/endTime range is required");

  const today = utcDayStart(now);
  const rowsById = new Map();
  const coveredRanges = [];
  const missingRanges = [];
  const archives = [];

  for (let day = utcDayStart(start); day <= utcDayStart(end); day += DAY_MS) {
    const rangeStart = Math.max(start, day);
    const rangeEnd = Math.min(end, day + DAY_MS - 1);
    if (day >= today) {
      missingRanges.push({ startTime: rangeStart, endTime: rangeEnd, reason: "current-day archive not expected yet" });
      continue;
    }

    const archive = await fetchArchiveDay({ symbol, productType, dayStart: day, fetchImpl });
    if (!archive) {
      missingRanges.push({ startTime: rangeStart, endTime: rangeEnd, reason: "archive unavailable" });
      onProgress?.({ day, state: "missing", rowCount: rowsById.size });
      continue;
    }
    for (const row of archive.rows) {
      if (row.T >= rangeStart && row.T <= rangeEnd) rowsById.set(row.a, row);
    }
    coveredRanges.push({ startTime: rangeStart, endTime: rangeEnd, source: archive.url, checksum: archive.checksum });
    archives.push({ date: dateToken(day), url: archive.url, checksum: archive.checksum, fileName: archive.fileName, eventCount: archive.rows.length });
    onProgress?.({ day, state: "loaded", rowCount: rowsById.size, archive });
  }

  return {
    rows: [...rowsById.values()].sort((left, right) => left.a - right.a),
    coveredRanges,
    missingRanges,
    archives,
  };
}
