// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/web/src/providerSkillPresentation.ts

import type { ServerProviderSkill } from "@ellul.ai/types";

function titleCaseWords(value: string): string {
  return value
    .split(/[\s:_-]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

export function formatProviderSkillDisplayName(
  skill: Pick<ServerProviderSkill, "name" | "displayName">,
): string {
  const displayName = skill.displayName?.trim();
  if (displayName) return displayName;
  return titleCaseWords(skill.name);
}

export function formatProviderSkillInstallSource(
  skill: Pick<ServerProviderSkill, "path" | "scope">,
  t?: (key: string) => string,
): string | null {
  const normalizedPath = normalizePathSeparators(skill.path);
  if (normalizedPath.includes("/.codex/plugins/") || normalizedPath.includes("/.agents/plugins/")) {
    return t?.("skillSource.app") ?? "App";
  }

  const normalizedScope = skill.scope?.trim().toLowerCase();
  if (normalizedScope === "system") return t?.("skillSource.system") ?? "System";
  if (
    normalizedScope === "project" ||
    normalizedScope === "workspace" ||
    normalizedScope === "local"
  ) {
    return t?.("skillSource.project") ?? "Project";
  }
  if (normalizedScope === "user" || normalizedScope === "personal") return t?.("skillSource.personal") ?? "Personal";
  if (normalizedScope) return titleCaseWords(normalizedScope);

  return null;
}
