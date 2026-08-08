import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256, stableStringify } from "./core.mjs";

function cacheId(value) {
  return sha256(value).replace(/^sha256:/, "");
}

export function footprintCacheKey({ sessionId, eventHash, timeframe, tickSize, options = {} }) {
  return cacheId({
    schemaVersion: 1,
    sessionId,
    eventHash,
    timeframe,
    tickSize: Number(tickSize),
    startTime: options.startTime ?? null,
    endTime: options.endTime ?? null,
    imbalanceRatio: options.imbalanceRatio ?? null,
    minVolume: options.minVolume ?? null,
    valueAreaRatio: options.valueAreaRatio ?? null,
  });
}

export class FootprintStore {
  constructor(root) {
    this.root = root;
  }

  cacheDir(sessionId) {
    return join(this.root, "sessions", sessionId, "footprints");
  }

  cachePath(sessionId, key) {
    return join(this.cacheDir(sessionId), `${key}.json`);
  }

  async get(sessionId, key) {
    try {
      const value = JSON.parse(await readFile(this.cachePath(sessionId, key), "utf8"));
      if (value?.schemaVersion !== 1 || value?.key !== key) return undefined;
      return value;
    } catch {
      return undefined;
    }
  }

  async put(sessionId, key, payload) {
    const path = this.cachePath(sessionId, key);
    await mkdir(dirname(path), { recursive: true });
    const document = {
      schemaVersion: 1,
      key,
      sessionId,
      createdAt: Date.now(),
      ...payload,
    };
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${stableStringify(document)}\n`);
    await rename(temporary, path);
    return document;
  }
}
