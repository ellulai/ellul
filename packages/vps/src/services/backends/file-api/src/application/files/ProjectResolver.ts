// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Thin client for agent-bridge's /api/internal/ensure-projects endpoint.
// Maps relative project names ("sbx-xyz/my-app") to orchestration ProjectIds,
// creating a fresh project (project.create dispatched through the engine) for
// any name that doesn't already have one. Lets file-api stamp every
// ApiApp / ApiPackage with a non-null projectId in the happy path, killing
// the path-suffix fallback that vps-ui used to need.

import * as fs from "fs";

const INTERNAL_TOKEN_PATH = "/run/shield/internal-file-api.token";
const BRIDGE_URL = "http://127.0.0.1:7700/api/internal/ensure-projects";
// Request budget: if the bridge is slow or down, we'd rather return apps
// without projectIds than block the apps list indefinitely. Consumers see
// projectId=null for every app and the iframe handles it gracefully (empty
// thread sidebar until the bridge recovers and the next /api/apps stamps).
const REQUEST_TIMEOUT_MS = 4000;

let cachedToken: string | null = null;

function readToken(): string | null {
  if (cachedToken) return cachedToken;
  try {
    cachedToken = fs.readFileSync(INTERNAL_TOKEN_PATH, "utf8").trim();
    return cachedToken;
  } catch {
    return null;
  }
}

export function invalidateProjectResolverToken(): void {
  cachedToken = null;
}

export interface ProjectEnsureEntry {
  readonly name: string;
  readonly title: string;
}

/**
 * Ensure a projection_projects row exists for every entry — bridge creates
 * one on miss, returns the existing id on hit. Never throws — a bridge
 * failure degrades to an all-null map (same fallback shape resolveProjectIds
 * had), so the apps list still renders during transient bridge outages.
 */
export async function ensureProjectIds(
  entries: ReadonlyArray<ProjectEnsureEntry>,
): Promise<Record<string, string | null>> {
  if (entries.length === 0) return {};
  const token = readToken();
  if (!token) return Object.fromEntries(entries.map((e) => [e.name, null]));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(BRIDGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Token": token,
      },
      body: JSON.stringify({ projects: entries }),
      signal: controller.signal,
    });
    if (resp.status === 401) {
      invalidateProjectResolverToken();
      return Object.fromEntries(entries.map((e) => [e.name, null]));
    }
    if (!resp.ok) {
      return Object.fromEntries(entries.map((e) => [e.name, null]));
    }
    const body = (await resp.json()) as { projectIds?: Record<string, unknown> };
    const out: Record<string, string | null> = {};
    for (const { name } of entries) {
      const v = body.projectIds?.[name];
      out[name] = typeof v === "string" ? v : null;
    }
    return out;
  } catch {
    return Object.fromEntries(entries.map((e) => [e.name, null]));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Collect every directory that should get a projectId — each app root plus
 * each monorepo workspace package. Dedupe by directory; pull a sane title
 * from displayName / name / subdir / basename so the bridge has something
 * to stamp on the projection_projects row when it has to create one.
 */
export function collectProjectEnsureEntries(
  sandboxes: ReadonlyArray<{
    readonly apps: ReadonlyArray<{
      readonly directory: string;
      readonly subdir: string;
      readonly name: string;
      readonly displayName?: string;
      readonly workspacePackages: ReadonlyArray<{
        readonly directory: string;
        readonly name: string;
        readonly displayName?: string;
      }>;
    }>;
  }>,
): ProjectEnsureEntry[] {
  const seen = new Map<string, ProjectEnsureEntry>();
  for (const sandbox of sandboxes) {
    for (const app of sandbox.apps) {
      if (!seen.has(app.directory)) {
        const title =
          (app.displayName && app.displayName.length > 0 && app.displayName) ||
          app.name ||
          app.subdir ||
          app.directory.split("/").pop() ||
          app.directory;
        seen.set(app.directory, { name: app.directory, title });
      }
      for (const pkg of app.workspacePackages) {
        if (seen.has(pkg.directory)) continue;
        const title =
          (pkg.displayName && pkg.displayName.length > 0 && pkg.displayName) ||
          pkg.name ||
          pkg.directory.split("/").pop() ||
          pkg.directory;
        seen.set(pkg.directory, { name: pkg.directory, title });
      }
    }
  }
  return [...seen.values()];
}
