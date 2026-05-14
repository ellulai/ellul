// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import {
  createDefaultRegistry,
  type WorkspaceConfigV1,
  type WorkspaceTabEntry,
} from "../workspace-extensions";
import {
  resolveWorkspaceState,
  type ResolveInput,
} from "../resolve-workspace-state";
import {
  expandPreset,
  ALL_PRESETS,
  DEFAULT_PRESET_ID,
} from "../workspace-presets";

// ─── Helpers ──────────────────────────────────────────────────────────────

const registry = createDefaultRegistry();

function resolve(
  config: WorkspaceConfigV1,
  overrides: Partial<Omit<ResolveInput, "registry" | "config">> = {},
) {
  return resolveWorkspaceState({
    registry,
    config,
    activeContext: "workspace",
    requestedTab: null,
    product: "cloud_platform",
    ...overrides,
  });
}

function wsTabRoutes(config: WorkspaceConfigV1, overrides?: Partial<Omit<ResolveInput, "registry" | "config">>) {
  return resolve(config, overrides).contexts["workspace"]!.tabs.map(
    (t) => t.routeSegment,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Adding a tab
// ═══════════════════════════════════════════════════════════════════════════

describe("Adding a tab", () => {
  it("adding preview to developer preset makes it appear in resolved tabs", () => {
    const config = expandPreset("developer", registry);
    config.contexts["workspace"]!.orderedTabs.push({
      extensionId: "core.preview",
      tabId: "main",
      enabled: true,
    });
    config.revision++;

    const routes = wsTabRoutes(config);
    expect(routes).toContain("preview");
  });

  it("adding preview removes it from available tabs", () => {
    const config = expandPreset("developer", registry);
    // Start from a preview-less workspace so we can observe the transition
    config.contexts["workspace"]!.orderedTabs =
      config.contexts["workspace"]!.orderedTabs.filter(
        (t) => t.extensionId !== "core.preview",
      );

    // Before adding: preview should be in available
    const before = resolve(config);
    const availableBefore = before.contexts["workspace"]!.availableTabs.map(
      (t) => t.routeSegment,
    );
    expect(availableBefore).toContain("preview");

    // After adding: preview should NOT be in available
    config.contexts["workspace"]!.orderedTabs.push({
      extensionId: "core.preview",
      tabId: "main",
      enabled: true,
    });
    const after = resolve(config);
    const availableAfter = after.contexts["workspace"]!.availableTabs.map(
      (t) => t.routeSegment,
    );
    expect(availableAfter).not.toContain("preview");
  });

  it("cannot add a tab that is already present (dedup)", () => {
    const config = expandPreset("developer", registry);
    // chat is already in developer preset; add a duplicate
    config.contexts["workspace"]!.orderedTabs.push({
      extensionId: "core.chat",
      tabId: "main",
      enabled: true,
    });

    const result = resolve(config);
    const chatTabs = result.contexts["workspace"]!.tabs.filter(
      (t) => t.extensionId === "core.chat",
    );
    expect(chatTabs).toHaveLength(1);
    expect(
      result.diagnostics.some((d) => d.code === "duplicate_tab_deduped"),
    ).toBe(true);
  });

  it("added tab inherits correct label and iconKey from manifest", () => {
    const config = expandPreset("developer", registry);
    config.contexts["workspace"]!.orderedTabs.push({
      extensionId: "core.preview",
      tabId: "main",
      enabled: true,
    });

    const result = resolve(config);
    const previewTab = result.contexts["workspace"]!.tabs.find(
      (t) => t.extensionId === "core.preview",
    );
    expect(previewTab).toBeDefined();
    expect(previewTab!.label).toBe("Preview");
    expect(previewTab!.iconKey).toBe("smartphone");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Removing a tab
// ═══════════════════════════════════════════════════════════════════════════

describe("Removing a tab", () => {
  it("removing code leaves only chat in workspace", () => {
    const config = expandPreset("developer", registry);
    config.contexts["workspace"]!.orderedTabs =
      config.contexts["workspace"]!.orderedTabs.filter(
        (t) => !(t.extensionId === "core.code" && t.tabId === "main"),
      );
    config.revision++;

    const routes = wsTabRoutes(config);
    expect(routes).not.toContain("code");
    expect(routes).toContain("chat");
  });

  it("removing required tab (chat) gets re-injected by resolver", () => {
    const config = expandPreset("developer", registry);
    config.contexts["workspace"]!.orderedTabs =
      config.contexts["workspace"]!.orderedTabs.filter(
        (t) => !(t.extensionId === "core.chat" && t.tabId === "main"),
      );

    const result = resolve(config);
    const routes = wsTabRoutes(config);
    expect(routes).toContain("chat");
    expect(
      result.diagnostics.some((d) => d.code === "required_tab_injected"),
    ).toBe(true);
  });

  it("removing active tab falls back to default", () => {
    const config = expandPreset("developer", registry);
    // Request preview as active
    const resultBefore = resolve(config, { requestedTab: "preview" });
    expect(resultBefore.contexts["workspace"]!.activeTabId).toBe("preview");

    // Now remove preview from the config
    config.contexts["workspace"]!.orderedTabs =
      config.contexts["workspace"]!.orderedTabs.filter(
        (t) => !(t.extensionId === "core.preview" && t.tabId === "main"),
      );

    const resultAfter = resolve(config, { requestedTab: "preview" });
    expect(resultAfter.contexts["workspace"]!.activeTabId).not.toBe("preview");
    expect(resultAfter.contexts["workspace"]!.activeTabId).toBe(
      resultAfter.contexts["workspace"]!.defaultTabId,
    );
    expect(
      resultAfter.diagnostics.some((d) => d.code === "active_tab_fell_back"),
    ).toBe(true);
  });

  it("removed tab appears in available tabs", () => {
    const config = expandPreset("developer", registry);
    // Verify preview is not available when it's in config
    const before = resolve(config);
    const avBefore = before.contexts["workspace"]!.availableTabs.map(
      (t) => t.routeSegment,
    );
    expect(avBefore).not.toContain("preview");

    // Remove preview
    config.contexts["workspace"]!.orderedTabs =
      config.contexts["workspace"]!.orderedTabs.filter(
        (t) => !(t.extensionId === "core.preview" && t.tabId === "main"),
      );

    const after = resolve(config);
    const avAfter = after.contexts["workspace"]!.availableTabs.map(
      (t) => t.routeSegment,
    );
    expect(avAfter).toContain("preview");
  });

  it("removing all non-required tabs keeps the context available via required injection", () => {
    const config: WorkspaceConfigV1 = {
      version: 1,
      revision: 0,
      basedOnPresetId: null,
      contexts: {
        workspace: { orderedTabs: [] },
      },
    };

    const result = resolve(config);
    const ws = result.contexts["workspace"]!;
    // chat is required and gets injected
    expect(ws.tabs.length).toBeGreaterThan(0);
    expect(ws.available).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Per-sandbox isolation
// ═══════════════════════════════════════════════════════════════════════════

describe("Per-sandbox isolation", () => {
  it("different configs produce different resolved states", () => {
    const devConfig = expandPreset("developer", registry);
    const trimmedConfig = expandPreset("developer", registry);
    trimmedConfig.contexts["workspace"]!.orderedTabs =
      trimmedConfig.contexts["workspace"]!.orderedTabs.slice(0, 1);

    const devResult = resolve(devConfig);
    const trimmedResult = resolve(trimmedConfig);

    expect(devResult.contexts["workspace"]!.tabs.length).toBeGreaterThan(
      trimmedResult.contexts["workspace"]!.tabs.length,
    );
  });

  it("mutating one config does not affect the other", () => {
    const configA = expandPreset("developer", registry);
    const configB = expandPreset("developer", registry);

    // Mutate A — drop the preview tab
    configA.contexts["workspace"]!.orderedTabs =
      configA.contexts["workspace"]!.orderedTabs.filter(
        (t) => t.extensionId !== "core.preview",
      );

    const resultA = resolve(configA);
    const resultB = resolve(configB);

    const routesA = resultA.contexts["workspace"]!.tabs.map(
      (t) => t.routeSegment,
    );
    const routesB = resultB.contexts["workspace"]!.tabs.map(
      (t) => t.routeSegment,
    );

    expect(routesA).not.toContain("preview");
    expect(routesB).toContain("preview");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Preset application
// ═══════════════════════════════════════════════════════════════════════════

describe("Preset application", () => {
  it("all presets produce valid resolved states", () => {
    for (const preset of ALL_PRESETS) {
      const config = expandPreset(preset.id, registry);
      const result = resolve(config);

      expect(result.contexts["workspace"]!.tabs.length).toBeGreaterThan(0);
      expect(
        result.diagnostics.filter((d) => d.code === "unknown_tab_removed"),
      ).toHaveLength(0);
    }
  });

  it("all presets include all registry contexts after resolution", () => {
    const allContexts = registry.getAllContexts();

    for (const preset of ALL_PRESETS) {
      const config = expandPreset(preset.id, registry);
      const result = resolve(config);

      for (const ctx of allContexts) {
        expect(result.contexts[ctx]).toBeDefined();
      }
    }
  });

  it("developer preset has preview tab in workspace", () => {
    const config = expandPreset("developer", registry);
    const routes = wsTabRoutes(config);
    expect(routes).toContain("preview");
    expect(routes).toContain("chat");
    expect(routes).toContain("code");
  });

  it("studio preset has same workspace tabs as developer", () => {
    const devRoutes = wsTabRoutes(expandPreset("developer", registry));
    const studioRoutes = wsTabRoutes(expandPreset("studio", registry));
    expect(studioRoutes).toEqual(devRoutes);
  });

  it("expandPreset throws for unknown preset", () => {
    expect(() => expandPreset("nonexistent", registry)).toThrow(
      /Unknown workspace preset/,
    );
  });

  it("default preset ID is developer", () => {
    expect(DEFAULT_PRESET_ID).toBe("developer");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Runtime mode transitions via tab operations
// ═══════════════════════════════════════════════════════════════════════════

describe("Runtime mode after tab operations", () => {
  it("adding preview and navigating to it sets preview mode", () => {
    const config = expandPreset("developer", registry);
    config.contexts["workspace"]!.orderedTabs.push({
      extensionId: "core.preview",
      tabId: "main",
      enabled: true,
    });

    const result = resolve(config, { requestedTab: "preview" });
    expect(result.derivedMode).toBe("preview");
  });

  it("adding preview but staying on chat keeps base mode", () => {
    const config = expandPreset("developer", registry);
    config.contexts["workspace"]!.orderedTabs.push({
      extensionId: "core.preview",
      tabId: "main",
      enabled: true,
    });

    const result = resolve(config, { requestedTab: "chat" });
    expect(result.derivedMode).toBe("base");
  });

  it("removing preview while on it falls back to base mode", () => {
    const config = expandPreset("developer", registry);
    // Remove preview
    config.contexts["workspace"]!.orderedTabs =
      config.contexts["workspace"]!.orderedTabs.filter(
        (t) => t.extensionId !== "core.preview",
      );

    const result = resolve(config, { requestedTab: "preview" });
    // preview is gone, so requestedTab falls back
    expect(result.derivedMode).toBe("base");
  });
});
