import { describe, expect, it } from "vitest";
import { createWorkspace, repairWorkspace, synchronizePanels, validateWorkspace, workspaceHash } from "../workspaces";

describe("workspace documents", () => {
  it("creates a valid multi-panel workspace", () => {
    const workspace = createWorkspace("Trading", 100);
    expect(workspace.panels).toHaveLength(3);
    expect(validateWorkspace(workspace)).toEqual([]);
  });

  it("detects corruption and repairs unsafe geometry", () => {
    const workspace = createWorkspace("Corrupt", 100);
    const corrupted = { ...workspace, panels: [{ ...workspace.panels[0], x: -5, width: 50 }], hash: "sha256:bad" };
    expect(validateWorkspace(corrupted)).toContain("workspace integrity hash mismatch");
    const repaired = repairWorkspace(corrupted);
    expect(validateWorkspace(repaired)).toEqual([]);
    expect(repaired.panels[0].x).toBeGreaterThanOrEqual(0);
    expect(repaired.panels[0].x + repaired.panels[0].width).toBeLessThanOrEqual(12);
  });

  it("synchronizes market and timeframe across linked panels", () => {
    const workspace = createWorkspace("Linked", 100);
    const source = workspace.panels[0];
    const changed = {
      ...workspace,
      panels: workspace.panels.map((panel) => panel.id === source.id ? { ...panel, market: "BTCPERP" as const, timeframe: "15m" as const } : panel),
    };
    const valid = { ...changed, hash: workspaceHash(changed) };
    const synchronized = synchronizePanels(valid, source.id);
    expect(synchronized.panels.every((panel) => panel.market === "BTCPERP" && panel.timeframe === "15m")).toBe(true);
    expect(validateWorkspace(synchronized)).toEqual([]);
  });
});
