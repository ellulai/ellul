// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// SANDBOX  — a top-level `sbx-xxx` directory. Hardened (root-owned,
// APP      — a subfolder inside a sandbox (e.g. `sbx-xxx/my-app/`). Holds

import * as fs from 'fs';
import * as path from 'path';
import type { AppInfo } from '../files/Apps';

// A sandbox (`sbx-xxx`) — the top-level hardened container.
export interface ApiSandbox {
  // Sandbox slug; matches the canonical `SANDBOX_ID_RE` from `@ellul.ai/types`.
  id: string;
  // User-supplied name (from `sbx-xxx/ellul.json.displayName`).
  displayName: string;
  // Absolute filesystem path on the VPS.
  path: string;
  // `true` if the user pinned this sandbox for first-load preference.
  pinned: boolean;
  // ISO timestamp from the sandbox's `ellul.json.createdAt`.
  createdAt?: string;
  // The subfolder name of the sandbox's last-active app (e.g. "my-app"), or null.
  activeApp: string | null;
  // Apps living inside this sandbox. Usually length 0 (empty) or 1 (default single-project).
  apps: ApiApp[];
}

// An app inside a sandbox.
export interface ApiApp {
  // Full directory relative to ROOT_DIR — e.g. "sbx-xxx/my-app". Used for URL routing and preview keys.
  directory: string;
  // Sandbox slug this app belongs to. Equal to `directory.split('/')[0]`.
  sandboxId: string;
  // Subfolder name relative to the sandbox root — e.g. "my-app".
  subdir: string;
  // Label for display (package.json name, ellul.json displayName, or subdir).
  name: string;
  // User-supplied displayName if set in ellul.json.
  displayName?: string;
  // Absolute filesystem path.
  path: string;
  // Detected framework id (next, hono, vite, fastapi, etc.).
  framework: string;
  // App type — picker renders different sections for each.
  type: 'frontend' | 'backend' | 'library' | 'monorepo' | 'unknown';
  // `true` if this app can run a preview server.
  previewable: boolean;
  // Default preview port allocated to this app from the preview registry.
  port: number;
  // Scripts from package.json (`dev`, `build`, etc.).
  scripts?: string[];
  // Package names from package.json dependencies.
  dependencies?: string[];
  // Whether this app has a package.json (node-style projects).
  hasPackageJson: boolean;
  // `true` if the app is a workspace monorepo (turbo/pnpm/lerna).
  isMonorepo: boolean;
  // Workspace package names advertised by a monorepo root.
  packages?: string[];
  // Individual package entries for a monorepo app. Empty for non-monorepo apps.
  workspacePackages: ApiPackage[];
  // Orchestration ProjectId (agent-bridge's internal identity) or null when no
  // thread has bound one yet. Resolved via agent-bridge's /api/internal/resolve-projects.
  projectId: string | null;
  // Locale at scaffold time, recorded in .ellul/project.json by the
  // scaffolder (Phase 7a-NATIVE Layer 2). Null for cloned/imported
  // projects that never went through scaffold_project. Used by
  // vps-ui's LocaleMismatchBanner (Layer 6) to detect when the user
  // toggled locale away from the project's authored language.
  createdLocale: string | null;
}

// A workspace package inside a monorepo app.
export interface ApiPackage {
  // Full directory relative to ROOT_DIR — e.g. "sbx-xxx/my-turbo/packages/web".
  directory: string;
  // Sandbox slug.
  sandboxId: string;
  // App root (first two segments) — e.g. "sbx-xxx/my-turbo".
  appRoot: string;
  // Package display name.
  name: string;
  displayName?: string;
  // Absolute filesystem path.
  path: string;
  // Detected framework id.
  framework: string;
  type: 'frontend' | 'backend' | 'library' | 'unknown';
  previewable: boolean;
  port: number;
  scripts?: string[];
  dependencies?: string[];
  hasPackageJson: boolean;
  // Orchestration ProjectId, or null when no thread has bound one yet.
  projectId: string | null;
}

// Pointer to the user's current selection — persists across page loads.
export interface ApiActiveSelection {
  // Currently active sandbox slug, or null if none.
  sandbox: string | null;
  // Currently active app's full directory (`sandbox/<subdir>`), or null.
  app: string | null;
}

// Response shape for `GET /api/apps`.
export interface ApiAppsResponse {
  sandboxes: ApiSandbox[];
  active: ApiActiveSelection;
  hasConfig: boolean;
}

// Response shape for `GET /api/app/:directory`.
export interface ApiAppResponse {
  // Always present — the sandbox the selection lives in.
  sandbox: ApiSandbox;
  // The selected app. Null when the sandbox is empty (no apps scaffolded yet).
  app: ApiApp | null;
  // The selected package when the request target was a monorepo package path.
  selectedPackage: ApiPackage | null;
  // When the caller requested a sandbox slug and the backend auto-resolved to a
  redirectTo?: string;
  preview: {
    active: boolean;
    app: string | null;
    activated: boolean;
    port: number;
    phase?: import('@ellul.ai/types').PreviewPhase;
    error?: string | null;
    logTail?: string | null;
    healAttempts?: number;
    healStatus?: 'healing' | 'exhausted' | null;
    httpStatus?: number;
    orphanReason?: import('@ellul.ai/types').OrphanReason;
    recoveryHint?: string;
  };
  context: {
    hasProjectContext: boolean;
    hasGlobalContext: boolean;
  };
}

// ─── Shaping helpers ────────────────────────────────────────────────────────

// Cast a flat `AppInfo` (from `detectApps()`) into its API-shape equivalent
function toApiSandbox(info: AppInfo): ApiSandbox {
  return {
    id: info.directory,
    displayName: info.displayName || info.name || info.directory,
    path: info.path,
    pinned: false,
    createdAt: undefined,
    activeApp: null,
    apps: [],
  };
}

function readCreatedLocale(appPath: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(appPath, '.ellul', 'project.json'), 'utf8');
    const parsed = JSON.parse(raw) as { createdLocale?: unknown };
    return typeof parsed.createdLocale === 'string' && parsed.createdLocale.length > 0
      ? parsed.createdLocale
      : null;
  } catch {
    // Missing file (cloned/imported projects), unreadable, malformed JSON, or
    // a field of the wrong type all fall through to "no record" — Layer 6's
    // mismatch detector treats null as "no opinion" and renders nothing.
    return null;
  }
}

function toApiApp(info: AppInfo, workspacePackages: ApiPackage[]): ApiApp {
  const parts = info.directory.split('/');
  const subdir = parts.length >= 2 ? parts[1]! : info.name;
  return {
    directory: info.directory,
    sandboxId: info.sandboxId || parts[0] || '',
    subdir,
    name: info.name,
    displayName: info.displayName,
    path: info.path,
    framework: info.framework,
    type: info.type,
    previewable: info.previewable,
    port: info.port,
    scripts: info.scripts,
    dependencies: info.dependencies,
    hasPackageJson: info.hasPackageJson,
    isMonorepo: info.isMonorepo === true,
    packages: info.packages,
    workspacePackages,
    projectId: null,
    createdLocale: readCreatedLocale(info.path),
  };
}

function toApiPackage(info: AppInfo): ApiPackage {
  return {
    directory: info.directory,
    sandboxId: info.sandboxId || info.directory.split('/')[0] || '',
    appRoot: info.appRoot || info.directory.split('/').slice(0, 2).join('/'),
    name: info.name,
    displayName: info.displayName,
    path: info.path,
    framework: info.framework,
    type: info.type as ApiPackage['type'],
    previewable: info.previewable,
    port: info.port,
    scripts: info.scripts,
    dependencies: info.dependencies,
    hasPackageJson: info.hasPackageJson,
    projectId: null,
  };
}

// Mutate-in-place projectId enrichment for a list of sandboxes. Takes the
// bulk-resolver response (directory → projectId|null) and stamps each ApiApp
// and ApiPackage. Keeps projectId null when the app has no bound project yet.
export function applyProjectIds(
  sandboxes: ApiSandbox[],
  projectIds: Readonly<Record<string, string | null>>,
): void {
  for (const sandbox of sandboxes) {
    for (const app of sandbox.apps) {
      const id = projectIds[app.directory];
      app.projectId = typeof id === 'string' ? id : null;
      for (const pkg of app.workspacePackages) {
        const pkgId = projectIds[pkg.directory];
        pkg.projectId = typeof pkgId === 'string' ? pkgId : null;
      }
    }
  }
}

// monorepo app. Consumers iterate sandboxes directly — they never mix a
export function shapeSandboxList(apps: AppInfo[]): ApiSandbox[] {
  const sandboxesById = new Map<string, ApiSandbox>();
  const appsByAppRoot = new Map<string, ApiApp>();

  // Pass 1 — sandboxes
  for (const entry of apps) {
    if (entry.kind !== 'sandbox') continue;
    sandboxesById.set(entry.directory, toApiSandbox(entry));
  }

  // Pass 2 — apps (nested into their sandbox)
  for (const entry of apps) {
    if (entry.kind !== 'app') continue;
    const sandbox = sandboxesById.get(entry.sandboxId || '');
    if (!sandbox) continue; // orphaned; skip
    const apiApp = toApiApp(entry, []);
    sandbox.apps.push(apiApp);
    appsByAppRoot.set(entry.directory, apiApp);
  }

  // Pass 3 — packages (nested into their monorepo app)
  for (const entry of apps) {
    if (entry.kind !== 'package') continue;
    if (!entry.appRoot) continue;
    const parentApp = appsByAppRoot.get(entry.appRoot);
    if (!parentApp) continue;
    if (entry.previewable) parentApp.workspacePackages.push(toApiPackage(entry));
  }

  // Stable order — alphabetical by sandbox id, apps alphabetical within each.
  const list = Array.from(sandboxesById.values());
  list.sort((a, b) => a.id.localeCompare(b.id));
  for (const sandbox of list) {
    sandbox.apps.sort((a, b) => a.subdir.localeCompare(b.subdir));
    for (const app of sandbox.apps) {
      app.workspacePackages.sort((a, b) => a.directory.localeCompare(b.directory));
    }
  }
  return list;
}

// Resolve a single-entry lookup (`/api/app/:directory`) from the flat
export function shapeSingleSelection(
  apps: AppInfo[],
  selectedDir: string,
): {
  sandbox: ApiSandbox | null;
  app: ApiApp | null;
  selectedPackage: ApiPackage | null;
} {
  const sandboxList = shapeSandboxList(apps);
  const sandboxId = selectedDir.split('/')[0] || '';
  const sandbox = sandboxList.find((s) => s.id === sandboxId) ?? null;
  if (!sandbox) {
    return { sandbox: null, app: null, selectedPackage: null };
  }

  // Selection is just the sandbox
  if (selectedDir === sandboxId) {
    // Auto-pick the sole app if the sandbox has exactly one
    const soleApp = sandbox.apps.length === 1 ? sandbox.apps[0]! : null;
    return { sandbox, app: soleApp, selectedPackage: null };
  }

  // Selection is an app root (two segments)
  const appRoot = selectedDir.split('/').slice(0, 2).join('/');
  const app = sandbox.apps.find((a) => a.directory === appRoot) ?? null;
  if (!app) {
    return { sandbox, app: null, selectedPackage: null };
  }

  // Selection is the app root exactly
  if (selectedDir === appRoot) {
    return { sandbox, app, selectedPackage: null };
  }

  // Selection is a deeper path — must be a monorepo package
  const selectedPackage = app.workspacePackages.find((p) => p.directory === selectedDir) ?? null;
  return { sandbox, app, selectedPackage };
}
