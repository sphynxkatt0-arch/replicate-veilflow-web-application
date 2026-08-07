import type { ChartMode, MarketKey, Timeframe } from "./types";
import { integrityHash, stableStringify } from "./integrity";

export type WorkspacePanelKind = "chart" | "order-book" | "tape" | "large-prints" | "metrics" | "quality";

export interface WorkspacePanel {
  id: string;
  kind: WorkspacePanelKind;
  market: MarketKey;
  timeframe: Timeframe;
  chartMode?: ChartMode;
  x: number;
  y: number;
  width: number;
  height: number;
  tabGroup?: string;
  detached?: boolean;
  synchronizedGroup?: string;
}

export interface WorkspacePreferences {
  density: "compact" | "comfortable";
  palette: "default" | "deuteranopia" | "protanopia" | "tritanopia" | "high-contrast";
  textScale: number;
  reduceMotion: boolean;
}

export interface WorkspaceDocument {
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  panels: WorkspacePanel[];
  preferences: WorkspacePreferences;
  hash: string;
}

export interface WorkspaceSyncAdapter {
  load(id: string): Promise<WorkspaceDocument | undefined>;
  save(workspace: WorkspaceDocument): Promise<void>;
  remove(id: string): Promise<void>;
}

const DEFAULT_PREFERENCES: WorkspacePreferences = {
  density: "compact",
  palette: "default",
  textScale: 1,
  reduceMotion: false,
};

function withoutHash(workspace: Omit<WorkspaceDocument, "hash"> | WorkspaceDocument): Omit<WorkspaceDocument, "hash"> {
  const { hash: _hash, ...document } = workspace as WorkspaceDocument;
  return document;
}

export function workspaceHash(workspace: Omit<WorkspaceDocument, "hash"> | WorkspaceDocument): string {
  return integrityHash(withoutHash(workspace));
}

export function createWorkspace(name = "Primary", now = Date.now()): WorkspaceDocument {
  const base: Omit<WorkspaceDocument, "hash"> = {
    schemaVersion: 1,
    id: `workspace-${now}`,
    name,
    createdAt: now,
    updatedAt: now,
    panels: [
      { id: "chart-main", kind: "chart", market: "BTC", timeframe: "5m", chartMode: "footprint", x: 0, y: 0, width: 9, height: 12, synchronizedGroup: "primary" },
      { id: "book-main", kind: "order-book", market: "BTC", timeframe: "5m", x: 9, y: 0, width: 3, height: 6, synchronizedGroup: "primary" },
      { id: "tape-main", kind: "tape", market: "BTC", timeframe: "5m", x: 9, y: 6, width: 3, height: 6, synchronizedGroup: "primary" },
    ],
    preferences: { ...DEFAULT_PREFERENCES },
  };
  return { ...base, hash: workspaceHash(base) };
}

export function validateWorkspace(workspace: WorkspaceDocument): string[] {
  const errors: string[] = [];
  if (workspace.schemaVersion !== 1) errors.push("unsupported workspace schema");
  if (!workspace.id.trim()) errors.push("workspace id is required");
  if (!workspace.name.trim()) errors.push("workspace name is required");
  if (!Array.isArray(workspace.panels) || workspace.panels.length === 0) errors.push("workspace requires at least one panel");
  if (workspace.panels.length > 24) errors.push("workspace panel limit exceeded");
  const ids = new Set<string>();
  for (const panel of workspace.panels ?? []) {
    if (!panel.id.trim()) errors.push("panel id is required");
    if (ids.has(panel.id)) errors.push(`duplicate panel id ${panel.id}`);
    ids.add(panel.id);
    if (![panel.x, panel.y, panel.width, panel.height].every(Number.isFinite)) errors.push(`panel ${panel.id} geometry is invalid`);
    if (panel.width <= 0 || panel.height <= 0) errors.push(`panel ${panel.id} dimensions must be positive`);
    if (panel.x < 0 || panel.y < 0 || panel.x + panel.width > 12) errors.push(`panel ${panel.id} is outside the 12-column grid`);
  }
  if (!Number.isFinite(workspace.preferences.textScale) || workspace.preferences.textScale < 0.75 || workspace.preferences.textScale > 2) errors.push("text scale must be between 0.75 and 2");
  if (workspace.hash !== workspaceHash(workspace)) errors.push("workspace integrity hash mismatch");
  return errors;
}

export function repairWorkspace(input: unknown, fallback = createWorkspace("Recovered")): WorkspaceDocument {
  if (!input || typeof input !== "object") return fallback;
  const candidate = input as Partial<WorkspaceDocument>;
  const now = Date.now();
  const panels = Array.isArray(candidate.panels)
    ? candidate.panels.filter((panel): panel is WorkspacePanel => Boolean(panel && typeof panel === "object" && typeof (panel as WorkspacePanel).id === "string")).slice(0, 24)
    : [];
  const normalized: Omit<WorkspaceDocument, "hash"> = {
    schemaVersion: 1,
    id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id : `workspace-recovered-${now}`,
    name: typeof candidate.name === "string" && candidate.name.trim() ? candidate.name : "Recovered workspace",
    createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : now,
    updatedAt: now,
    panels: panels.length ? panels.map((panel, index) => ({
      ...panel,
      id: panel.id || `panel-${index}`,
      x: Math.max(0, Math.min(11, Number(panel.x) || 0)),
      y: Math.max(0, Number(panel.y) || 0),
      width: Math.max(1, Math.min(12, Number(panel.width) || 4)),
      height: Math.max(1, Number(panel.height) || 4),
    })).map((panel) => ({ ...panel, width: Math.min(panel.width, 12 - panel.x) })) : fallback.panels,
    preferences: {
      ...DEFAULT_PREFERENCES,
      ...(candidate.preferences && typeof candidate.preferences === "object" ? candidate.preferences : {}),
      textScale: Math.max(0.75, Math.min(2, Number(candidate.preferences?.textScale) || 1)),
    },
  };
  const repaired = { ...normalized, hash: workspaceHash(normalized) };
  return validateWorkspace(repaired).length ? fallback : repaired;
}

export class LocalWorkspaceStore implements WorkspaceSyncAdapter {
  constructor(private readonly prefix = "vf-workspace-v1") {}

  async load(id: string): Promise<WorkspaceDocument | undefined> {
    try {
      const raw = localStorage.getItem(`${this.prefix}:${id}`);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as WorkspaceDocument;
      return validateWorkspace(parsed).length ? repairWorkspace(parsed) : parsed;
    } catch {
      return undefined;
    }
  }

  async save(workspace: WorkspaceDocument): Promise<void> {
    const errors = validateWorkspace(workspace);
    if (errors.length) throw new Error(`Invalid workspace: ${errors.join(", ")}`);
    localStorage.setItem(`${this.prefix}:${workspace.id}`, stableStringify(workspace));
    localStorage.setItem(`${this.prefix}:last`, workspace.id);
  }

  async remove(id: string): Promise<void> {
    localStorage.removeItem(`${this.prefix}:${id}`);
  }
}

export class RestWorkspaceSync implements WorkspaceSyncAdapter {
  constructor(private readonly endpoint = "/api/workspaces") {}

  async load(id: string): Promise<WorkspaceDocument | undefined> {
    const response = await fetch(`${this.endpoint}/${encodeURIComponent(id)}`, { headers: { Accept: "application/json" } });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Workspace load failed: ${response.status}`);
    const document = await response.json() as WorkspaceDocument;
    const errors = validateWorkspace(document);
    if (errors.length) throw new Error(`Cloud workspace is invalid: ${errors.join(", ")}`);
    return document;
  }

  async save(workspace: WorkspaceDocument): Promise<void> {
    const errors = validateWorkspace(workspace);
    if (errors.length) throw new Error(`Invalid workspace: ${errors.join(", ")}`);
    const response = await fetch(`${this.endpoint}/${encodeURIComponent(workspace.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(workspace),
    });
    if (!response.ok) throw new Error(`Workspace save failed: ${response.status}`);
  }

  async remove(id: string): Promise<void> {
    const response = await fetch(`${this.endpoint}/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok && response.status !== 404) throw new Error(`Workspace delete failed: ${response.status}`);
  }
}

export function synchronizePanels(workspace: WorkspaceDocument, sourcePanelId: string): WorkspaceDocument {
  const source = workspace.panels.find((panel) => panel.id === sourcePanelId);
  if (!source?.synchronizedGroup) return workspace;
  const panels = workspace.panels.map((panel) => panel.synchronizedGroup === source.synchronizedGroup
    ? { ...panel, market: source.market, timeframe: source.timeframe }
    : panel);
  const updated = { ...workspace, panels, updatedAt: Date.now() };
  return { ...updated, hash: workspaceHash(updated) };
}
