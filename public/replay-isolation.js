(() => {
  const setReplayState = () => {
    const replayActive = Boolean(document.querySelector(".replaybar"));
    document.documentElement.classList.toggle("bar-replay-active", replayActive);

    const chartMode = document.querySelector('select[aria-label="Chart mode"]');
    if (replayActive && chartMode && chartMode.value !== "candles") {
      chartMode.value = "candles";
      chartMode.dispatchEvent(new Event("change", { bubbles: true }));
    }

    document.querySelectorAll('rect[fill="url(#buy-gradient)"], rect[fill="url(#sell-gradient)"]').forEach((node) => {
      node.classList.add("live-book-heatmap-layer");
    });

    const chart = document.querySelector(".chart-wrap");
    if (replayActive && chart && !chart.querySelector(".replay-chart-stamp")) {
      const stamp = document.createElement("div");
      stamp.className = "replay-chart-stamp";
      stamp.textContent = "BAR REPLAY · CANDLES ONLY";
      chart.appendChild(stamp);
    }
    if (!replayActive) document.querySelectorAll(".replay-chart-stamp").forEach((node) => node.remove());
  };

  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      setReplayState();
    });
  };

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("click", schedule, true);
  document.addEventListener("change", schedule, true);
  window.addEventListener("load", schedule);
  schedule();
})();
