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

function repairLegacyPrimitiveStorage(): void {
  try {
    // App.tsx historically used an object-merging storage hook for primitive values.
    // A persisted string/number was therefore rehydrated as an object. `mode.toUpperCase()`
    // then threw during the first render and React left the page completely blank.
    // Clear only the two primitive keys before React initializes. The application falls
    // back to safe defaults and can persist them again during the current session.
    localStorage.removeItem("vf-chart-mode");
    localStorage.removeItem("vf-sidebar-width");
  } catch {
    // Storage may be unavailable in private browsing; React defaults still apply.
  }
}

function initializePerformanceBootstrap(): void {
  if (typeof window === "undefined") return;

  repairLegacyPrimitiveStorage();

  if (!window.matchMedia(MOBILE_QUERY).matches) return;
  document.documentElement.classList.add("vf-mobile-performance");

  try {
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

initializePerformanceBootstrap();
