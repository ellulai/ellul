// SPDX-License-Identifier: MIT

import { describe, expect, it } from "vitest";
import {
  createDefaultRegistry,
  ManifestRegistry,
  type WorkspaceConfigV1,
  type WorkspaceExtensionManifestV1,
  type WorkspaceTabEntry,
} from "../workspace-extensions";
import { resolveWorkspaceState, type ResolveInput } from "../resolve-workspace-state";
import { expandPreset, isExactPresetMatch, DEFAULT_PRESET_ID } from "../workspace-presets";

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<ResolveInput> = {}): ResolveInput {
  return {
    registry: createDefaultRegistry(),
    config: null,
    activeContext: "workspace",
    requestedTab: null,
    product: "cloud_platform",
    ...overrides,
  };
}

/** Build a minimal config with only the specified workspace tabs. */
function workspaceOnlyConfig(
  tabs: WorkspaceTabEntry[],
  basedOnPresetId: string | null = null,
): WorkspaceConfigV1 {
  return {
    version: 1,
    revision: 0,
    basedOnPresetId,
    contexts: {
      workspace: { orderedTabs: tabs },
    },
  };
}

function hasDiagnostic(
  diagnostics: Array<{ code: string }>,
  code: string,
): boolean {
  return diagnostics.some((d) => d.code === code);
}

function getDiagnostics(
  diagnostics: Array<{ code: string }>,
  code: string,
): Array<{ code: string; [key: string]: unknown }> {
  return diagnostics.filter((d) => d.code === code);
}

// ─── 1. Null config fallback ──────────────────────────────────────────────

describe("null config fallback", () => {
  it("expands the default developer preset when config is null", () => {
    const result = resolveWorkspaceState(makeInput({ config: null }));

    expect(hasDiagnostic(result.diagnostics, "preset_applied")).toBe(true);

    // Developer preset defines workspace with chat + code
    const ws = result.contexts["workspace"];
    expect(ws).toBeDefined();
    const routeSegments = ws!.tabs.map((t) => t.routeSegment);
    expect(routeSegments).toContain("chat");
    expect(routeSegments).toContain("code");
  });

  it("resolved config matches the expanded developer preset shape", () => {
    const registry = createDefaultRegistry();
    const result = resolveWorkspaceState(makeInput({ config: null }));
    const expanded = expandPreset(DEFAULT_PRESET_ID, registry);

    // Every context from the expanded preset should appear in the resolved state
    for (const contextId of Object.keys(expanded.contexts)) {
      expect(result.contexts[contextId]).toBeDefined();
    }
  });
});

// ─── 2. Missing required tab injection ────────────────────────────────────

describe("missing required tab injection", () => {
  it("injects core.chat when workspace context is missing it", () => {
    // Config with only core.code (core.chat is required)
    const config = workspaceOnlyConfig([
      { extensionId: "core.code", tabId: "main", enabled: true },
    ]);

    const result = resolveWorkspaceState(makeInput({ config }));
    const ws = result.contexts["workspace"]!;

    // core.chat should have been injected
    const chatTab = ws.tabs.find((t) => t.extensionId === "core.chat");
    expect(chatTab).toBeDefined();
    expect(chatTab!.required).toBe(true);

    // Injected required tabs go at position 0 (before existing tabs)
    expect(ws.tabs[0]!.extensionId).toBe("core.chat");

    expect(hasDiagnostic(result.diagnostics, "required_tab_injected")).toBe(true);
  });

  it("injects required tabs for contexts not present in config at all", () => {
    // Config with only workspace, no other contexts
    const config: WorkspaceConfigV1 = {
      version: 1,
      revision: 0,
      basedOnPresetId: null,
      contexts: {
        workspace: {
          orderedTabs: [
            { extensionId: "core.chat", tabId: "main", enabled: true },
            { extensionId: "core.code", tabId: "main", enabled: true },
          ],
        },
      },
    };

    const result = resolveWorkspaceState(makeInput({ config }));

    // Vault context has required tab core.vault.notes
    const vault = result.contexts["vault"];
    expect(vault).toBeDefined();
    const notesTab = vault!.tabs.find((t) => t.extensionId === "core.vault.notes");
    expect(notesTab).toBeDefined();
  });
});

// ─── 3. Unknown tab removal ──────────────────────────────────────────────

describe("unknown tab removal", () => {
  it("removes tabs referencing non-existent extensions", () => {
    const config = workspaceOnlyConfig([
      { extensionId: "core.chat", tabId: "main", enabled: true },
      { extensionId: "unknown.ext", tabId: "main", enabled: true },
      { extensionId: "core.code", tabId: "main", enabled: true },
    ]);

    const result = resolveWorkspaceState(makeInput({ config }));
    const ws = result.contexts["workspace"]!;

    const unknownTab = ws.tabs.find((t) => t.extensionId === "unknown.ext");
    expect(unknownTab).toBeUndefined();

    expect(hasDiagnostic(result.diagnostics, "unknown_tab_removed")).toBe(true);
    const diag = getDiagnostics(result.diagnostics, "unknown_tab_removed")[0]!;
    expect(diag.extensionId).toBe("unknown.ext");
  });

  it("removes tabs with valid extension but non-existent tabId", () => {
    const config = workspaceOnlyConfig([
      { extensionId: "core.chat", tabId: "main", enabled: true },
      { extensionId: "core.chat", tabId: "nonexistent", enabled: true },
    ]);

    const result = resolveWorkspaceState(makeInput({ config }));
    const ws = result.contexts["workspace"]!;

    const badTab = ws.tabs.find((t) => t.tabId === "nonexistent");
    expect(badTab).toBeUndefined();

    expect(hasDiagnostic(result.diagnostics, "unknown_tab_removed")).toBe(true);
  });
});

// ─── 4. Product-gated tab hidden ─────────────────────────────────────────

describe("product-gated tab hidden", () => {
  it("hides tabs with unavailableVisibility=hidden when product requirement not met", () => {
    // core.db.bin has unavailableVisibility "hidden" and requires cloud_platform
    // Use a custom registry to test with shield_proxy (which doesn't meet the requirement)
    const config: WorkspaceConfigV1 = {
      version: 1,
      revision: 0,
      basedOnPresetId: null,
      contexts: {
        database: {
          orderedTabs: [
            { extensionId: "core.db.tables", tabId: "main", enabled: true },
            { extensionId: "core.db.bin", tabId: "main", enabled: true },
            { extensionId: "core.db.settings", tabId: "main", enabled: true },
          ],
        },
      },
    };

    const result = resolveWorkspaceState(
      makeInput({ config, product: "shield_proxy" }),
    );
    const db = result.contexts["database"]!;

    // core.db.bin has unavailableVisibility "hidden" + requires cloud_platform
    const binTab = db.tabs.find((t) => t.extensionId === "core.db.bin");
    expect(binTab).toBeDefined();
    expect(binTab!.availability.state).toBe("hidden");

    // core.db.settings also has unavailableVisibility "hidden" + requires cloud_platform
    const settingsTab = db.tabs.find((t) => t.extensionId === "core.db.settings");
    expect(settingsTab).toBeDefined();
    expect(settingsTab!.availability.state).toBe("hidden");

    expect(hasDiagnostic(result.diagnostics, "tab_hidden_due_to_product")).toBe(true);
  });

  it("shows tabs normally when product requirement is met", () => {
    const config: WorkspaceConfigV1 = {
      version: 1,
      revision: 0,
      basedOnPresetId: null,
      contexts: {
        database: {
          orderedTabs: [
            { extensionId: "core.db.bin", tabId: "main", enabled: true },
          ],
        },
      },
    };

    const result = resolveWorkspaceState(
      makeInput({ config, product: "cloud_platform" }),
    );
    const db = result.contexts["database"]!;

    const binTab = db.tabs.find((t) => t.extensionId === "core.db.bin");
    expect(binTab).toBeDefined();
    expect(binTab!.availability.state).toBe("enabled");
  });
});

// ─── 5. Product-gated tab disabled ───────────────────────────────────────

describe("product-gated tab disabled", () => {
  it("disables tabs with unavailableVisibility=disabled when product requirement not met", () => {
    // core.db.tables has unavailableVisibility "disabled" + requires cloud_platform
    const config: WorkspaceConfigV1 = {
      version: 1,
      revision: 0,
      basedOnPresetId: null,
      contexts: {
        database: {
          orderedTabs: [
            { extensionId: "core.db.tables", tabId: "main", enabled: true },
          ],
        },
      },
    };

    const result = resolveWorkspaceState(
      makeInput({ config, product: "shield_proxy" }),
    );
    const db = result.contexts["database"]!;

    const tablesTab = db.tabs.find(
      (t) => t.extensionId === "core.db.tables",
    );
    expect(tablesTab).toBeDefined();
    expect(tablesTab!.availability.state).toBe("disabled");
    expect(tablesTab!.availability.reason).toBe("missing_product");
    expect(tablesTab!.availability.upgradeTarget).toBe("cloud_platform");

    expect(hasDiagnostic(result.diagnostics, "tab_disabled_due_to_product")).toBe(true);
  });
});

// ─── 6. Active tab fallback ──────────────────────────────────────────────

describe("active tab fallback", () => {
  it("falls back to default tab when requestedTab is not in config", () => {
    const config = workspaceOnlyConfig([
      { extensionId: "core.chat", tabId: "main", enabled: true },
      { extensionId: "core.code", tabId: "main", enabled: true },
    ]);

    const result = resolveWorkspaceState(
      makeInput({ config, requestedTab: "preview" }),
    );
    const ws = result.contexts["workspace"]!;

    // "preview" is not in config, should fall back to default (chat, which is required)
    expect(ws.activeTabId).toBe("chat");
    expect(ws.defaultTabId).toBe("chat");

    expect(hasDiagnostic(result.diagnostics, "active_tab_fell_back")).toBe(true);
    const diag = getDiagnostics(result.diagnostics, "active_tab_fell_back")[0]!;
    expect(diag.metadata).toBeDefined();
    expect((diag.metadata as Record<string, unknown>).requestedTab).toBe("preview");
  });

  it("uses the requested tab when it is valid and enabled", () => {
    const config = workspaceOnlyConfig([
      { extensionId: "core.chat", tabId: "main", enabled: true },
      { extensionId: "core.code", tabId: "main", enabled: true },
    ]);

    const result = resolveWorkspaceState(
      makeInput({ config, requestedTab: "code" }),
    );
    const ws = result.contexts["workspace"]!;

    expect(ws.activeTabId).toBe("code");
  });

  it("falls back when requested tab matches a hidden tab", () => {
    // core.settings.git has unavailableVisibility "hidden" + requires cloud_platform
    const config: WorkspaceConfigV1 = {
      version: 1,
      revision: 0,
      basedOnPresetId: null,
      contexts: {
        settings: {
          orderedTabs: [
            { extensionId: "core.settings.context", tabId: "main", enabled: true },
            { extensionId: "core.settings.git", tabId: "main", enabled: true },
          ],
        },
      },
    };

    const result = resolveWorkspaceState(
      makeInput({
        config,
        activeContext: "settings",
        requestedTab: "git",
        product: "shield_proxy",
      }),
    );
    const settings = result.contexts["settings"]!;

    // git tab should be hidden for shield_proxy, so active should fall back
    expect(settings.activeTabId).not.toBe("git");
    expect(hasDiagnostic(result.diagnostics, "active_tab_fell_back")).toBe(true);
  });
});

// ─── 7. Preset application + exact match ─────────────────────────────────

describe("preset application and exact match", () => {
  it("expanded developer preset matches itself via isExactPresetMatch", () => {
    const registry = createDefaultRegistry();
    const expanded = expandPreset(DEFAULT_PRESET_ID, registry);

    expect(isExactPresetMatch(expanded, DEFAULT_PRESET_ID, registry)).toBe(true);
  });

  it("modified config does not match the preset", () => {
    const registry = createDefaultRegistry();
    const expanded = expandPreset(DEFAULT_PRESET_ID, registry);

    // Add an extra tab to workspace
    const modified: WorkspaceConfigV1 = {
      ...expanded,
      contexts: {
        ...expanded.contexts,
        workspace: {
          orderedTabs: [
            ...(expanded.contexts["workspace"]?.orderedTabs ?? []),
            { extensionId: "core.preview", tabId: "main", enabled: true },
          ],
        },
      },
    };

    expect(isExactPresetMatch(modified, DEFAULT_PRESET_ID, registry)).toBe(false);
  });

  it("reordered tabs do not match the preset", () => {
    const registry = createDefaultRegistry();
    const expanded = expandPreset(DEFAULT_PRESET_ID, registry);

    const wsTabs = [...(expanded.contexts["workspace"]?.orderedTabs ?? [])];
    if (wsTabs.length >= 2) {
      // Swap first two
      [wsTabs[0], wsTabs[1]] = [wsTabs[1]!, wsTabs[0]!];
    }

    const reordered: WorkspaceConfigV1 = {
      ...expanded,
      contexts: {
        ...expanded.contexts,
        workspace: { orderedTabs: wsTabs },
      },
    };

    expect(isExactPresetMatch(reordered, DEFAULT_PRESET_ID, registry)).toBe(false);
  });
});

// ─── 8. Deprecated extension replacement ─────────────────────────────────

describe("deprecated extension replacement", () => {
  it("replaces deprecated extension with its replacement", () => {
    const registry = new ManifestRegistry();

    // Register the deprecated extension
    const deprecated: WorkspaceExtensionManifestV1 = {
      id: "old.chat",
      version: "1.0.0",
      name: "Old Chat",
      description: "Deprecated chat",
      author: "ellul",
      tabs: [
        {
          tabId: "main",
          context: "workspace",
          label: "Old Chat",
          description: "Deprecated",
          iconKey: "terminal",
          category: "core",
          routeSegment: "old-chat",
          defaultEnabled: false,
          required: false,
          unavailableVisibility: "disabled",
        },
      ],
      compatibility: {
        deprecated: true,
        replacedBy: "new.chat",
        deprecationMessage: "Use new.chat instead",
      },
    };

    // Register the replacement with matching tabId
    const replacement: WorkspaceExtensionManifestV1 = {
      id: "new.chat",
      version: "2.0.0",
      name: "New Chat",
      description: "Replacement chat",
      author: "ellul",
      tabs: [
        {
          tabId: "main",
          context: "workspace",
          label: "New Chat",
          description: "The new chat",
          iconKey: "terminal",
          category: "core",
          routeSegment: "new-chat",
          defaultEnabled: true,
          required: true,
          unavailableVisibility: "disabled",
        },
      ],
    };

    registry.register(deprecated);
    registry.register(replacement);

    const config: WorkspaceConfigV1 = {
      version: 1,
      revision: 0,
      basedOnPresetId: null,
      contexts: {
        workspace: {
          orderedTabs: [
            { extensionId: "old.chat", tabId: "main", enabled: true },
          ],
        },
      },
    };

    const result = resolveWorkspaceState(
      makeInput({ registry, config }),
    );
    const ws = result.contexts["workspace"]!;

    // The old.chat entry should have been replaced by new.chat
    const newChatTab = ws.tabs.find((t) => t.extensionId === "new.chat");
    expect(newChatTab).toBeDefined();

    const oldChatTab = ws.tabs.find((t) => t.extensionId === "old.chat");
    expect(oldChatTab).toBeUndefined();

    expect(hasDiagnostic(result.diagnostics, "deprecated_extension_replaced")).toBe(true);
  });

  it("keeps deprecated extension if replacement does not exist", () => {
    const registry = new ManifestRegistry();

    const deprecated: WorkspaceExtensionManifestV1 = {
      id: "old.chat",
      version: "1.0.0",
      name: "Old Chat",
      description: "Deprecated chat",
      author: "ellul",
      tabs: [
        {
          tabId: "main",
          context: "workspace",
          label: "Old Chat",
          description: "Deprecated",
          iconKey: "terminal",
          category: "core",
          routeSegment: "old-chat",
          defaultEnabled: false,
          required: false,
          unavailableVisibility: "disabled",
        },
      ],
      compatibility: {
        deprecated: true,
        replacedBy: "nonexistent.chat",
      },
    };

    registry.register(deprecated);

    const config: WorkspaceConfigV1 = {
      version: 1,
      revision: 0,
      basedOnPresetId: null,
      contexts: {
        workspace: {
          orderedTabs: [
            { extensionId: "old.chat", tabId: "main", enabled: true },
          ],
        },
      },
    };

    const result = resolveWorkspaceState(makeInput({ registry, config }));
    const ws = result.contexts["workspace"]!;

    // Should still be old.chat since replacement doesn't exist
    const oldTab = ws.tabs.find((t) => t.extensionId === "old.chat");
    expect(oldTab).toBeDefined();
    // Deprecated tabs get disabled availability
    expect(oldTab!.availability.state).toBe("disabled");
    expect(oldTab!.availability.reason).toBe("deprecated");
  });
});

// ─── 9. Duplicate tab deduplication ──────────────────────────────────────

describe("duplicate tab deduplication", () => {
  it("keeps first occurrence and removes duplicates", () => {
    const config = workspaceOnlyConfig([
      { extensionId: "core.chat", tabId: "main", enabled: true },
      { extensionId: "core.code", tabId: "main", enabled: true },
      { extensionId: "core.code", tabId: "main", enabled: false },
    ]);

    const result = resolveWorkspaceState(makeInput({ config }));
    const ws = result.contexts["workspace"]!;

    const codeTabs = ws.tabs.filter((t) => t.extensionId === "core.code");
    expect(codeTabs).toHaveLength(1);
    // First occurrence was enabled: true, so the kept one should be enabled
    expect(codeTabs[0]!.enabled).toBe(true);

    expect(hasDiagnostic(result.diagnostics, "duplicate_tab_deduped")).toBe(true);
  });

  it("deduplication does not affect distinct tabs", () => {
    const config = workspaceOnlyConfig([
      { extensionId: "core.chat", tabId: "main", enabled: true },
      { extensionId: "core.code", tabId: "main", enabled: true },
    ]);

    const result = resolveWorkspaceState(makeInput({ config }));
    const ws = result.contexts["workspace"]!;

    expect(hasDiagnostic(result.diagnostics, "duplicate_tab_deduped")).toBe(false);
    // Both tabs should still be present
    expect(ws.tabs.filter((t) => t.extensionId === "core.chat")).toHaveLength(1);
    expect(ws.tabs.filter((t) => t.extensionId === "core.code")).toHaveLength(1);
  });
});

// ─── 10. Context with all tabs hidden = unavailable ──────────────────────

describe("context with all tabs hidden is unavailable", () => {
  it("marks context as unavailable when all tabs are hidden", () => {
    // Test with custom registry where all tabs for a context are hidden-when-unavailable
    const customRegistry = new ManifestRegistry();
    customRegistry.register({
      id: "test.hidden1",
      version: "1.0.0",
      name: "Hidden 1",
      description: "Test",
      author: "test",
      tabs: [
        {
          tabId: "main",
          context: "custom",
          label: "Hidden 1",
          description: "Test",
          iconKey: "x",
          category: "core",
          routeSegment: "h1",
          defaultEnabled: true,
          required: false,
          unavailableVisibility: "hidden",
          productRequirements: ["cloud_platform"],
        },
      ],
    });
    customRegistry.register({
      id: "test.hidden2",
      version: "1.0.0",
      name: "Hidden 2",
      description: "Test",
      author: "test",
      tabs: [
        {
          tabId: "main",
          context: "custom",
          label: "Hidden 2",
          description: "Test",
          iconKey: "x",
          category: "core",
          routeSegment: "h2",
          defaultEnabled: true,
          required: false,
          unavailableVisibility: "hidden",
          productRequirements: ["cloud_platform"],
        },
      ],
    });

    const customConfig: WorkspaceConfigV1 = {
      version: 1,
      revision: 0,
      basedOnPresetId: null,
      contexts: {
        custom: {
          orderedTabs: [
            { extensionId: "test.hidden1", tabId: "main", enabled: true },
            { extensionId: "test.hidden2", tabId: "main", enabled: true },
          ],
        },
      },
    };

    const customResult = resolveWorkspaceState({
      registry: customRegistry,
      config: customConfig,
      activeContext: "custom",
      requestedTab: null,
      product: "shield_proxy",
    });

    const custom = customResult.contexts["custom"]!;
    expect(custom.available).toBe(false);
    expect(hasDiagnostic(customResult.diagnostics, "context_unavailable")).toBe(true);
  });

  it("marks context as available when at least one tab is non-hidden", () => {
    const config = workspaceOnlyConfig([
      { extensionId: "core.chat", tabId: "main", enabled: true },
    ]);

    const result = resolveWorkspaceState(makeInput({ config }));
    const ws = result.contexts["workspace"]!;

    expect(ws.available).toBe(true);
  });
});

// ─── 11. Runtime mode derivation ─────────────────────────────────────────

describe("runtime mode derivation", () => {
  it("derives preview mode when active tab is preview", () => {
    const config = workspaceOnlyConfig([
      { extensionId: "core.chat", tabId: "main", enabled: true },
      { extensionId: "core.code", tabId: "main", enabled: true },
      { extensionId: "core.preview", tabId: "main", enabled: true },
    ]);

    const result = resolveWorkspaceState(
      makeInput({ config, requestedTab: "preview" }),
    );

    expect(result.derivedMode).toBe("preview");
  });

  it("derives base mode when active tab is chat", () => {
    const config = workspaceOnlyConfig([
      { extensionId: "core.chat", tabId: "main", enabled: true },
      { extensionId: "core.code", tabId: "main", enabled: true },
      { extensionId: "core.preview", tabId: "main", enabled: true },
    ]);

    const result = resolveWorkspaceState(
      makeInput({ config, requestedTab: "chat" }),
    );

    expect(result.derivedMode).toBe("base");
  });

  it("derives base mode when no tab contributes a mode", () => {
    const config = workspaceOnlyConfig([
      { extensionId: "core.chat", tabId: "main", enabled: true },
      { extensionId: "core.code", tabId: "main", enabled: true },
    ]);

    const result = resolveWorkspaceState(makeInput({ config }));

    expect(result.derivedMode).toBe("base");
  });

  it("derives mode from non-active context as base (only active context drives mode)", () => {
    // Preview tab is in workspace, but activeContext is "vault"
    const registry = createDefaultRegistry();
    const expanded = expandPreset("developer", registry);

    const result = resolveWorkspaceState(
      makeInput({
        config: expanded,
        activeContext: "vault",
        requestedTab: null,
      }),
    );

    // vault context has no mode-contributing tabs, so derivedMode should be base
    expect(result.derivedMode).toBe("base");
  });
});

// ─── 12. Tab order preserved ─────────────────────────────────────────────

describe("tab order preserved", () => {
  it("maintains custom tab order from config", () => {
    // Deliberately reverse the typical order: code before chat
    const config = workspaceOnlyConfig([
      { extensionId: "core.code", tabId: "main", enabled: true },
      { extensionId: "core.preview", tabId: "main", enabled: true },
    ]);

    const result = resolveWorkspaceState(makeInput({ config }));
    const ws = result.contexts["workspace"]!;

    // Required tab (chat) gets injected at position 0
    // Then the original order should be preserved after it
    const segments = ws.tabs.map((t) => t.routeSegment);

    // chat injected first, then code, then preview
    expect(segments[0]).toBe("chat");
    const codeIdx = segments.indexOf("code");
    const previewIdx = segments.indexOf("preview");
    expect(codeIdx).toBeLessThan(previewIdx);
  });

  it("preserves order when no injection is needed", () => {
    const config = workspaceOnlyConfig([
      { extensionId: "core.chat", tabId: "main", enabled: true },
      { extensionId: "core.preview", tabId: "main", enabled: true },
      { extensionId: "core.code", tabId: "main", enabled: true },
    ]);

    const result = resolveWorkspaceState(makeInput({ config }));
    const ws = result.contexts["workspace"]!;

    const segments = ws.tabs.map((t) => t.routeSegment);
    expect(segments.indexOf("chat")).toBe(0);
    expect(segments.indexOf("preview")).toBe(1);
    expect(segments.indexOf("code")).toBe(2);
  });

  it("repaired config also preserves tab order", () => {
    // All required tabs already present, so no injection occurs
    // Order should be exactly preserved: preview, chat, code
    const config = workspaceOnlyConfig([
      { extensionId: "core.preview", tabId: "main", enabled: true },
      { extensionId: "core.chat", tabId: "main", enabled: true },
      { extensionId: "core.code", tabId: "main", enabled: true },
    ]);

    const result = resolveWorkspaceState(makeInput({ config }));
    const repairedWs = result.repairedConfig.contexts["workspace"];
    expect(repairedWs).toBeDefined();

    const repairedIds = repairedWs!.orderedTabs.map((t) => t.extensionId);
    const previewIdx = repairedIds.indexOf("core.preview");
    const chatIdx = repairedIds.indexOf("core.chat");
    const codeIdx = repairedIds.indexOf("core.code");

    // Original order preserved: preview < chat < code
    expect(previewIdx).toBeLessThan(chatIdx);
    expect(chatIdx).toBeLessThan(codeIdx);
  });
});

// ─── Additional edge cases ───────────────────────────────────────────────

describe("repaired config output", () => {
  it("emits a valid repaired config with version 1", () => {
    const result = resolveWorkspaceState(makeInput({ config: null }));

    expect(result.repairedConfig.version).toBe(1);
    expect(typeof result.repairedConfig.revision).toBe("number");
    expect(result.repairedConfig.contexts).toBeDefined();
  });

  it("repaired config includes all resolved contexts", () => {
    const result = resolveWorkspaceState(makeInput({ config: null }));

    const resolvedContextIds = Object.keys(result.contexts);
    const repairedContextIds = Object.keys(result.repairedConfig.contexts);

    expect(repairedContextIds.sort()).toEqual(resolvedContextIds.sort());
  });
});

describe("available (addable) tabs", () => {
  it("lists tabs not in config as available", () => {
    const config = workspaceOnlyConfig([
      { extensionId: "core.chat", tabId: "main", enabled: true },
    ]);

    const result = resolveWorkspaceState(makeInput({ config }));
    const ws = result.contexts["workspace"]!;

    // core.code and core.preview are in the registry for workspace context
    // core.code should be in availableTabs since it's not in config
    const availableCode = ws.availableTabs.find(
      (t) => t.extensionId === "core.code",
    );
    expect(availableCode).toBeDefined();
  });

  it("does not list tabs already in config as available", () => {
    const config = workspaceOnlyConfig([
      { extensionId: "core.chat", tabId: "main", enabled: true },
      { extensionId: "core.code", tabId: "main", enabled: true },
      { extensionId: "core.preview", tabId: "main", enabled: true },
    ]);

    const result = resolveWorkspaceState(makeInput({ config }));
    const ws = result.contexts["workspace"]!;

    // All workspace tabs are in the config, so availableTabs should be empty
    expect(ws.availableTabs).toHaveLength(0);
  });
});

describe("default tab selection", () => {
  it("selects first enabled required tab as default", () => {
    const config = workspaceOnlyConfig([
      { extensionId: "core.code", tabId: "main", enabled: true },
      { extensionId: "core.chat", tabId: "main", enabled: true },
    ]);

    const result = resolveWorkspaceState(makeInput({ config }));
    const ws = result.contexts["workspace"]!;

    // chat is required and will be injected at position 0
    // So default should be chat
    expect(ws.defaultTabId).toBe("chat");
  });

  it("uses null requestedTab to select default", () => {
    const config = workspaceOnlyConfig([
      { extensionId: "core.chat", tabId: "main", enabled: true },
      { extensionId: "core.code", tabId: "main", enabled: true },
    ]);

    const result = resolveWorkspaceState(
      makeInput({ config, requestedTab: null }),
    );
    const ws = result.contexts["workspace"]!;

    expect(ws.activeTabId).toBe(ws.defaultTabId);
  });
});
