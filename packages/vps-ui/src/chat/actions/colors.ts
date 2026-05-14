// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// `destructive` / `warning` bucket until a deliberate palette is added.

import type { ActionSeverity } from "@ellul.ai/types";

export interface ActionPalette {
  // Icon-tile background (rounded square behind the lucide icon).
  iconBg: string;
  // Icon-tile hover background.
  iconBgHover: string;
  // Icon colour.
  iconFg: string;
  // Live-ping dot used for pending gate requests.
  pingBg: string;
  // Static gate-request dot colour.
  pingFg: string;
}

// Opinionated palette per severity. `normal` deliberately splits into two
export function paletteFor(severity: ActionSeverity): ActionPalette {
  switch (severity) {
    case "destructive":
      return {
        iconBg: "bg-terra/10",
        iconBgHover: "group-hover:bg-terra/15",
        iconFg: "text-terra",
        pingBg: "bg-terra",
        pingFg: "bg-terra",
      };
    case "warning":
      return {
        iconBg: "bg-sodium/10",
        iconBgHover: "group-hover:bg-sodium/15",
        iconFg: "text-sodium",
        pingBg: "bg-sodium",
        pingFg: "bg-sodium",
      };
    default:
      return {
        iconBg: "bg-sodium/10",
        iconBgHover: "group-hover:bg-sodium/15",
        iconFg: "text-sodium",
        pingBg: "bg-sodium",
        pingFg: "bg-sodium",
      };
  }
}

// Legacy workspace actions (git-push, deploy) keep their original tints
export function legacyPaletteOverride(actionId: string): ActionPalette | null {
  if (actionId === "git-push") {
    return {
      iconBg: "bg-blue-500/10",
      iconBgHover: "group-hover:bg-blue-500/15",
      iconFg: "text-blue-400",
      pingBg: "bg-blue-400",
      pingFg: "bg-blue-500",
    };
  }
  if (actionId === "deploy") {
    return {
      iconBg: "bg-sodium/10",
      iconBgHover: "group-hover:bg-sodium/15",
      iconFg: "text-sodium",
      pingBg: "bg-sodium",
      pingFg: "bg-sodium",
    };
  }
  return null;
}

// Convenience: palette = legacy override ?? severity default.
export function resolvePalette(
  actionId: string,
  severity: ActionSeverity,
): ActionPalette {
  return legacyPaletteOverride(actionId) ?? paletteFor(severity);
}
