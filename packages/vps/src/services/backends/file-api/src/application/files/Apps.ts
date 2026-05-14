// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Apps Service

import * as fs from 'fs';
import * as path from 'path';
import { SANDBOX_ID_RE } from '@ellul.ai/types';
import { ROOT_DIR, FRAMEWORK_PATTERNS, DEFAULT_PORTS, ZEROCLAW_DIRS } from '../../config';
import { safeReadFile, safeReadDir, safeStat, safeJsonParse, safeExec } from '../../utils';

// Sandbox slug shape — imported from the canonical `@ellul.ai/types`.
const SANDBOX_SLUG_RE = SANDBOX_ID_RE;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Directories to skip when scanning for nested apps — shared non-package dir set.
const SKIP_DIRS = WORKSPACE_NON_PACKAGE_DIRS;

// Explicit monorepo tool config markers
const MONOREPO_MARKERS = ['turbo.json', 'lerna.json', 'pnpm-workspace.yaml', 'nx.json', 'go.work', 'melos.yaml'] as const;

// File markers that indicate a directory contains an app/project
const APP_MARKERS = [
  'package.json', 'requirements.txt', 'pyproject.toml', 'go.mod',
  'Cargo.toml', 'Gemfile', 'composer.json', 'mix.exs', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'index.html',
] as const;

// ---------------------------------------------------------------------------
// Non-Node Backend Detection Helpers
// ---------------------------------------------------------------------------

function findCsproj(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir);
    if (entries.some(f => f.endsWith('.csproj') || f.endsWith('.sln'))) return true;
    for (const e of entries) {
      try {
        const sub = path.join(dir, e);
        if (fs.statSync(sub).isDirectory()) {
          const subFiles = fs.readdirSync(sub);
          if (subFiles.some(f => f.endsWith('.csproj'))) return true;
        }
      } catch {}
    }
  } catch {}
  return false;
}

function hasBackendPython(dir: string): boolean {
  try {
    const markers = ['requirements.txt', 'pyproject.toml'];
    for (const m of markers) {
      const fp = path.join(dir, m);
      if (fs.existsSync(fp)) {
        const content = fs.readFileSync(fp, 'utf8');
        if (/\b(fastapi|flask|django|uvicorn|starlette|sanic|tornado)\b/i.test(content)) return true;
      }
    }
  } catch {}
  return false;
}

function detectPythonFramework(dir: string): string {
  try {
    for (const m of ['requirements.txt', 'pyproject.toml']) {
      const fp = path.join(dir, m);
      if (fs.existsSync(fp)) {
        const content = fs.readFileSync(fp, 'utf8');
        if (/\bfastapi\b/i.test(content)) return 'fastapi';
        if (/\bflask\b/i.test(content)) return 'flask';
        if (/\bdjango\b/i.test(content)) return 'django';
      }
    }
  } catch {}
  return 'python';
}

function hasBackendRuby(dir: string): boolean {
  try {
    const fp = path.join(dir, 'Gemfile');
    if (fs.existsSync(fp)) {
      const content = fs.readFileSync(fp, 'utf8');
      if (/\b(rails|sinatra|grape|roda)\b/i.test(content)) return true;
    }
  } catch {}
  return false;
}

function detectRubyFramework(dir: string): string {
  try {
    const fp = path.join(dir, 'Gemfile');
    if (fs.existsSync(fp)) {
      const content = fs.readFileSync(fp, 'utf8');
      if (/\brails\b/i.test(content)) return 'rails';
      if (/\bsinatra\b/i.test(content)) return 'sinatra';
    }
  } catch {}
  return 'ruby';
}

function detectPhpFramework(dir: string): string {
  try {
    const fp = path.join(dir, 'composer.json');
    if (fs.existsSync(fp)) {
      const content = fs.readFileSync(fp, 'utf8');
      if (/laravel\/framework/i.test(content)) return 'laravel';
    }
  } catch {}
  return 'php';
}

function detectElixirFramework(dir: string): string {
  try {
    const fp = path.join(dir, 'mix.exs');
    if (fs.existsSync(fp)) {
      const content = fs.readFileSync(fp, 'utf8');
      if (/\bphoenix\b/i.test(content)) return 'phoenix';
    }
  } catch {}
  return 'elixir';
}

function findJavaProject(dir: string): boolean {
  return fs.existsSync(path.join(dir, 'pom.xml')) ||
    fs.existsSync(path.join(dir, 'build.gradle')) ||
    fs.existsSync(path.join(dir, 'build.gradle.kts'));
}

function detectJavaFramework(dir: string): string {
  for (const marker of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
    const fp = path.join(dir, marker);
    if (fs.existsSync(fp)) {
      try {
        const content = fs.readFileSync(fp, 'utf8');
        if (/spring-boot/i.test(content)) {
          return marker === 'pom.xml' ? 'spring-boot' : 'spring-boot-gradle';
        }
      } catch {}
      return marker === 'pom.xml' ? 'java-maven' : 'java-gradle';
    }
  }
  return 'java-maven';
}

// Frameworks that are typically frontend vs backend
const FRONTEND_FRAMEWORKS = new Set(['next', 'nextjs', 'remix', 'astro', 'vite', 'cra', 'nuxt', 'vue', 'svelte', 'gatsby', 'static', 'html', 'flutter', 'streamlit', 'gradio']);
const BACKEND_FRAMEWORKS = new Set([
  'express', 'fastify', 'hono', 'koa', 'nestjs',
  'go', 'rust', 'dotnet', 'fastapi', 'flask', 'python',
  'sinatra', 'ruby', 'php', 'elixir',
  'spring-boot', 'spring-boot-gradle', 'java-maven', 'java-gradle',
  'bun',
]);

const FULLSTACK_FRAMEWORKS = new Set([
  'rails', 'laravel', 'django', 'phoenix',
]);

// Determine app type from framework name.
function getTypeFromFramework(framework: string): 'frontend' | 'backend' | 'library' {
  if (FRONTEND_FRAMEWORKS.has(framework)) return 'frontend';
  if (FULLSTACK_FRAMEWORKS.has(framework)) return 'frontend';
  if (BACKEND_FRAMEWORKS.has(framework)) return 'backend';
  return 'library';
}

// sandbox  — `sbx-xyz/`, a container of independent apps. Never a monorepo. No package.json at root.
export type AppKind = 'sandbox' | 'app' | 'package';

// Detected app/project info.
export interface AppInfo {
  kind: AppKind;
  name: string;
  displayName?: string; // Mutable user-facing name from ellul.json (slug is the directory)
  directory: string;  // Relative path from ROOT_DIR (e.g. 'sbx-xyz', 'sbx-xyz/my-app', or 'sbx-xyz/my-turbo/packages/web')
  sandboxId: string;  // First segment — the sandbox slug (always present, equals `directory` for kind=sandbox)
  appRoot?: string;   // First two segments for app/package entries (e.g. 'sbx-xyz/my-app'). Undefined for kind=sandbox.
  path: string;
  framework: string;
  port: number;
  hasPackageJson: boolean;
  type: 'frontend' | 'backend' | 'library' | 'monorepo';
  previewable: boolean;
  scripts?: string[];
  dependencies?: string[];
  isRunning?: boolean;
  isMonorepo?: boolean;
  packages?: string[];
  monorepo?: string;  // Parent monorepo name — set on package entries only
  // How this app came to exist. `'scaffold'` = created via scaffold_project;
  origin?: 'scaffold' | 'git' | 'blank';
}

// Split any sandbox-relative path into its sandbox/app/package coordinates.
export function resolveAppPaths(dir: string): {
  sandboxId: string;
  appRoot: string | null;
  appDirectory: string;
  isMonorepoPackage: boolean;
} {
  const parts = dir.split('/').filter(Boolean);
  const sandboxId = parts[0] || '';
  const appRoot = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return {
    sandboxId,
    appRoot,
    appDirectory: dir,
    isMonorepoPackage: parts.length >= 3,
  };
}

// Detect framework from package.json dependencies.
function detectFramework(packageJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }): string {
  const allDeps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  for (const [framework, patterns] of Object.entries(FRAMEWORK_PATTERNS)) {
    for (const dep of patterns.packageJson) {
      if (allDeps[dep]) {
        return framework;
      }
    }
  }

  return 'unknown';
}

// Detect framework from config files.
function detectFrameworkFromFiles(projectPath: string): string | null {
  for (const [framework, patterns] of Object.entries(FRAMEWORK_PATTERNS)) {
    for (const file of patterns.files) {
      if (fs.existsSync(path.join(projectPath, file))) {
        return framework;
      }
    }
  }
  return null;
}

// Get default port for a framework.
function getDefaultPort(framework: string): number {
  return DEFAULT_PORTS[framework] ?? DEFAULT_PORTS.unknown ?? 3000;
}

// ---------------------------------------------------------------------------
// Core Detection: detectAppAt()
// ---------------------------------------------------------------------------

// Detect an app at a given directory path. Reused for both direct-child app scanning
type DetectedApp = Omit<AppInfo, 'kind' | 'sandboxId' | 'appRoot' | 'directory' | 'monorepo'>;

function detectAppAt(projectPath: string, dirName: string): DetectedApp | null {
  const stats = safeStat(projectPath);
  if (!stats?.isDirectory()) return null;

  // Check for package.json
  const packageJsonPath = path.join(projectPath, 'package.json');
  const packageJsonContent = safeReadFile(packageJsonPath);
  const packageJson = safeJsonParse<{
    name?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(packageJsonContent, {});

  const hasPackageJson = !!packageJsonContent;

  // Detect framework — Bun first (bun.lockb projects also have package.json)
  let framework: string | null = null;
  if (fs.existsSync(path.join(projectPath, 'bun.lockb'))) {
    framework = 'bun';
  }
  if (!framework) {
    framework = detectFrameworkFromFiles(projectPath);
  }
  if (!framework && hasPackageJson) {
    framework = detectFramework(packageJson);
  }
  framework = framework || 'unknown';

  // Non-Node backend detection from file markers
  if (framework === 'unknown' && !hasPackageJson) {
    if (fs.existsSync(path.join(projectPath, 'go.mod'))) {
      framework = 'go';
    } else if (fs.existsSync(path.join(projectPath, 'Cargo.toml'))) {
      framework = 'rust';
    } else if (findCsproj(projectPath)) {
      framework = 'dotnet';
    } else if (findJavaProject(projectPath)) {
      framework = detectJavaFramework(projectPath);
    } else if (hasBackendPython(projectPath)) {
      framework = detectPythonFramework(projectPath);
    } else if (hasBackendRuby(projectPath)) {
      framework = detectRubyFramework(projectPath);
    } else if (fs.existsSync(path.join(projectPath, 'composer.json'))) {
      framework = detectPhpFramework(projectPath);
    } else if (fs.existsSync(path.join(projectPath, 'mix.exs'))) {
      framework = detectElixirFramework(projectPath);
    }
  }

  // Get port from scripts or use default
  let port = getDefaultPort(framework);

  // Try to detect port from package.json scripts
  if (packageJson.scripts) {
    const devScript = packageJson.scripts.dev || packageJson.scripts.start;
    if (devScript) {
      const portMatch = devScript.match(/--port[=\s]+(\d+)|-p[=\s]+(\d+)/);
      if (portMatch) {
        const portStr = portMatch[1] ?? portMatch[2] ?? '';
        if (portStr) {
          port = parseInt(portStr, 10);
        }
      }
    }
  }

  // Read app-level config: ellul.json in app root, or ellul field in package.json
  const appConfigContent = safeReadFile(path.join(projectPath, 'ellul.json'));
  const appConfig = safeJsonParse<{
    type?: string;
    previewable?: boolean;
    name?: string;
    displayName?: string;
    port?: number;
    framework?: string;
    origin?: 'scaffold' | 'git' | 'blank';
  }>(appConfigContent, {});
  const pkgEllul = (packageJson as Record<string, unknown>).ellul as
    { type?: string; previewable?: boolean; summary?: string } | undefined;

  // ellul.json framework declaration always wins over file-marker detection.
  if (appConfig.framework) {
    framework = appConfig.framework;
    port = getDefaultPort(framework);
  }

  // Priority: app-level ellul.json > package.json ellul field > framework inference
  // Exception: fullstack frameworks were historically misclassified as "backend" —
  // override stored type so existing apps get the correct iframe preview.
  const explicitType = appConfig.type || pkgEllul?.type;
  let type: AppInfo['type'] = (explicitType && explicitType !== 'unknown' && !FULLSTACK_FRAMEWORKS.has(framework))
    ? explicitType as AppInfo['type']
    : getTypeFromFramework(framework);

  // Backend override: if framework detection picked a frontend build tool (e.g. vite)
  if (type === 'frontend' && hasPackageJson) {
    const allDeps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    for (const backendFw of BACKEND_FRAMEWORKS) {
      const patterns = FRAMEWORK_PATTERNS[backendFw as keyof typeof FRAMEWORK_PATTERNS];
      if (patterns?.packageJson?.some((dep: string) => allDeps[dep])) {
        type = 'backend';
        framework = backendFw;
        port = getDefaultPort(backendFw);
        break;
      }
    }
  }

  // Monorepo detection — explicit markers + workspaces
  let isMonorepo = false;
  let packages: string[] | undefined;

  const hasMonorepoMarker = MONOREPO_MARKERS.some(m => fs.existsSync(path.join(projectPath, m)));
  const hasCargoWorkspace = !hasMonorepoMarker && fs.existsSync(path.join(projectPath, 'Cargo.toml'))
    && (safeReadFile(path.join(projectPath, 'Cargo.toml')) ?? '').includes('[workspace]');
  const hasPyWorkspace = !hasMonorepoMarker && !hasCargoWorkspace && fs.existsSync(path.join(projectPath, 'pyproject.toml'))
    && (safeReadFile(path.join(projectPath, 'pyproject.toml')) ?? '').includes('[tool.poetry]');

  if ((hasPackageJson && ((packageJson as Record<string, unknown>).workspaces || hasMonorepoMarker))
      || hasMonorepoMarker || hasCargoWorkspace || hasPyWorkspace) {
    type = 'monorepo';
    isMonorepo = true;
    packages = [];
    for (const dir of ['packages', 'apps']) {
      const subDir = path.join(projectPath, dir);
      const subEntries = safeReadDir(subDir);
      for (const sub of subEntries) {
        if (SKIP_DIRS.has(sub)) continue;
        const subPath = path.join(subDir, sub);
        const subStats = safeStat(subPath);
        if (subStats?.isDirectory()) {
          packages.push(sub);
        }
      }
    }
  }

  // Generic multi-app container detection:
  if (!isMonorepo && framework === 'unknown'
      && !(hasPackageJson && packageJson.scripts && (packageJson.scripts.dev || packageJson.scripts.start))
      && !fs.existsSync(path.join(projectPath, 'index.html'))) {
    const subdirApps = scanSubdirsForMarkers(projectPath);
    if (subdirApps.length > 0) {
      type = 'monorepo';
      isMonorepo = true;
      packages = subdirApps.map(s => s.name);
    }
  }

  // Resolve display name: ellul.json displayName > ellul.json name > package.json name > dirName
  const displayName = appConfig.displayName || appConfig.name || packageJson.name || dirName;

  // Monorepo containers are not directly previewable — user picks a package
  if (isMonorepo) {
    const explicitPreviewable = appConfig.previewable ?? pkgEllul?.previewable;
    if (appConfig.port) port = appConfig.port;
    return {
      name: displayName,
      displayName: appConfig.displayName || undefined,
      path: projectPath,
      framework,
      port,
      hasPackageJson,
      type,
      previewable: explicitPreviewable === true ? true : false,
      scripts: packageJson.scripts ? Object.keys(packageJson.scripts) : undefined,
      dependencies: packageJson.dependencies ? Object.keys(packageJson.dependencies) : undefined,
      isMonorepo: true,
      packages,
      ...(appConfig.origin ? { origin: appConfig.origin } : {}),
    };
  }

  const explicitPreviewable = appConfig.previewable ?? pkgEllul?.previewable;
  const detectedPreviewable = type === 'frontend'
    || type === 'backend'
    || fs.existsSync(path.join(projectPath, 'index.html'));
  const previewable = explicitPreviewable ?? detectedPreviewable;

  if (appConfig.port) port = appConfig.port;

  return {
    name: displayName,
    displayName: appConfig.displayName || undefined,
    path: projectPath,
    framework,
    port,
    hasPackageJson,
    type,
    previewable,
    scripts: packageJson.scripts ? Object.keys(packageJson.scripts) : undefined,
    dependencies: packageJson.dependencies ? Object.keys(packageJson.dependencies) : undefined,
    ...(appConfig.origin ? { origin: appConfig.origin } : {}),
  };
}

// ---------------------------------------------------------------------------
// Subdirectory Scanning Helpers
// ---------------------------------------------------------------------------

// ONE level deep only — never recursive. Used for generic multi-app detection.
function scanSubdirsForMarkers(dir: string): { name: string; subPath: string }[] {
  const results: { name: string; subPath: string }[] = [];
  const entries = safeReadDir(dir);

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;

    const subPath = path.join(dir, entry);
    const stats = safeStat(subPath);
    if (!stats?.isDirectory()) continue;

    // Check if this subdirectory has any app marker files
    const hasMarker = APP_MARKERS.some(marker => fs.existsSync(path.join(subPath, marker)));
    // config-only repos that don't have a framework marker) by their
    const hasEllulApp = fs.existsSync(path.join(subPath, 'ellul.json'));
    if (hasMarker || findCsproj(subPath) || hasEllulApp) {
      results.push({ name: entry, subPath });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Workspaces layout resolution (re-exported from shared module so existing
// ---------------------------------------------------------------------------
export { resolveWorkspaceLayout, type WorkspaceLayout } from '@vps/shared/app-workspace';
import { resolveWorkspaceLayout as _resolveWorkspaceLayout, WorkspaceConfigError, WORKSPACE_NON_PACKAGE_DIRS } from '@vps/shared/app-workspace';

// Get subdirectories to expand for a monorepo entry.
function getMonorepoSubdirs(monoPath: string, hasWorkspaces: boolean): { subPath: string; relDir: string }[] {
  const results: { subPath: string; relDir: string }[] = [];

  if (hasWorkspaces) {
    // Strict resolver — throws on malformed config. We catch here so a
    let layout: ReturnType<typeof _resolveWorkspaceLayout>;
    try {
      layout = _resolveWorkspaceLayout(monoPath);
    } catch (err) {
      if (err instanceof WorkspaceConfigError) {
        console.warn(`[apps.service] Workspace config error at ${monoPath}: ${err.message}`);
        return results;
      }
      throw err;
    }
    if (!layout) return results;

    // Handle explicit dirs (Go go.work, Rust explicit Cargo.toml members)
    if (layout.explicitDirs) {
      for (const dir of layout.explicitDirs) {
        const subPath = path.join(monoPath, dir);
        if (safeStat(subPath)?.isDirectory()) {
          results.push({ subPath, relDir: dir });
        }
      }
    }

    for (const glob of layout.globs) {
      const prefix = glob.slice(0, glob.length - 2);
      const wsDir = path.join(monoPath, prefix);
      const entries = safeReadDir(wsDir);
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry)) continue;
        const subPath = path.join(wsDir, entry);
        const stats = safeStat(subPath);
        if (stats?.isDirectory()) {
          results.push({ subPath, relDir: `${prefix}/${entry}` });
        }
      }
    }
  } else {
    // Generic multi-app: scan immediate subdirectories with app markers
    const subdirApps = scanSubdirsForMarkers(monoPath);
    for (const { name, subPath } of subdirApps) {
      results.push({ subPath, relDir: name });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Stale Preview Marker Cleanup
// ---------------------------------------------------------------------------

function clearStalePreviewMarker(sandboxId: string): void {
  try {
    const home = process.env['HOME'] || '/home/dev';
    const markerPath = path.join(home, '.ellul', 'preview-app');
    const marker = fs.readFileSync(markerPath, 'utf8').trim();
    if (marker && (marker === sandboxId || marker.startsWith(sandboxId + '/'))) {
      fs.writeFileSync(markerPath, '');
      console.log(`[detectApps] Cleared stale preview-app marker pointing to orphan sandbox ${sandboxId}`);
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Orphan Namespace Teardown
// ---------------------------------------------------------------------------

const orphanTeardownInFlight = new Set<string>();

function scheduleOrphanTeardown(sandboxId: string): void {
  if (orphanTeardownInFlight.has(sandboxId)) return;
  orphanTeardownInFlight.add(sandboxId);
  const { exec } = require('node:child_process') as typeof import('node:child_process');
  exec(
    `sudo /usr/local/bin/ellul-agent-namespace teardown ${sandboxId}`,
    { timeout: 15_000 },
    (err, _stdout, stderr) => {
      orphanTeardownInFlight.delete(sandboxId);
      if (err) {
        console.error(`[detectApps] Orphan namespace teardown failed for ${sandboxId}:`, stderr || err.message);
      } else {
        console.log(`[detectApps] Orphan namespace teardown complete for ${sandboxId}`);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Main Detection Entry Point
// ---------------------------------------------------------------------------

// `kind:'sandbox'` entry each. Sandboxes are never previewable and never
export function detectApps(): AppInfo[] {
  const apps: AppInfo[] = [];
  const sandboxEntries = safeReadDir(ROOT_DIR);

  for (const sandboxId of sandboxEntries) {
    // Only iterate proper sandbox slugs — skip legacy stray dirs, ZeroClaw infra, and anything
    if (!SANDBOX_SLUG_RE.test(sandboxId)) continue;
    if (ZEROCLAW_DIRS.has(sandboxId)) continue;
    const sandboxPath = path.join(ROOT_DIR, sandboxId);
    const sandboxStats = safeStat(sandboxPath);
    if (!sandboxStats?.isDirectory()) continue;

    // Read sandbox-level metadata (`ellul.json` at sandbox root = sandbox container metadata).
    const sandboxMetaContent = safeReadFile(path.join(sandboxPath, 'ellul.json'));
    if (!sandboxMetaContent) {
      console.warn(`[detectApps] Skipping orphan sandbox ${sandboxId} (no ellul.json) — scheduling namespace teardown`);
      scheduleOrphanTeardown(sandboxId);
      clearStalePreviewMarker(sandboxId);
      continue;
    }
    const sandboxMeta = safeJsonParse<{ displayName?: string; pinned?: boolean }>(sandboxMetaContent, {});
    const sandboxDisplayName = sandboxMeta.displayName || sandboxId;

    // 1. Sandbox container entry
    apps.push({
      kind: 'sandbox',
      name: sandboxDisplayName,
      displayName: sandboxMeta.displayName || undefined,
      directory: sandboxId,
      sandboxId,
      path: sandboxPath,
      framework: 'unknown',
      port: 0,
      hasPackageJson: false,
      type: 'monorepo',
      previewable: false,
      isMonorepo: false,
    });

    // 2. App pass — scan this sandbox's direct children for anything that looks like an app
    const appEntries = scanSubdirsForMarkers(sandboxPath);
    const appInfos: AppInfo[] = [];
    for (const { name: appSubdir, subPath: appPath } of appEntries) {
      const detected = detectAppAt(appPath, appSubdir);
      if (!detected) continue;
      const appDirectory = `${sandboxId}/${appSubdir}`;
      const appEntry: AppInfo = {
        ...detected,
        kind: 'app',
        directory: appDirectory,
        sandboxId,
        appRoot: appDirectory,
      };
      apps.push(appEntry);
      appInfos.push(appEntry);
    }

    // 3. Package pass — for each app that is itself a workspace monorepo, enumerate its packages
    for (const app of appInfos) {
      if (!app.isMonorepo) continue;

      const pkgJsonContent = safeReadFile(path.join(app.path, 'package.json'));
      const pkgJson = safeJsonParse<Record<string, unknown>>(pkgJsonContent, {});
      const hasWorkspaces = !!(pkgJson.workspaces ||
        MONOREPO_MARKERS.some(m => fs.existsSync(path.join(app.path, m))));

      const packageSubdirs = getMonorepoSubdirs(app.path, hasWorkspaces);
      for (const { subPath, relDir } of packageSubdirs) {
        const packageInfo = detectAppAt(subPath, path.basename(subPath));
        if (!packageInfo) continue;
        // Skip nested monorepos — only one level of package expansion
        if (packageInfo.isMonorepo) continue;

        apps.push({
          ...packageInfo,
          kind: 'package',
          directory: `${app.directory}/${relDir}`,
          sandboxId,
          appRoot: app.directory,
          monorepo: app.name,
        });
      }
    }
  }

  return apps;
}

// Check if an app is running by checking if its port is in use.
export function isAppRunning(port: number): boolean {
  const result = safeExec(`lsof -i :${port} -t`);
  return result.success && result.output.length > 0;
}

// Get running processes on common dev ports.
export function getRunningProcesses(): { port: number; pid: number; command: string }[] {
  const processes: { port: number; pid: number; command: string }[] = [];
  const devPorts = [3000, 3001, 4000, 5000, 5173, 8000, 8080, 8888, 9000];

  for (const port of devPorts) {
    const result = safeExec(`lsof -i :${port} -t`);
    if (result.success && result.output) {
      const pids = result.output.split('\n').filter(Boolean);
      for (const pidStr of pids) {
        const pid = parseInt(pidStr, 10);
        if (isNaN(pid)) continue;

        // Get command for this PID
        const cmdResult = safeExec(`ps -p ${pid} -o comm=`);
        const command = cmdResult.success ? cmdResult.output : 'unknown';

        processes.push({ port, pid, command });
      }
    }
  }

  return processes;
}

// Start an app (run npm/pnpm dev).
export function startApp(
  appPath: string,
  script: string = 'dev'
): { success: boolean; error?: string } {
  // Determine package manager
  const hasYarnLock = fs.existsSync(path.join(appPath, 'yarn.lock'));
  const hasPnpmLock = fs.existsSync(path.join(appPath, 'pnpm-lock.yaml'));

  let pm = 'npm';
  if (hasPnpmLock) pm = 'pnpm';
  else if (hasYarnLock) pm = 'yarn';

  // Start in background
  const result = safeExec(`cd "${appPath}" && nohup ${pm} run ${script} > /dev/null 2>&1 &`);

  return {
    success: result.success,
    error: result.error,
  };
}

// Get app icon path if it exists.
export function getAppIconPath(appPath: string): string | null {
  const iconPaths = [
    'public/favicon.ico',
    'public/favicon.png',
    'public/icon.png',
    'public/logo.png',
    'app/favicon.ico',
    'src/favicon.ico',
  ];

  for (const iconPath of iconPaths) {
    const fullPath = path.join(appPath, iconPath);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  return null;
}
