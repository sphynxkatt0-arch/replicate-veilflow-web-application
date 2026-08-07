const MOBILE_QUERY = "(max-width: 820px), (pointer: coarse)";
const MIGRATION_KEY = "vf-mobile-performance-r2";

function readObject(key: string): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function initializeMobilePerformance(): void {
  if (typeof window === "undefined" || !window.matchMedia(MOBILE_QUERY).matches) return;

  document.documentElement.classList.add("vf-mobile-performance");

  try {
    // The current generic storage hook merges objects and cannot safely rehydrate primitives.
    // Remove an existing primitive chart mode before React initializes; the in-memory fallback is candles.
    localStorage.removeItem("vf-chart-mode");

    if (localStorage.getItem(MIGRATION_KEY) === "1") return;

    const settings = readObject("vf-settings-v6");
    localStorage.setItem("vf-settings-v6", JSON.stringify({ ...settings, layout: "single" }));

    const panels = readObject("vf-panels");
    localStorage.setItem("vf-panels", JSON.stringify({ ...panels, book: false, prints: true, tape: true }));

    localStorage.setItem(MIGRATION_KEY, "1");
  } catch {
    // Storage can be unavailable in private browsing. Runtime optimizations still apply.
  }
}

initializeMobilePerformance();
