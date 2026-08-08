import { detectLargeTrades } from "./analytics";
import type { Trade } from "./types";

interface LargeTradeWorkerRequest {
  requestId: number;
  trades: Trade[];
  absoluteFloor: number;
}

self.addEventListener("message", (event: MessageEvent<LargeTradeWorkerRequest>) => {
  const { requestId, trades, absoluteFloor } = event.data;
  const result = detectLargeTrades(trades, absoluteFloor);
  self.postMessage({ requestId, result });
});
