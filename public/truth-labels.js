(() => {
  const MARKET_IDENTITIES = {
    NQ: {
      option: "XYZ100 PERP · Hyperliquid",
      short: "XYZ100 PERP",
      title: "Nasdaq-100 perpetual proxy",
      badge: "PROXY · NOT CME NQ",
      detail: "Hyperliquid Trade[XYZ] XYZ100 perpetual. This is not CME Nasdaq-100 futures order flow.",
    },
    ES: {
      option: "SP500 PERP · Hyperliquid",
      short: "SP500 PERP",
      title: "S&P 500 perpetual proxy",
      badge: "PROXY · NOT CME ES",
      detail: "Hyperliquid Trade[XYZ] SP500 perpetual. This is not CME E-mini S&P 500 futures order flow.",
    },
    BTC: {
      option: "BTCUSDT SPOT · Binance",
      short: "BTCUSDT SPOT",
      title: "BTC / USDT spot",
      badge: "SPOT · BINANCE",
      detail: "Binance BTCUSDT spot market. Quantities are base-asset units unless explicitly shown as USD notional.",
    },
  };

  const setText = (node, value) => {
    if (node && node.textContent !== value) node.textContent = value;
  };

  const replaceExactText = (root, from, to) => {
    root.querySelectorAll("*").forEach((node) => {
      if (node.children.length === 0 && node.textContent?.trim() === from) setText(node, to);
    });
  };

  const selectedSymbol = () => {
    const marketSelect = document.querySelector('select[aria-label="Market"]');
    return marketSelect?.value || "BTC";
  };

  const ensureTruthBanner = (market) => {
    const header = document.querySelector(".market-header");
    if (!header) return;
    let banner = document.querySelector(".data-truth-banner");
    if (!banner) {
      banner = document.createElement("div");
      banner.className = "data-truth-banner";
      banner.innerHTML = '<strong></strong><span></span>';
      header.insertAdjacentElement("afterend", banner);
    }
    const tone = market === "BTC" ? "spot" : "proxy";
    if (banner.dataset.tone !== tone) banner.dataset.tone = tone;
    setText(banner.querySelector("strong"), MARKET_IDENTITIES[market].badge);
    setText(banner.querySelector("span"), MARKET_IDENTITIES[market].detail);
  };

  const ensureReplayNotice = () => {
    const replayBar = document.querySelector(".replaybar");
    const existing = document.querySelector(".bar-replay-notice");
    if (!replayBar) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const notice = document.createElement("div");
    notice.className = "bar-replay-notice";
    notice.innerHTML = '<strong>BAR REPLAY · CANDLES ONLY</strong><span>Historical order book, time & sales, large prints, and full price-level footprint are not reconstructed.</span>';
    replayBar.insertAdjacentElement("afterend", notice);
  };

  const apply = () => {
    const symbol = selectedSymbol();
    const identity = MARKET_IDENTITIES[symbol] || MARKET_IDENTITIES.BTC;
    const marketSelect = document.querySelector('select[aria-label="Market"]');
    if (marketSelect) {
      [...marketSelect.options].forEach((option) => {
        const target = MARKET_IDENTITIES[option.value]?.option;
        if (target) setText(option, target);
      });
    }

    setText(document.querySelector(".instrument-copy b"), identity.title);

    const marketTitleSmall = document.querySelector(".market-title small");
    if (marketTitleSmall) {
      const parts = marketTitleSmall.textContent?.split("·").map((part) => part.trim()) || [];
      if (parts.length >= 2) setText(marketTitleSmall, `${identity.short} · ${parts.slice(1).join(" · ")}`);
    }

    replaceExactText(document, "Replay", "Bar Replay");
    replaceExactText(document, "Session VWAP", "Loaded-range VWAP");
    replaceExactText(document, "VWAP", "Loaded-range VWAP");
    replaceExactText(document, "Cumulative delta", "Rolling delta · 200 bars");
    replaceExactText(document, "Book imbalance", "Displayed depth imbalance");
    replaceExactText(document, "Funding / hour", "Funding rate · provider field");

    ensureTruthBanner(symbol);
    ensureReplayNotice();
  };

  let scheduled = false;
  const scheduleApply = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      apply();
    });
  };

  const observer = new MutationObserver(scheduleApply);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener("change", scheduleApply, true);
  window.addEventListener("load", scheduleApply);
  scheduleApply();
})();
