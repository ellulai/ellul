// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// App workspace helpers: .zeroclaw placement, monorepo layout resolution, active-app lookup.
// Throws WorkspaceConfigError on malformed configs — never silently falls back.

import * as fs from 'fs';
import * as path from 'path';

// ─── Non-package directory names ─────────────────────────────────────────────

// Non-package dirs (tooling, VCS, caches, siblings). Consumers may extend locally.
export const WORKSPACE_NON_PACKAGE_DIRS: ReadonlySet<string> = new Set([
  // VCS / OS
  '.git', '.DS_Store',
  // Package manager caches
  'node_modules', 'vendor', '.pnpm-store', '.yarn', '.bundle',
  // Build outputs
  'dist', 'build', 'out', 'target', '_build', 'bin', 'obj',
  // Test / coverage
  'coverage', '.nyc_output', '__pycache__', '.pytest_cache',
  // Framework caches/outputs
  '.next', '.nuxt', '.astro', '.turbo', '.cache', '.vercel', '.netlify',
  // IDE / dev tooling
  '.vscode', '.idea', '.github', '.husky',
  // Platform-internal
  '.zeroclaw', '.ellul',
  // Legitimate non-package siblings at a monorepo root
  'public', 'static', 'docs', 'scripts', 'tools',
]);

// ─── Errors ──────────────────────────────────────────────────────────────────

export class WorkspaceConfigError extends Error {
  constructor(
    public readonly configFile: string,
    public readonly reason: string,
  ) {
    super(`${configFile}: ${reason}`);
    this.name = 'WorkspaceConfigError';
  }
}

// ─── Workspace layout resolution ─────────────────────────────────────────────

export interface WorkspaceLayout {
  /** Glob patterns from the monorepo config, e.g. ["packages/*", "apps/*"]. */
  globs: string[];
  /** Explicit directory paths (relative to appRoot) for workspaces that enumerate
   *  members rather than globs (Go go.work, Rust Cargo.toml explicit members). */
  explicitDirs?: string[];
  // null when no packageManager field + no non-empty lockfile.
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
  configFile: 'package.json' | 'pnpm-workspace.yaml' | 'lerna.json'
    | 'nx.json' | 'go.work' | 'Cargo.toml' | 'melos.yaml' | 'pyproject.toml';
  // First *-suffixed glob whose prefix exists; else first usable glob; else "packages".
  defaultPackagesDir: string;
}

// Shared strict YAML block-list parser. Handles `key:\n  - "item"` format only.
function parseYamlBlockList(content: string, key: string, fileName: string): string[] {
  const lines = content.split('\n');
  const items: string[] = [];
  let inBlock = false;
  let sawKey = false;
  const keyPattern = new RegExp(`^${key}\\s*:\\s*$`);
  const flowPattern = new RegExp(`^${key}\\s*:\\s*\\[`);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.replace(/\s+$/, '');
    if (line === '' || /^\s*#/.test(line)) continue;

    if (keyPattern.test(line)) {
      if (sawKey) throw new WorkspaceConfigError(fileName, `duplicate \`${key}:\` key`);
      sawKey = true;
      inBlock = true;
      continue;
    }

    if (flowPattern.test(line)) {
      throw new WorkspaceConfigError(
        fileName,
        `flow-style (inline array) ${key} not supported — use block list with \`-\` items`,
      );
    }

    if (!inBlock) {
      if (/^\S/.test(line)) continue;
      continue;
    }

    if (/^\S/.test(line)) { inBlock = false; continue; }

    const itemMatch = line.match(/^(\s+)-\s*(["']?)([^"'\s#]+)\2\s*(#.*)?$/);
    if (!itemMatch) {
      throw new WorkspaceConfigError(fileName, `unparseable list item at line ${i + 1}: ${line.trim()}`);
    }
    const value = itemMatch[3]!;
    if (value.startsWith('&') || value.startsWith('*')) {
      throw new WorkspaceConfigError(fileName, `YAML anchors/aliases not supported at line ${i + 1}`);
    }
    items.push(value);
  }

  if (!sawKey) throw new WorkspaceConfigError(fileName, `missing \`${key}:\` key`);
  return items;
}

// Strict pnpm-workspace.yaml parser: canonical `packages: - "glob"` only; throws on exotic YAML.
function parsePnpmWorkspaceYamlStrict(content: string): string[] {
  const lines = content.split('\n');
  const globs: string[] = [];
  let inPackages = false;
  let sawPackagesKey = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    // Strip trailing whitespace. Keep leading whitespace — we need it to
    // detect list-item indentation.
    const line = raw.replace(/\s+$/, '');

    // Skip blank lines and comment-only lines.
    if (line === '' || /^\s*#/.test(line)) continue;

    // Top-level `packages:` key.
    if (/^packages\s*:\s*$/.test(line)) {
      if (sawPackagesKey) {
        throw new WorkspaceConfigError('pnpm-workspace.yaml', 'duplicate `packages:` key');
      }
      sawPackagesKey = true;
      inPackages = true;
      continue;
    }

    // Flow-style rejection: `packages: [a, b]` is valid YAML but our strict
    // parser refuses it. Catch before the regex above would miss it.
    if (/^packages\s*:\s*\[/.test(line)) {
      throw new WorkspaceConfigError(
        'pnpm-workspace.yaml',
        'flow-style (inline array) packages not supported — use block list with `-` items',
      );
    }

    if (!inPackages) {
      // Some other top-level key — ignore.
      if (/^\S/.test(line)) continue;
      throw new WorkspaceConfigError('pnpm-workspace.yaml', `unexpected line ${i + 1}: ${line}`);
    }

    // Inside packages list. Terminate on the next top-level key (non-indented).
    if (/^\S/.test(line)) {
      inPackages = false;
      continue;
    }

    // Must be a list item: `  - "packages/*"` or `  - packages/*`.
    const itemMatch = line.match(/^(\s+)-\s*(["']?)([^"'\s#]+)\2\s*(#.*)?$/);
    if (!itemMatch) {
      throw new WorkspaceConfigError(
        'pnpm-workspace.yaml',
        `unparseable list item at line ${i + 1}: ${line.trim()}`,
      );
    }
    const value = itemMatch[3]!;
    // Reject YAML anchors/aliases — `- &anchor value` or `- *alias`.
    if (value.startsWith('&') || value.startsWith('*')) {
      throw new WorkspaceConfigError(
        'pnpm-workspace.yaml',
        `YAML anchors/aliases not supported at line ${i + 1}`,
      );
    }
    globs.push(value);
  }

  if (!sawPackagesKey) {
    throw new WorkspaceConfigError('pnpm-workspace.yaml', 'missing `packages:` key');
  }
  return globs;
}

// Parse go.work — `use (./cmd/api\n./cmd/worker)` or single-line `use ./cmd/api`
function parseGoWork(content: string): string[] {
  const dirs: string[] = [];
  let inUseBlock = false;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('//')) continue;
    const single = line.match(/^use\s+(\.\/.+)$/);
    if (single) { dirs.push(single[1]!.replace(/^\.\//, '')); continue; }
    if (line === 'use (' || line === 'use(') { inUseBlock = true; continue; }
    if (line === ')') { inUseBlock = false; continue; }
    if (inUseBlock) {
      const dir = line.replace(/^\.\//, '');
      if (dir && !dir.startsWith('//')) dirs.push(dir);
    }
  }
  return dirs;
}

// Parse Cargo.toml [workspace] members — returns { globs, explicitDirs }
function parseCargoWorkspace(content: string): { globs: string[]; explicitDirs: string[] } | null {
  if (!/^\[workspace\]/m.test(content)) return null;
  const membersMatch = content.match(/^members\s*=\s*\[([\s\S]*?)\]/m);
  if (!membersMatch) return null;
  const items = membersMatch[1]!.match(/"([^"]+)"/g);
  if (!items) return null;
  const globs: string[] = [];
  const explicitDirs: string[] = [];
  for (const item of items) {
    const val = item.replace(/"/g, '');
    if (val.endsWith('/*')) { globs.push(val); }
    else { explicitDirs.push(val); }
  }
  return (globs.length > 0 || explicitDirs.length > 0) ? { globs, explicitDirs } : null;
}

// Parse nx.json workspaceLayout — returns globs for existing apps/libs dirs
function parseNxWorkspace(appRoot: string): string[] | null {
  const nxJsonPath = path.join(appRoot, 'nx.json');
  if (!fs.existsSync(nxJsonPath)) return null;
  let nxJson: { workspaceLayout?: { appsDir?: string; libsDir?: string } };
  try { nxJson = JSON.parse(fs.readFileSync(nxJsonPath, 'utf8')); }
  catch { return null; }
  const appsDir = nxJson?.workspaceLayout?.appsDir ?? 'apps';
  const libsDir = nxJson?.workspaceLayout?.libsDir ?? 'libs';
  const globs: string[] = [];
  for (const dir of [appsDir, libsDir]) {
    if (fs.existsSync(path.join(appRoot, dir))) globs.push(`${dir}/*`);
  }
  return globs.length > 0 ? globs : null;
}

// Parse pyproject.toml for Poetry workspace packages with `from` dirs
function parsePoetryWorkspace(content: string): string[] | null {
  if (!content.includes('[tool.poetry]')) return null;
  const fromDirs = new Set<string>();
  const fromMatches = content.matchAll(/from\s*=\s*"([^"]+)"/g);
  for (const m of fromMatches) fromDirs.add(m[1]!);
  return fromDirs.size > 0 ? Array.from(fromDirs).map(d => `${d}/*`) : null;
}

// Priority: packageManager field → non-empty lockfile. Throws when neither exists.
// Empty lockfiles are probe artifacts (create-next-app etc.) and count as no-signal.
export function detectPackageManager(appRoot: string): WorkspaceLayout['packageManager'] {
  // 1. packageManager field — authoritative, version-pinned, corepack standard
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as { packageManager?: string };
    if (typeof pkg.packageManager === 'string') {
      const m = /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager);
      if (m) return m[1] as WorkspaceLayout['packageManager'];
    }
  } catch { /* package.json missing or unparseable — fall through to lockfile */ }

  // 2. Non-empty lockfile
  const candidates: { pm: WorkspaceLayout['packageManager']; file: string }[] = [
    { pm: 'pnpm', file: 'pnpm-lock.yaml' },
    { pm: 'bun', file: 'bun.lockb' },
    { pm: 'yarn', file: 'yarn.lock' },
    { pm: 'npm', file: 'package-lock.json' },
  ];
  for (const { pm, file } of candidates) {
    const lockPath = path.join(appRoot, file);
    if (!fs.existsSync(lockPath)) continue;
    try {
      if (fs.statSync(lockPath).size === 0) continue;
    } catch { continue; }
    return pm;
  }

  // 3. No authoritative signal — fail explicitly. The user must add a
  // `packageManager` field to their package.json (e.g. `"packageManager": "npm@10.9.7"`).
  throw new WorkspaceConfigError(
    'package.json',
    `no package manager identified at ${appRoot} — set "packageManager" field (e.g. "npm@10.9.7") or commit a lockfile (package-lock.json / pnpm-lock.yaml / yarn.lock / bun.lockb)`,
  );
}

// Returns null for non-monorepo; throws WorkspaceConfigError on malformed config.
export function resolveWorkspaceLayout(appRoot: string): WorkspaceLayout | null {
  let globs: string[] = [];
  let configFile: WorkspaceLayout['configFile'] | null = null;

  // 1. pnpm-workspace.yaml — authoritative for pnpm repos.
  const pnpmYamlPath = path.join(appRoot, 'pnpm-workspace.yaml');
  if (fs.existsSync(pnpmYamlPath)) {
    const content = fs.readFileSync(pnpmYamlPath, 'utf8');
    globs = parsePnpmWorkspaceYamlStrict(content);
    configFile = 'pnpm-workspace.yaml';
  }

  // 2. package.json.workspaces — npm/yarn/bun native.
  if (!configFile) {
    const pkgJsonPath = path.join(appRoot, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      let pkgJson: Record<string, unknown>;
      try {
        pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      } catch (err) {
        throw new WorkspaceConfigError('package.json', `invalid JSON: ${(err as Error).message}`);
      }
      const workspaces = pkgJson.workspaces;
      if (Array.isArray(workspaces)) {
        const strs = workspaces.filter((g): g is string => typeof g === 'string');
        if (strs.length !== workspaces.length) {
          throw new WorkspaceConfigError('package.json', 'workspaces array must contain only strings');
        }
        globs = strs;
        configFile = 'package.json';
      } else if (workspaces && typeof workspaces === 'object' && 'packages' in workspaces) {
        const packages = (workspaces as { packages?: unknown }).packages;
        if (!Array.isArray(packages)) {
          throw new WorkspaceConfigError('package.json', 'workspaces.packages must be an array');
        }
        const strs = packages.filter((g): g is string => typeof g === 'string');
        if (strs.length !== packages.length) {
          throw new WorkspaceConfigError('package.json', 'workspaces.packages must contain only strings');
        }
        globs = strs;
        configFile = 'package.json';
      }
    }
  }

  // 3. lerna.json.packages — legacy but still in the wild.
  if (!configFile) {
    const lernaPath = path.join(appRoot, 'lerna.json');
    if (fs.existsSync(lernaPath)) {
      let lernaJson: { packages?: unknown };
      try {
        lernaJson = JSON.parse(fs.readFileSync(lernaPath, 'utf8'));
      } catch (err) {
        throw new WorkspaceConfigError('lerna.json', `invalid JSON: ${(err as Error).message}`);
      }
      if (Array.isArray(lernaJson.packages)) {
        const strs = lernaJson.packages.filter((g): g is string => typeof g === 'string');
        if (strs.length !== lernaJson.packages.length) {
          throw new WorkspaceConfigError('lerna.json', 'packages array must contain only strings');
        }
        globs = strs;
        configFile = 'lerna.json';
      }
    }
  }

  let explicitDirs: string[] | undefined;

  // 4. nx.json — Nx workspace
  if (!configFile) {
    const nxGlobs = parseNxWorkspace(appRoot);
    if (nxGlobs) {
      globs = nxGlobs;
      configFile = 'nx.json';
    }
  }

  // 5. go.work — Go 1.18+ workspace
  if (!configFile) {
    const goWorkPath = path.join(appRoot, 'go.work');
    if (fs.existsSync(goWorkPath)) {
      const content = fs.readFileSync(goWorkPath, 'utf8');
      const dirs = parseGoWork(content);
      if (dirs.length > 0) {
        configFile = 'go.work';
        explicitDirs = dirs;
      }
    }
  }

  // 6. Cargo.toml [workspace] — Rust workspace
  if (!configFile) {
    const cargoPath = path.join(appRoot, 'Cargo.toml');
    if (fs.existsSync(cargoPath)) {
      const content = fs.readFileSync(cargoPath, 'utf8');
      const result = parseCargoWorkspace(content);
      if (result) {
        globs = result.globs;
        explicitDirs = result.explicitDirs.length > 0 ? result.explicitDirs : undefined;
        configFile = 'Cargo.toml';
      }
    }
  }

  // 7. melos.yaml — Dart/Flutter workspace
  if (!configFile) {
    const melosPath = path.join(appRoot, 'melos.yaml');
    if (fs.existsSync(melosPath)) {
      const content = fs.readFileSync(melosPath, 'utf8');
      globs = parseYamlBlockList(content, 'packages', 'melos.yaml');
      configFile = 'melos.yaml';
    }
  }

  // 8. pyproject.toml — Poetry workspace
  if (!configFile) {
    const pyprojectPath = path.join(appRoot, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
      const content = fs.readFileSync(pyprojectPath, 'utf8');
      const poetryGlobs = parsePoetryWorkspace(content);
      if (poetryGlobs) {
        globs = poetryGlobs;
        configFile = 'pyproject.toml';
      }
    }
  }

  if (!configFile) return null; // Not a monorepo.

  // Validate globs: every glob must be a `<prefix>/*` shape.
  for (const glob of globs) {
    if (glob.includes('**')) {
      throw new WorkspaceConfigError(configFile, `glob "${glob}" contains \`**\` — not supported`);
    }
    if (glob.startsWith('!')) {
      throw new WorkspaceConfigError(configFile, `glob "${glob}" is a negation — not supported`);
    }
    if (!/^[^*?[\]]+\/\*$/.test(glob)) {
      throw new WorkspaceConfigError(configFile, `glob "${glob}" must be \`<prefix>/*\` shape`);
    }
  }

  // Validate explicit dirs
  if (explicitDirs) {
    for (const dir of explicitDirs) {
      if (dir.includes('..') || path.isAbsolute(dir) || dir.includes('*')) {
        throw new WorkspaceConfigError(configFile, `explicit dir "${dir}" must be a safe relative path`);
      }
    }
  }

  if (globs.length === 0 && (!explicitDirs || explicitDirs.length === 0)) {
    throw new WorkspaceConfigError(configFile, 'workspace config is present but empty');
  }

  // Pick the default packages dir: first glob whose literal prefix is an
  // existing directory, else first explicitDir parent, else "packages".
  let defaultPackagesDir = '';
  for (const glob of globs) {
    const prefix = glob.slice(0, glob.length - 2);
    if (fs.existsSync(path.join(appRoot, prefix))) {
      defaultPackagesDir = prefix;
      break;
    }
  }
  if (!defaultPackagesDir && explicitDirs && explicitDirs.length > 0) {
    const firstParent = path.dirname(explicitDirs[0]!);
    defaultPackagesDir = firstParent === '.' ? explicitDirs[0]! : firstParent;
  }
  if (!defaultPackagesDir && globs.length > 0) {
    defaultPackagesDir = globs[0]!.slice(0, globs[0]!.length - 2);
  }
  if (!defaultPackagesDir) {
    defaultPackagesDir = 'packages';
  }

  return {
    globs,
    ...(explicitDirs ? { explicitDirs } : {}),
    packageManager: detectPackageManagerOrNull(appRoot),
    configFile,
    defaultPackagesDir,
  };
}

// Non-throwing variant; null on no signal. Install paths use strict detectPackageManager.
function detectPackageManagerOrNull(appRoot: string): WorkspaceLayout['packageManager'] | null {
  try { return detectPackageManager(appRoot); }
  catch { return null; }
}

export function getInstallCommand(pm: NonNullable<WorkspaceLayout['packageManager']>): { cmd: string; args: string[] } {
  switch (pm) {
    case 'pnpm': return { cmd: 'pnpm', args: ['install'] };
    case 'yarn': return { cmd: 'yarn', args: ['install'] };
    case 'bun':  return { cmd: 'bun',  args: ['install'] };
    case 'npm':  return { cmd: 'npm',  args: ['install'] };
  }
}

// ─── Active-app resolution ──────────────────────────────────────────────────

const APP_MARKERS = [
  'package.json', 'requirements.txt', 'pyproject.toml', 'Cargo.toml',
  'go.mod', 'Gemfile', 'composer.json', 'mix.exs',
];

// Reads ellul.json activeApp; null if empty sandbox; throws on multi-app + missing activeApp.
export function resolveActiveAppPath(sandboxDir: string): string | null {
  // 1. Honor the sandbox's declared activeApp.
  const sandboxMetaPath = path.join(sandboxDir, 'ellul.json');
  if (fs.existsSync(sandboxMetaPath)) {
    let meta: { activeApp?: string | null };
    try {
      meta = JSON.parse(fs.readFileSync(sandboxMetaPath, 'utf8'));
    } catch (err) {
      throw new WorkspaceConfigError('ellul.json', `invalid JSON at ${sandboxMetaPath}: ${(err as Error).message}`);
    }
    if (meta.activeApp) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(meta.activeApp)) {
        throw new WorkspaceConfigError('ellul.json', `invalid activeApp subdir name: ${meta.activeApp}`);
      }
      const candidate = path.join(sandboxDir, meta.activeApp);
      if (!fs.existsSync(candidate)) {
        throw new WorkspaceConfigError('ellul.json', `activeApp "${meta.activeApp}" does not exist at ${candidate}`);
      }
      return candidate;
    }
  }

  // 2. No activeApp declared — detect via marker scan.
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sandboxDir, { withFileTypes: true });
  } catch {
    return null; // Unreadable sandbox — treat as empty.
  }
  const apps = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .filter((e) => APP_MARKERS.some((m) => fs.existsSync(path.join(sandboxDir, e.name, m))));

  if (apps.length === 0) return null;
  if (apps.length === 1) return path.join(sandboxDir, apps[0]!.name);
  throw new WorkspaceConfigError(
    'ellul.json',
    `sandbox at ${sandboxDir} has ${apps.length} apps (${apps.map((a) => a.name).join(', ')}) but no activeApp marker — refusing to guess`,
  );
}

// ─── `.zeroclaw/` + gitignore helpers ───────────────────────────────────────

// Idempotent; called post-scaffold/clone once app dir exists.
export function writeZeroClawWorkspace(appPath: string, appDisplayName: string): void {
  const zcDir = path.join(appPath, '.zeroclaw');
  if (!fs.existsSync(zcDir)) fs.mkdirSync(zcDir, { recursive: true });

  const soulPath = path.join(zcDir, 'SOUL.md');
  if (!fs.existsSync(soulPath)) {
    fs.writeFileSync(soulPath, [
      `# SOUL.md — Dev Assistant`,
      ``,
      `You are a focused development assistant working inside the **${appDisplayName}** app.`,
      ``,
      `## Workspace`,
      `- This directory is the app root. It has its own \`.git\`, \`package.json\`, and \`ellul.json\`.`,
      `- Your working directory is this folder — use it for all file paths.`,
      `- Commit meaningful checkpoints as you work.`,
      `- If this app is a monorepo (workspaces / turbo / pnpm / lerna), new projects become packages inside it.`,
      ``,
      `## Core Principles`,
      `- **Ship code, not conversation.** Help the user build, debug, and deploy.`,
      `- **Be concise and action-oriented.** Suggest what to do next, don't philosophize.`,
      `- **Read before asking.** Check README, package.json, and ellul.json before asking what the project is.`,
      ``,
      `## CLI Setup`,
      `If a CLI tool isn't authenticated, help the user set it up.`,
      `Output [SETUP_CLI:toolname] and the system handles the rest — don't try to run login commands yourself.`,
      ``,
    ].join('\n'), 'utf8');
  }

  const heartbeatPath = path.join(zcDir, 'HEARTBEAT.md');
  if (!fs.existsSync(heartbeatPath)) {
    fs.writeFileSync(heartbeatPath, '# Keep empty to skip heartbeat checks for dev agents.\n', 'utf8');
  }
}

// Post-clone → .git/info/exclude; fresh scaffold → .gitignore. Idempotent; throws on write failure.
export function ensureAppGitignore(appPath: string): void {
  // Reserved platform paths — `.zeroclaw/` is the agent workspace home,
  // `workspace/` is a reserved name for ZeroClaw's internal runtime subdir
  // (we reroute it into `.zeroclaw/runtime` but keep the ignore line as a
  // safety net in case any future ZeroClaw daemon reverts to the old path).
  const entries = ['.zeroclaw/', 'workspace/', 'node_modules/', 'dist/', 'build/', '.env', '.env.*'];
  const infoExcludePath = path.join(appPath, '.git', 'info', 'exclude');
  const useInfoExclude = fs.existsSync(infoExcludePath);
  const targetPath = useInfoExclude
    ? infoExcludePath
    : path.join(appPath, '.gitignore');

  let current = '';
  try {
    current = fs.readFileSync(targetPath, 'utf8');
  } catch { /* file missing — treat as empty */ }

  const existingLines = new Set(
    current.split('\n').map(l => l.trim()).filter(Boolean)
  );
  const missing = entries.filter(e => !existingLines.has(e));
  if (missing.length === 0) return;

  const separator = current && !current.endsWith('\n') ? '\n' : '';
  const append = (current ? separator : '') +
    (current ? '\n# ellul — agent workspace (not tracked)\n' : '# ellul — agent workspace (not tracked)\n') +
    missing.join('\n') + '\n';

  if (useInfoExclude) fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.appendFileSync(targetPath, append);
}
