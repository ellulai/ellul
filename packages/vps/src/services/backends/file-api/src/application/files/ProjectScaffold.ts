// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// called per-app (each app is its own git repo) — never at sandbox root.

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

// ─── Types ───────────────────────────────────────────────────────────────────

export type AppType = 'frontend' | 'backend' | 'library' | 'monorepo' | 'unknown';

// App-level metadata — one file per app subfolder inside a sandbox.
export interface AppEllulJson {
  displayName: string;
  type: AppType;
  previewable: boolean;
  origin: 'blank' | 'git' | 'scaffold';
  createdAt: string;
  framework: string | null;
}

// Sandbox-level metadata — one file per sandbox container.
export interface SandboxEllulJson {
  displayName: string;
  createdAt: string;
  pinned: boolean;
  // Last-active app subfolder within this sandbox (relative to sandbox root, e.g. "my-app").
  activeApp: string | null;
}

export interface AppMetadataOpts {
  displayName: string;
  type: AppType;
  previewable: boolean;
  origin: 'blank' | 'git' | 'scaffold';
  framework: string | null;
}

// ─── writeAppMetadata ────────────────────────────────────────────────────────

// Write app-level `ellul.json`. Creation-time only — not for patching.
export function writeAppMetadata(appPath: string, opts: AppMetadataOpts): void {
  const metadata: AppEllulJson = {
    displayName: opts.displayName,
    type: opts.type,
    previewable: opts.previewable,
    origin: opts.origin,
    createdAt: new Date().toISOString(),
    framework: opts.framework,
  };
  fs.writeFileSync(
    path.join(appPath, 'ellul.json'),
    JSON.stringify(metadata, null, 2),
  );
}

// ─── writeSandboxMetadata / updateSandboxActiveApp ───────────────────────────

// `activeApp` starts as null and is updated whenever the user picks an app.
export function writeSandboxMetadata(sandboxPath: string, opts: { displayName: string }): void {
  const metadata: SandboxEllulJson = {
    displayName: opts.displayName,
    createdAt: new Date().toISOString(),
    pinned: false,
    activeApp: null,
  };
  fs.writeFileSync(
    path.join(sandboxPath, 'ellul.json'),
    JSON.stringify(metadata, null, 2),
  );
}

// Read-modify-write the sandbox's `activeApp` subdir. Passing null clears it.
export function updateSandboxActiveApp(sandboxPath: string, activeApp: string | null): void {
  const metaPath = path.join(sandboxPath, 'ellul.json');
  let current: Partial<SandboxEllulJson> = {};
  try {
    current = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch { /* missing or malformed — rewrite below */ }
  const metadata: SandboxEllulJson = {
    displayName: current.displayName || path.basename(sandboxPath),
    createdAt: current.createdAt || new Date().toISOString(),
    pinned: current.pinned ?? false,
    activeApp,
  };
  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
}

// ─── writeZeroClawWorkspace / ensureAppGitignore ────────────────────────────
// existing file-api call sites don't need to change.
export { writeZeroClawWorkspace, ensureAppGitignore } from '@vps/shared/app-workspace';

// ─── bootstrapGit ────────────────────────────────────────────────────────────

// - Never overwrites existing git config
export function bootstrapGit(appPath: string): { success: boolean } {
  if (fs.existsSync(path.join(appPath, '.git'))) {
    return { success: true };
  }

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: appPath, timeout: 10_000, stdio: 'ignore' });
    execFileSync('git', ['config', '--local', 'user.name', 'sandbox'], { cwd: appPath, timeout: 5_000, stdio: 'ignore' });
    execFileSync('git', ['config', '--local', 'user.email', 'sandbox@ellul.ai'], { cwd: appPath, timeout: 5_000, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: appPath, timeout: 10_000, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: appPath, timeout: 10_000, stdio: 'ignore' });
    return { success: true };
  } catch (err) {
    console.warn(`[project-scaffold] bootstrapGit warning for ${appPath}:`, (err as Error).message);
    return { success: false };
  }
}
