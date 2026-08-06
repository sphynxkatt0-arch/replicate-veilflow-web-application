(() => {
  const NativeWebSocket = window.WebSocket;
  const BINANCE_REST = [
    "https://api.binance.com/api/v3",
    "https://api1.binance.com/api/v3",
    "https://data-api.binance.vision/api/v3",
  ];

  const fetchSnapshot = async (symbol) => {
    let lastError;
    for (const host of BINANCE_REST) {
      try {
        const response = await fetch(`${host}/depth?symbol=${symbol}&limit=1000`, { cache: "no-store" });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return await response.json();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Binance depth snapshot failed");
  };

  const parseSymbol = (url) => {
    const match = String(url).match(/streams=([^&]+)/i);
    if (!match) return null;
    const streams = decodeURIComponent(match[1]);
    const symbolMatch = streams.match(/(?:^|\/)([a-z0-9]+)@depth(?:20)?@100ms/i);
    return symbolMatch ? symbolMatch[1].toUpperCase() : null;
  };

  const rewriteUrl = (url) => String(url).replace(/@depth20@100ms/gi, "@depth@100ms");
  const createBook = () => ({ bids: new Map(), asks: new Map(), lastUpdateId: 0 });

  const applyLevels = (side, levels) => {
    for (const [price, quantity] of levels || []) {
      const size = Number(quantity);
      if (!Number.isFinite(size) || size === 0) side.delete(price);
      else side.set(price, quantity);
    }
  };

  const sorted = (side, descending) => [...side.entries()]
    .sort((a, b) => descending ? Number(b[0]) - Number(a[0]) : Number(a[0]) - Number(b[0]))
    .slice(0, 100);

  function SynchronizedWebSocket(url, protocols) {
    const symbol = parseSymbol(url);
    if (!symbol) return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);

    const socket = protocols === undefined
      ? new NativeWebSocket(rewriteUrl(url))
      : new NativeWebSocket(rewriteUrl(url), protocols);
    const book = createBook();
    const buffered = [];
    let synced = false;
    let resyncing = false;
    let consumerOnMessage = null;

    const emit = (event, payload) => {
      const envelope = JSON.parse(event.data);
      envelope.data = {
        ...payload,
        e: "depthUpdate",
        E: payload.E || Date.now(),
        s: symbol,
        b: sorted(book.bids, true),
        a: sorted(book.asks, false),
        bids: sorted(book.bids, true),
        asks: sorted(book.asks, false),
        localBookState: "synced",
      };
      consumerOnMessage?.call(socket, new MessageEvent("message", { data: JSON.stringify(envelope) }));
    };

    const applyUpdate = (payload) => {
      applyLevels(book.bids, payload.b);
      applyLevels(book.asks, payload.a);
      book.lastUpdateId = Number(payload.u);
    };

    const synchronize = async () => {
      if (resyncing) return;
      resyncing = true;
      synced = false;
      try {
        const snapshot = await fetchSnapshot(symbol);
        book.bids.clear();
        book.asks.clear();
        applyLevels(book.bids, snapshot.bids);
        applyLevels(book.asks, snapshot.asks);
        book.lastUpdateId = Number(snapshot.lastUpdateId);

        buffered.sort((a, b) => Number(a.payload.U) - Number(b.payload.U));
        while (buffered.length && Number(buffered[0].payload.u) <= book.lastUpdateId) buffered.shift();
        const first = buffered[0]?.payload;
        if (first && !(Number(first.U) <= book.lastUpdateId + 1 && Number(first.u) >= book.lastUpdateId + 1)) {
          buffered.length = 0;
          throw new Error("Binance initial depth sequence gap");
        }

        synced = true;
        while (buffered.length) {
          const entry = buffered.shift();
          const payload = entry.payload;
          if (Number(payload.u) <= book.lastUpdateId) continue;
          if (Number(payload.U) > book.lastUpdateId + 1) {
            buffered.unshift(entry);
            synced = false;
            throw new Error("Binance buffered depth sequence gap");
          }
          applyUpdate(payload);
          emit(entry.event, payload);
        }
      } catch (error) {
        console.warn("Binance local book resync", error);
        window.setTimeout(synchronize, 1000);
      } finally {
        resyncing = false;
      }
    };

    socket.addEventListener("message", (event) => {
      let envelope;
      try { envelope = JSON.parse(event.data); } catch { return; }
      const payload = envelope.data || envelope;
      if (payload.e !== "depthUpdate" || payload.U === undefined || payload.u === undefined) {
        consumerOnMessage?.call(socket, event);
        return;
      }

      if (!synced) {
        buffered.push({ event, payload });
        if (!resyncing) synchronize();
        return;
      }

      const firstId = Number(payload.U);
      const finalId = Number(payload.u);
      if (finalId <= book.lastUpdateId) return;
      if (firstId > book.lastUpdateId + 1) {
        buffered.length = 0;
        buffered.push({ event, payload });
        synchronize();
        return;
      }

      applyUpdate(payload);
      emit(event, payload);
    });

    Object.defineProperty(socket, "onmessage", {
      configurable: true,
      enumerable: true,
      get: () => consumerOnMessage,
      set: (handler) => { consumerOnMessage = typeof handler === "function" ? handler : null; },
    });

    return socket;
  }

  SynchronizedWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(SynchronizedWebSocket, NativeWebSocket);
  for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
    Object.defineProperty(SynchronizedWebSocket, key, { value: NativeWebSocket[key] });
  }
  window.WebSocket = SynchronizedWebSocket;
})();
