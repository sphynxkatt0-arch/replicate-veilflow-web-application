export function formatPrice(value: number | undefined, decimals = 2): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatCompact(value: number | undefined, decimals = 1): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(decimals)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(decimals)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(decimals)}K`;
  return value.toFixed(decimals);
}

export function formatNotional(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `$${formatCompact(value, value >= 100_000 ? 0 : 1)}`;
}

export function formatTime(timestamp: number, includeSeconds = false): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: includeSeconds ? "2-digit" : undefined,
  });
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
