// SPDX-License-Identifier: MIT

// Runtime Mode Derivation & Reconciliation

import type { RuntimeMode, ResolvedTab } from "./workspace-extensions";

// ─── Priority ──────────────────────────────────────────────────────────────

export const RUNTIME_MODE_PRIORITY: Record<RuntimeMode, number> = {
  base: 0,
  preview: 1,
};

const VALID_MODES = new Set<string>(Object.keys(RUNTIME_MODE_PRIORITY));

// ─── Derivation (pure) ────────────────────────────────────────────────────

function isContributingTab(tab: ResolvedTab): boolean {
  return tab.enabled && tab.availability.state !== "hidden";
}

function isValidMode(mode: string): mode is RuntimeMode {
  return VALID_MODES.has(mode);
}

// Derive the runtime mode from the current resolved tab state.
export function deriveRuntimeMode(
  resolvedContextTabs: ResolvedTab[],
  activeTabRouteSegment: string,
): RuntimeMode {
  const contributedModes: RuntimeMode[] = [];

  for (const tab of resolvedContextTabs) {
    if (!isContributingTab(tab)) continue;
    if (!tab.contributesMode) continue;

    const isActive = tab.routeSegment === activeTabRouteSegment;
    const isBackground = tab.backgroundRuntime === true;

    if (isActive || isBackground) {
      if (isValidMode(tab.contributesMode)) {
        contributedModes.push(tab.contributesMode);
      }
    }
  }

  if (contributedModes.length === 0) return "base";

  // Pick highest priority
  let best: RuntimeMode = contributedModes[0]!;
  for (let i = 1; i < contributedModes.length; i++) {
    if (RUNTIME_MODE_PRIORITY[contributedModes[i]!] > RUNTIME_MODE_PRIORITY[best]) {
      best = contributedModes[i]!;
    }
  }

  return best;
}

// ─── Reconciliation (single transition point) ─────────────────────────────

// Reconcile a mode transition. Calls `sendContextMode` if and only if
export function reconcileRuntimeMode(
  previousMode: RuntimeMode,
  nextMode: RuntimeMode,
  sendContextMode: (mode: string, app: string | null) => void,
  selectedApp: string | null,
): void {
  if (previousMode !== nextMode) {
    sendContextMode(nextMode, selectedApp);
  }
}
