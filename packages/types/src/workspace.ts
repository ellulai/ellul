/**
 * Workspace configuration types.
 *
 * These are the pure data/config types for the workspace shell.
 * Manifest types and the registry class remain in the console package.
 */

// ─── Config Schema ──────────────────────────────────────────────────────────

export interface WorkspaceConfigV1 {
  version: 1;
  /** Monotonic revision counter for optimistic concurrency */
  revision: number;
  /** Preset ID this config was originally based on (null = fully custom) */
  basedOnPresetId: string | null;
  /** Per-context tab configuration */
  contexts: Record<string, WorkspaceContextConfig>;
}

export interface WorkspaceContextConfig {
  orderedTabs: WorkspaceTabEntry[];
}

export interface WorkspaceTabEntry {
  extensionId: string;
  tabId: string;
  enabled: boolean;
}
