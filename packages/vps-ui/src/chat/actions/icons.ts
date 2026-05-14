// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Unknown keys fall back to `Zap` — never throws, so an unsynchronised
// registry entry never breaks the dropdown render.

import {
  Activity,
  GitBranch,
  Key,
  Layers,
  Rocket,
  Shield,
  Table,
  Trash,
  Upload,
  Zap,
  type LucideIcon,
} from "lucide-react";

const ICON_MAP: Record<string, LucideIcon> = {
  activity: Activity,
  "git-branch": GitBranch,
  key: Key,
  layers: Layers,
  rocket: Rocket,
  shield: Shield,
  table: Table,
  trash: Trash,
  upload: Upload,
  zap: Zap,
};

export function resolveIconKey(key: string): LucideIcon {
  return ICON_MAP[key] ?? Zap;
}
