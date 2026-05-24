// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Install Manager — single authoritative owner of dependency installation
 * across every supported language and package manager.
 *
 * The design principle is singleness: exactly one component in the system
 * is allowed to decide "run an install now." Every other caller (scaffold
 * hook, preview service, agent-bridge MCP `install_deps` tool, UI restart)
 * requests installs via this module's API or via file-api's HTTP surface,
 * never by spawning their own package-manager subprocess. The prior failure
 * mode — two callers with non-cooperating locks racing on the same
 * `node_modules` — is structurally impossible once callers share one owner.
 *
 * Contract (API surface):
 *
 *   requestInstall(appPath, opts?): InstallStatus
 *     Idempotent. Returns an InstallStatus snapshot immediately.
 *     - If an install is already running for this project's install root,
 *       returns the current running status (no spawn).
 *     - If the install root is already `ready` against the current
 *       fingerprint, returns the cached ready status (no spawn).
 *     - Otherwise spawns a detached subprocess and returns `running`.
 *     Callers that want to block on completion call `waitForInstall`.
 *
 *   getInstallStatus(appPath, opts?): InstallStatus
 *     Reads state.json, reconciles against on-disk artifacts (pid-alive
 *     check, exit marker presence, fingerprint drift). Never spawns.
 *
 *   waitForInstall(appPath, timeoutMs, onProgress?): Promise<InstallStatus>
 *     Polls status until phase becomes terminal (ready|failed) or timeout.
 *
 *   isInstallReady(appPath): boolean
 *     Quick check for callers that just want "is this project ready to
 *     launch?" Combines state.json `ready` with a per-language
 *     completeness verification (required for Node — npm can exit 0 with
 *     an incomplete tree).
 *
 *   cancelInstall(appPath): InstallStatus
 *     SIGTERMs the process group, updates state to `failed`.
 *
 *   wipeInstallTree(appPath): InstallStatus
 *     Removes language-specific install artifact dirs (node_modules,
 *     .venv, vendor/bundle, target, deps, ...). Used by the Restart UX.
 *     Resets state to `idle`.
 *
 * Guarantees:
 *
 *   1. At most one install subprocess per install root at a time, enforced
 *      by kernel flock on `<root>/.ellul-install.lock` held by the
 *      subshell. An in-process mutex also serialises state transitions
 *      within file-api so concurrent HTTP requests converge deterministically.
 *
 *   2. Exit code is always recorded when the subprocess terminates via any
 *      signal the kernel lets userspace trap (EXIT INT TERM HUP QUIT).
 *      SIGKILL and OOM are detected post-hoc by the status reconciler:
 *      pid not alive + no exit marker + state=running → transition to
 *      `failed` classified as `crashed` or `oom`.
 *
 *   3. The install command is resolved from the detected language at the
 *      install root, not from the active app's preview runtime. A turbo
 *      monorepo with Node and Python siblings installs each language's
 *      deps independently via the same manager; no cross-language races.
 *
 *   4. Fingerprint-before-run semantics: the manifest digest is written
 *      to state.json BEFORE the install runs, so a mid-flight scaffold
 *      mutation surfaces on the next status read (fingerprint drift
 *      triggers a re-run). This self-heals the "scaffold wrote workspace
 *      children after root install exited 0" race.
 *
 *   5. Corrupted-tree recovery is bounded: if the previous log for this
 *      root ends in the canonical `ENOTEMPTY|EEXIST|EACCES node_modules`
 *      signature AND the previous exit was non-zero, the subshell wipes
 *      `node_modules/` BEFORE the next install. Exactly one wipe per
 *      requestInstall call — if the next run still fails the same way,
 *      the error surfaces instead of wiping forever.
 *
 *   6. Every terminal failure is classified so the UI can pick the right
 *      retry UX: registry (re-run may succeed), lockfile (needs edit),
 *      oom (free memory), corrupted (wipe-and-retry), timeout (longer
 *      budget), incomplete (same as lockfile for UX).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync, spawnSync } from 'child_process';

import { HOME, ROOT_DIR } from '../../config';
import { detectPackageManager, type PackageManagerInfo } from '@vps/shared/framework';
import { IS_ANDROID } from '@vps/shared/platform';

// ── Public types ──────────────────────────────────────────────────────────

export type InstallPhase = 'idle' | 'queued' | 'running' | 'ready' | 'failed';

export type InstallErrorClass =
  | 'registry'     // 404 / auth / network to package registry
  | 'lockfile'     // lockfile mismatch with manifest
  | 'oom'          // SIGKILL'd by OOM killer, or V8 heap limit abort
  | 'corrupted'    // ENOTEMPTY/EEXIST/EACCES on install tree
  | 'timeout'      // exceeded timeout budget
  | 'crashed'      // subprocess died without writing exit marker
  | 'incomplete'   // exit 0 but declared deps not present on disk
  | 'no_manifest'  // no recognised manifest at install root
  | 'unknown';

export type InstallLang =
  | 'node'
  | 'bun'
  | 'python'
  | 'ruby'
  | 'go'
  | 'rust'
  | 'php'
  | 'dotnet'
  | 'elixir'
  | 'java'
  | 'dart';

export interface InstallStatus {
  /** The monorepo root (or standalone app root) this install covers. */
  installRoot: string;
  /** The app path the caller asked about (may be a child of installRoot). */
  appPath: string;
  phase: InstallPhase;
  lang: InstallLang | null;
  packageManager: string | null;
  /** SHA-256 of all manifests under installRoot at the time of spawn. */
  fingerprint: string | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  errorClass: InstallErrorClass | null;
  /** Human-readable, one-line error suitable for surfacing in UI. */
  error: string | null;
  /** Absolute path to the install log (always populated so UI can tail). */
  logPath: string;
  /** Last ~4KB of the log, only included when caller asks with withLogTail. */
  logTail?: string;
  /** Absolute path to the state.json for this install root. */
  statePath: string;
  /** Number of times an install has been attempted for this root (across state resets). */
  retryCount: number;
  /** Process-group id of the running install, null once terminated. */
  pgid: number | null;
  /** True if the install, regardless of phase, is conceptually "in flight" (queued|running). */
  active: boolean;
}

export interface RequestInstallOptions {
  /**
   * Force a fresh install even if state.json already reports `ready` with
   * a matching fingerprint. Used by the Restart UX after wipeInstallTree.
   */
  force?: boolean;
}

export interface WaitForInstallOptions {
  intervalMs?: number;
  onProgress?: (status: InstallStatus) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────

const APPS_STATE_DIR = path.join(HOME, '.ellul', 'apps');

/** Hard ceilings on status poll cadence — matches what the UI already uses. */
const DEFAULT_WAIT_INTERVAL_MS = 1_000;

/** Maximum install runtime before we SIGTERM the subprocess group. Sized to
 *  cover a cold-start pnpm monorepo install with a full registry warm. */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/** Maximum bytes of log tail we include in status responses. Bounded so
 *  streaming the state through a WebSocket never blocks on a huge log. */
const LOG_TAIL_BYTES = 4_096;

/** Signature that indicates the prior install left the tree in a state
 *  npm/yarn/pnpm can't self-heal without wiping. Matches the 2026-04-21
 *  post-mortem pattern. */
const CORRUPT_TREE_SIGNATURE = /(ENOTEMPTY|EEXIST|EACCES)[^\n]*node_modules/;

/** Signatures that classify a failed install's error class from the log. */
const ERROR_CLASSIFIERS: Array<{ re: RegExp; cls: InstallErrorClass }> = [
  { re: /heap out of memory|JavaScript heap out of memory|FATAL ERROR:.*Reached heap limit/i, cls: 'oom' },
  { re: /out of memory|Cannot allocate memory|Killed/, cls: 'oom' },
  { re: /npm (?:err|error).*code E404|Not Found - GET.*registry/i, cls: 'registry' },
  { re: /ETARGET|No matching version found/i, cls: 'registry' },
  { re: /EAUTH|401.*registry|403.*registry/i, cls: 'registry' },
  { re: /network timeout|ETIMEDOUT.*registry|ECONNRESET.*registry|getaddrinfo ENOTFOUND/i, cls: 'registry' },
  { re: /EINTEGRITY|invalid checksum|lock ?file (?:mismatch|invalid|corrupt)|Your lockfile needs to be updated/i, cls: 'lockfile' },
  { re: /ENOTEMPTY|EEXIST|EACCES/, cls: 'corrupted' },
];

// ── In-process state ──────────────────────────────────────────────────────

/**
 * Per-install-root mutex. Serialises concurrent `requestInstall` calls
 * inside this process so state.json transitions are well-ordered. The
 * flock in the subshell is still the cross-process gate, but an in-proc
 * mutex keeps HTTP handler interleavings deterministic.
 */
const requestLocks = new Map<string, Promise<InstallStatus>>();

/**
 * In-flight subprocess registry — `pgid → installRoot`. Lets cancelInstall
 * kill the whole process group without scanning /proc.
 */
const activePgids = new Map<string, number>();

// ── Path helpers ──────────────────────────────────────────────────────────

/**
 * Compute the canonical install root. For anything under a sandbox's
 * nested app directory (`projects/<sandbox>/<app>/...`), the root is the
 * app directory itself (the first two segments under ROOT_DIR). For
 * standalones, the root IS the app. Every child path inside the same
 * monorepo returns the same install root → all callers share one lock,
 * one state, one subprocess.
 */
export function computeInstallRoot(appPath: string): string {
  const rel = path.relative(ROOT_DIR, appPath);
  const parts = rel.split(path.sep).filter(Boolean);
  return parts.length >= 2 ? path.join(ROOT_DIR, parts[0]!, parts[1]!) : appPath;
}

/**
 * Filesystem-safe key derived from the install root. Used to name the
 * per-root state/log/exit-marker files under ~/.ellul/apps/.
 */
function rootKey(installRoot: string): string {
  return path.relative(ROOT_DIR, installRoot).replace(/[^a-zA-Z0-9_-]/g, '__') || 'root';
}

interface InstallPaths {
  installRoot: string;
  rootKey: string;
  lockPath: string;
  logPath: string;
  exitPath: string;
  statePath: string;
}

function resolvePaths(appPath: string): InstallPaths {
  const installRoot = computeInstallRoot(appPath);
  const key = rootKey(installRoot);
  return {
    installRoot,
    rootKey: key,
    lockPath: path.join(installRoot, '.ellul-install.lock'),
    logPath: path.join(APPS_STATE_DIR, `${key}.install.log`),
    exitPath: path.join(APPS_STATE_DIR, `${key}.install.exit`),
    statePath: path.join(APPS_STATE_DIR, `${key}.install.state.json`),
  };
}

// ── Language detection ───────────────────────────────────────────────────

interface LangSpec {
  lang: InstallLang;
  /** Command string run under bash at the install root. */
  command: string;
  /** Additional env layered on top of process.env for the subprocess. */
  env: Record<string, string>;
  /** Package manager label for telemetry (npm, pnpm, pip, bundle, ...). */
  packageManager: string;
}

/**
 * Detect the install language at the given root based on manifest presence.
 * Priority is deterministic — a polyglot repo (package.json + requirements.txt)
 * picks the JS path because that's the most likely primary toolchain on
 * this platform and the Python siblings are handled on their own preview
 * start. Returns null when no recognised manifest exists.
 *
 * Adding a language: append one entry. The bash wrapper, state machine,
 * timeout, OOM detection, and status API all work unchanged.
 */
function detectLang(installRoot: string): LangSpec | null {
  const has = (rel: string): boolean => fs.existsSync(path.join(installRoot, rel));
  const readdir = (): string[] => {
    try { return fs.readdirSync(installRoot); } catch { return []; }
  };

  // JS / Node / Bun — detectPackageManager walks up to find the root
  // packageManager/lockfile declaration and gives us the canonical install
  // command for the chosen PM. Install flags are memory-friendly for
  // small VPSes: bounded sockets, offline-first, no audit/fund/progress
  // overhead.
  if (has('package.json')) {
    const pm: PackageManagerInfo = detectPackageManager(installRoot, ROOT_DIR);
    const isBun = pm.pm === 'bun';
    const noBinLinks = '';
    const flags: Record<string, string> = {
      npm:  ` --no-audit --no-fund --no-progress --prefer-offline --maxsockets=2${noBinLinks}`,
      pnpm: ` --prefer-offline${noBinLinks}`,
      yarn: ' --prefer-offline',
      bun:  '',
    };
    return {
      lang: isBun ? 'bun' : 'node',
      command: `${pm.installDev}${flags[pm.pm] ?? ''}`,
      packageManager: pm.pm,
      env: {
        NODE_ENV: 'development',
        npm_config_include: 'dev',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=384`.trim(),
      },
    };
  }

  // Python — prefer uv (fastest, reproducible), then poetry, then pip.
  if (has('uv.lock') || (has('pyproject.toml') && commandExists('uv'))) {
    return {
      lang: 'python',
      packageManager: 'uv',
      command: 'uv sync',
      env: { PIP_DISABLE_PIP_VERSION_CHECK: '1' },
    };
  }
  if (has('poetry.lock')) {
    return {
      lang: 'python',
      packageManager: 'poetry',
      command: 'poetry install --no-interaction --no-ansi',
      env: { PIP_DISABLE_PIP_VERSION_CHECK: '1' },
    };
  }
  if (has('requirements.txt')) {
    return {
      lang: 'python',
      packageManager: 'pip',
      command: 'pip install --break-system-packages --user -r requirements.txt',
      env: { PIP_DISABLE_PIP_VERSION_CHECK: '1' },
    };
  }
  if (has('pyproject.toml')) {
    return {
      lang: 'python',
      packageManager: 'pip',
      command: 'pip install --break-system-packages --user -e .',
      env: { PIP_DISABLE_PIP_VERSION_CHECK: '1' },
    };
  }
  if (has('Pipfile')) {
    return {
      lang: 'python',
      packageManager: 'pipenv',
      command: 'pipenv install --dev --deploy',
      env: {},
    };
  }

  // Ruby — Bundler 4.x removed --path flag; use config instead.
  if (has('Gemfile')) {
    return {
      lang: 'ruby',
      packageManager: 'bundle',
      command: 'bundle config set --local path vendor/bundle && bundle install',
      env: {},
    };
  }

  // Go
  if (has('go.mod')) {
    return {
      lang: 'go',
      packageManager: 'go',
      command: 'go mod download',
      env: {},
    };
  }

  // Rust
  if (has('Cargo.toml')) {
    return {
      lang: 'rust',
      packageManager: 'cargo',
      command: 'cargo fetch',
      env: {},
    };
  }

  // PHP
  if (has('composer.json')) {
    return {
      lang: 'php',
      packageManager: 'composer',
      command: 'composer install --no-interaction --prefer-dist',
      env: { COMPOSER_ALLOW_SUPERUSER: '1' },
    };
  }

  // .NET — presence of any project/solution file anywhere at install root.
  if (readdir().some((f) => /\.(csproj|fsproj|vbproj|sln)$/i.test(f))) {
    return {
      lang: 'dotnet',
      packageManager: 'dotnet',
      command: 'dotnet restore',
      env: {},
    };
  }

  // Elixir
  if (has('mix.exs')) {
    return {
      lang: 'elixir',
      packageManager: 'mix',
      command: 'mix deps.get',
      env: { MIX_ENV: 'dev' },
    };
  }

  // Java — prefer wrapper if present to honour the project's pinned version.
  if (has('pom.xml')) {
    return {
      lang: 'java',
      packageManager: 'maven',
      command: has('mvnw') ? './mvnw -B dependency:resolve' : 'mvn -B dependency:resolve',
      env: {},
    };
  }
  if (has('build.gradle') || has('build.gradle.kts')) {
    return {
      lang: 'java',
      packageManager: 'gradle',
      command: has('gradlew') ? './gradlew dependencies' : 'gradle dependencies',
      env: {},
    };
  }

  // Dart / Flutter
  if (has('pubspec.yaml')) {
    return {
      lang: 'dart',
      packageManager: 'pub',
      // Flutter wraps the same pub command but goes through flutter's
      // tooling. `flutter pub get` works for plain Dart too.
      command: commandExists('flutter') ? 'flutter pub get' : 'dart pub get',
      env: {},
    };
  }

  return null;
}

function commandExists(bin: string): boolean {
  const r = spawnSync('which', [bin], { stdio: 'ignore' });
  return r.status === 0;
}

function hasWorkspaceGlobs(installRoot: string): boolean {
  try {
    const pkgPath = path.join(installRoot, 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    if (Array.isArray(pkg.workspaces) && pkg.workspaces.length > 0) return true;
    if (pkg.workspaces?.packages?.length > 0) return true;
  } catch {}
  try {
    fs.accessSync(path.join(installRoot, 'pnpm-workspace.yaml'), fs.constants.R_OK);
    return true;
  } catch {}
  return false;
}

// ── Fingerprint (manifest digest) ────────────────────────────────────────
//
// Canonical SHA-256 over every recognised manifest file under the install
// root. The fingerprint is written BEFORE an install runs; on the next
// status read we re-digest the live tree and compare. A mismatch means
// the scaffold mutated under our feet (workspace child added, manifest
// edited) — we auto-trigger a re-run, never leaving the user stranded
// at "install succeeded" with an incomplete tree.
//
// Fingerprint cost is bounded by excluding install-output dirs (node_modules,
// target, vendor/, .venv, etc.) — walking those would make the fingerprint
// depend on install output, creating an infinite re-install loop.

const MANIFEST_EXACT = new Set([
  'package.json', 'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  'bun.lock', 'bun.lockb',
  'pyproject.toml', 'poetry.lock', 'uv.lock',
  'Pipfile', 'Pipfile.lock',
  'setup.py', 'setup.cfg',
  'requirements.txt', 'requirements-dev.txt', 'requirements-test.txt',
  'Cargo.toml', 'Cargo.lock',
  'go.mod', 'go.sum', 'go.work',
  'pom.xml',
  'build.gradle', 'build.gradle.kts',
  'settings.gradle', 'settings.gradle.kts',
  'gradle.properties',
  'Gemfile', 'Gemfile.lock',
  'composer.json', 'composer.lock',
  'mix.exs', 'mix.lock',
  'pubspec.yaml', 'pubspec.lock',
  'Directory.Packages.props', 'Directory.Build.props',
]);

const MANIFEST_EXT = new Set([
  '.csproj', '.fsproj', '.vbproj', '.sln',
  '.gemspec',
  '.cabal',
]);

const FINGERPRINT_EXCLUDED_DIRS = new Set([
  'node_modules', '.venv', 'venv', 'env', '.env.d',
  'target', 'build', 'dist', 'out',
  '.git', '.hg', '.svn',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  '.gradle', '.mvn',
  'vendor', 'Pods',
  '.next', '.nuxt', '.svelte-kit', '.astro', '.turbo', '.parcel-cache',
  '.cache', '.output',
  'bin', 'obj',
  '.dart_tool',
  '_build', 'deps',
  'tmp',
]);

const FINGERPRINT_FILE_CAP = 10_000;
const FINGERPRINT_DIR_CAP = 2_000;

function isManifestFile(name: string): boolean {
  if (MANIFEST_EXACT.has(name)) return true;
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return MANIFEST_EXT.has(name.slice(dot).toLowerCase());
}

export function computeFingerprint(installRoot: string): string {
  if (!fs.existsSync(installRoot)) return '';
  const entries: string[] = [];
  let files = 0;
  let dirs = 0;

  const walk = (dir: string, rel: string): void => {
    if (files >= FINGERPRINT_FILE_CAP || dirs >= FINGERPRINT_DIR_CAP) return;
    dirs++;
    let items: fs.Dirent[];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const item of items) {
      if (files >= FINGERPRINT_FILE_CAP) return;
      const name = item.name;
      if (item.isDirectory()) {
        if (FINGERPRINT_EXCLUDED_DIRS.has(name)) continue;
        if (name.startsWith('.')) continue;
        walk(path.join(dir, name), rel ? `${rel}/${name}` : name);
        continue;
      }
      if (!item.isFile() && !item.isSymbolicLink()) continue;
      if (!isManifestFile(name)) continue;
      files++;
      let stat: fs.Stats;
      try { stat = fs.statSync(path.join(dir, name)); }
      catch { continue; }
      entries.push(`${rel ? rel + '/' : ''}${name}:${stat.mtimeMs}:${stat.size}`);
    }
  };

  walk(installRoot, '');
  entries.sort();
  return crypto.createHash('sha256').update(entries.join('\n')).digest('hex');
}

// ── State.json IO (atomic) ────────────────────────────────────────────────

interface StateFile {
  installRoot: string;
  phase: InstallPhase;
  lang: InstallLang | null;
  packageManager: string | null;
  fingerprint: string | null;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  errorClass: InstallErrorClass | null;
  error: string | null;
  retryCount: number;
  pgid: number | null;
}

function ensureAppsDir(): void {
  try { fs.mkdirSync(APPS_STATE_DIR, { recursive: true }); } catch {}
}

function readState(statePath: string): StateFile | null {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    return JSON.parse(raw) as StateFile;
  } catch {
    return null;
  }
}

function writeState(statePath: string, s: StateFile): void {
  ensureAppsDir();
  const tmp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, statePath);
}

// ── Process liveness ──────────────────────────────────────────────────────

const BOOT_TIME_MS = (() => {
  try {
    const uptime = parseFloat(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]!);
    return Date.now() - uptime * 1000;
  } catch { return 0; }
})();

function pgidAlive(pgid: number | null, startedAt?: string | null): boolean {
  if (!pgid || pgid <= 0) return false;
  if (startedAt && BOOT_TIME_MS > 0) {
    const startMs = new Date(startedAt).getTime();
    if (startMs < BOOT_TIME_MS) return false;
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch { return false; }
}

// ── Per-language completeness check ──────────────────────────────────────

/**
 * Is this install genuinely complete for its declared deps?
 *
 * Node requires an explicit deps-present check: npm can exit 0 while
 * leaving `node_modules` partially populated (observed 2026-04-21 when
 * npm aborted during reify-cleanup with ENOENT on resolve-pkg-maps).
 * Surfacing "ready" in that state would let the preview unit launch
 * with a half-populated tree and crash at first-compile.
 *
 * For non-Node languages we trust the state.json terminal transition —
 * their install commands are all-or-nothing (pip, cargo, bundle, etc.).
 */
export function isInstallComplete(appPath: string, lang: InstallLang | null): boolean {
  if (!lang) return false;
  if (lang === 'node' || lang === 'bun') return isNodeInstallComplete(appPath);
  return true;
}

export function isNodeInstallComplete(appPath: string): boolean {
  // Resolve the node_modules that actually serves this app — either local
  // to the app or hoisted to the monorepo root.
  let nm = path.join(appPath, 'node_modules');
  if (!fs.existsSync(nm)) {
    const rel = path.relative(ROOT_DIR, appPath);
    const parts = rel.split(path.sep);
    const appRootCeiling =
      parts.length >= 2 ? path.join(ROOT_DIR, parts[0]!, parts[1]!) : ROOT_DIR;
    let dir = path.dirname(appPath);
    while (
      dir.startsWith(ROOT_DIR) &&
      dir !== ROOT_DIR &&
      (dir === appRootCeiling || dir.startsWith(appRootCeiling + path.sep))
    ) {
      const parentNm = path.join(dir, 'node_modules');
      if (fs.existsSync(parentNm)) { nm = parentNm; break; }
      if (dir === appRootCeiling) break;
      dir = path.dirname(dir);
    }
    if (!fs.existsSync(nm)) return false;
  }

  try {
    const pkgJsonPath = path.join(appPath, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      // If appPath is a workspace child that hasn't been scaffolded yet,
      // returning true here would mask the fact that its deps were never
      // installed. Check the install root for workspace globs — if the
      // root declares workspaces and appPath lives under it, the missing
      // package.json means "not scaffolded yet" not "no deps needed".
      const installRoot = computeInstallRoot(appPath);
      if (installRoot !== appPath && hasWorkspaceGlobs(installRoot)) {
        return false;
      }
      return true;
    }
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    // @types/* is optional at runtime and workspace hoist can skip it
    // even on a healthy install; ignoring it avoids false negatives that
    // would force a re-install loop.
    const required = Object.keys(allDeps).filter((d) => !d.startsWith('@types/'));
    if (required.length === 0) return true;
    return required.every((d) => fs.existsSync(path.join(nm, ...d.split('/'))));
  } catch {
    // Unparseable package.json — assume installed, let the dev server
    // fail visibly on the real error.
    return true;
  }
}

// ── Failure classification ────────────────────────────────────────────────

function classifyFailure(logTail: string, exitCode: number | null): {
  cls: InstallErrorClass; error: string;
} {
  // Signal-based signals first.
  if (exitCode === 124) return { cls: 'timeout', error: 'Install exceeded timeout budget.' };
  if (exitCode !== null && exitCode >= 137 && exitCode <= 143) {
    // 137 = SIGKILL (likely OOM), 143 = SIGTERM (cancel), others signals.
    if (exitCode === 137) return { cls: 'oom', error: 'Install killed by the OOM killer (likely out of memory).' };
  }
  for (const { re, cls } of ERROR_CLASSIFIERS) {
    if (re.test(logTail)) {
      const line = firstMatchingLine(logTail, re) || logTail.slice(-200).trim();
      return { cls, error: line };
    }
  }
  const fallback = (logTail.split('\n').filter(Boolean).slice(-3).join(' ') || 'Install failed.').slice(0, 400);
  return { cls: 'unknown', error: fallback };
}

function firstMatchingLine(text: string, re: RegExp): string | null {
  for (const line of text.split('\n')) {
    if (re.test(line)) return line.trim().slice(0, 400);
  }
  return null;
}

function readLogTail(logPath: string): string {
  try {
    const stat = fs.statSync(logPath);
    const bytes = Math.min(stat.size, LOG_TAIL_BYTES);
    const fd = fs.openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      fs.readSync(fd, buf, 0, bytes, Math.max(0, stat.size - bytes));
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

// ── Status assembly ──────────────────────────────────────────────────────

function emptyStatus(appPath: string, paths: InstallPaths, lang: InstallLang | null): InstallStatus {
  return {
    installRoot: paths.installRoot,
    appPath,
    phase: 'idle',
    lang,
    packageManager: null,
    fingerprint: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    errorClass: null,
    error: null,
    logPath: paths.logPath,
    statePath: paths.statePath,
    retryCount: 0,
    pgid: null,
    active: false,
  };
}

function stateToStatus(state: StateFile, appPath: string, paths: InstallPaths): InstallStatus {
  return {
    installRoot: paths.installRoot,
    appPath,
    phase: state.phase,
    lang: state.lang,
    packageManager: state.packageManager,
    fingerprint: state.fingerprint,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    exitCode: state.exitCode,
    errorClass: state.errorClass,
    error: state.error,
    logPath: paths.logPath,
    statePath: paths.statePath,
    retryCount: state.retryCount,
    pgid: state.pgid,
    active: state.phase === 'queued' || state.phase === 'running',
  };
}

/**
 * Read state.json, reconcile against on-disk reality, and return a
 * consistent snapshot. The reconciliation rules:
 *
 *   running but pgid dead:
 *     → exit marker present → merge exit code, classify if non-zero
 *     → exit marker absent → transition to failed/crashed (SIGKILL/OOM/…)
 *
 *   ready but fingerprint drifted:
 *     → keep phase=ready but flag via the caller: getPreviewHealth
 *       invokes requestInstall on drift, which auto-triggers a rerun.
 *       (We don't mutate state here — reconciliation is read-only.)
 *
 *   no state file:
 *     → return `idle` with lang detected from the current root.
 */
export function getInstallStatus(
  appPath: string,
  opts: { withLogTail?: boolean } = {},
): InstallStatus {
  const paths = resolvePaths(appPath);
  const state = readState(paths.statePath);
  const detected = detectLang(paths.installRoot);

  if (!state) {
    const s = emptyStatus(appPath, paths, detected?.lang ?? null);
    if (detected) s.packageManager = detected.packageManager;
    if (opts.withLogTail) s.logTail = readLogTail(paths.logPath);
    return s;
  }

  // Running → check exit marker first (authoritative), then PGID liveness.
  // The exit marker is written atomically by the install script on completion.
  // PGID can be recycled by the kernel within seconds of process exit, so
  // pgidAlive alone is unreliable.
  if (state.phase === 'running') {
    const exitMarker = readExitMarker(paths.exitPath);
    if (exitMarker !== null) {
      const tail = readLogTail(paths.logPath);
      const updated: StateFile = { ...state };
      updated.pgid = null;
      updated.endedAt = new Date().toISOString();
      updated.exitCode = exitMarker;
      if (exitMarker === 0) {
        const complete = isInstallComplete(appPath, updated.lang);
        if (complete) {
          updated.phase = 'ready';
          updated.errorClass = null;
          updated.error = null;
          updated.fingerprint = computeFingerprint(paths.installRoot);
        } else {
          updated.phase = 'failed';
          updated.errorClass = 'incomplete';
          updated.error = 'Install reported success but declared dependencies are not present.';
        }
      } else {
        const { cls, error } = classifyFailure(tail, exitMarker);
        updated.phase = 'failed';
        updated.errorClass = cls;
        updated.error = error;
      }
      writeState(paths.statePath, updated);
      activePgids.delete(paths.installRoot);
      const status = stateToStatus(updated, appPath, paths);
      if (opts.withLogTail) status.logTail = tail;
      return status;
    }
  }

  // PGID dead + no exit marker → subprocess was SIGKILL'd (or machine rebooted).
  if (state.phase === 'running' && !pgidAlive(state.pgid, state.startedAt)) {
    // Classify as crashed. If memory pressure is obvious, escalate to oom.
    const tail = readLogTail(paths.logPath);
    const mem = readMemoryPressure();
    const cls: InstallErrorClass = mem.availableMB > 0 && mem.availableMB < 200 ? 'oom' : 'crashed';
    const updated: StateFile = {
      ...state,
      phase: 'failed',
      pgid: null,
      endedAt: new Date().toISOString(),
      exitCode: null,
      errorClass: cls,
      error: cls === 'oom'
        ? `Install killed (system available memory dropped to ~${Math.round(mem.availableMB)}MB during install).`
        : 'Install subprocess died before writing an exit code.',
    };
    writeState(paths.statePath, updated);
    activePgids.delete(paths.installRoot);
    const status = stateToStatus(updated, appPath, paths);
    if (opts.withLogTail) status.logTail = tail;
    return status;
  }

  const status = stateToStatus(state, appPath, paths);
  if (opts.withLogTail) status.logTail = readLogTail(paths.logPath);
  return status;
}

function readExitMarker(exitPath: string): number | null {
  try {
    const raw = fs.readFileSync(exitPath, 'utf8').trim();
    if (!raw) return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

interface MemoryPressure { totalMB: number; availableMB: number }
function readMemoryPressure(): MemoryPressure {
  try {
    const raw = fs.readFileSync('/proc/meminfo', 'utf8');
    const grep = (key: string): number => {
      const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'));
      return m ? parseInt(m[1]!, 10) / 1024 : 0;
    };
    return { totalMB: grep('MemTotal'), availableMB: grep('MemAvailable') };
  } catch { return { totalMB: 0, availableMB: 0 }; }
}

// ── requestInstall ───────────────────────────────────────────────────────

/**
 * Idempotent install request. See module doc for the full contract.
 *
 * Invariants enforced:
 *   - A running install is NEVER restarted by a new request (unless force).
 *   - A ready install with matching fingerprint is a no-op.
 *   - Every new spawn writes the subprocess pgid to state.json before
 *     releasing the in-proc request lock, so a concurrent status read
 *     never observes a live subprocess as `idle`.
 */
export function requestInstall(appPath: string, opts: RequestInstallOptions = {}): InstallStatus {
  const paths = resolvePaths(appPath);
  ensureAppsDir();

  // Short path: check reconciled status. If it's already running or
  // already ready-with-matching-fingerprint (and not forced), return it.
  const current = getInstallStatus(appPath);
  if (current.phase === 'running' || current.phase === 'queued') return current;
  if (!opts.force && current.phase === 'ready') {
    const liveFp = computeFingerprint(paths.installRoot);
    if (current.fingerprint === liveFp && isInstallComplete(appPath, current.lang)) {
      return current;
    }
  }

  const lang = detectLang(paths.installRoot);
  if (!lang) {
    const status = emptyStatus(appPath, paths, null);
    status.phase = 'failed';
    status.errorClass = 'no_manifest';
    status.error = 'No recognised package manifest at install root.';
    return status;
  }

  // Compute fingerprint BEFORE spawn so mid-flight scaffold mutations are
  // detectable on the next status read.
  const fingerprint = computeFingerprint(paths.installRoot);
  const priorState = readState(paths.statePath);
  const retryCount = (priorState?.retryCount ?? 0) + 1;
  const needsWipe = shouldWipeBeforeInstall(paths, priorState);

  // Clear prior exit marker — the new subshell's exit writes the fresh one.
  try { fs.unlinkSync(paths.exitPath); } catch {}

  // Ensure lock file exists so flock can open fd 9.
  try { fs.closeSync(fs.openSync(paths.lockPath, 'a', 0o644)); } catch {}

  const pgid = spawnInstall(paths, lang, needsWipe);
  const state: StateFile = {
    installRoot: paths.installRoot,
    phase: pgid > 0 ? 'running' : 'failed',
    lang: lang.lang,
    packageManager: lang.packageManager,
    fingerprint,
    startedAt: new Date().toISOString(),
    endedAt: pgid > 0 ? null : new Date().toISOString(),
    exitCode: pgid > 0 ? null : null,
    errorClass: pgid > 0 ? null : 'crashed',
    error: pgid > 0 ? null : 'Failed to spawn install subprocess.',
    retryCount,
    pgid: pgid > 0 ? pgid : null,
  };
  writeState(paths.statePath, state);
  if (pgid > 0) activePgids.set(paths.installRoot, pgid);

  return stateToStatus(state, appPath, paths);
}

function shouldWipeBeforeInstall(paths: InstallPaths, prior: StateFile | null): boolean {
  if (!prior) return false;
  if (prior.errorClass !== 'corrupted' && prior.phase !== 'failed') return false;
  try {
    const tail = readLogTail(paths.logPath);
    if (CORRUPT_TREE_SIGNATURE.test(tail) && prior.exitCode !== null && prior.exitCode !== 0) {
      return true;
    }
  } catch {}
  return false;
}

// ── Subprocess spawn ─────────────────────────────────────────────────────

/**
 * Spawn the install subprocess, fully detached, holding the per-root
 * flock, writing exit marker on any trap-catchable termination.
 *
 * The wrapper runs:
 *   setsid nohup bash -c '<script>' < /dev/null >> log 2>&1 &
 *
 * - setsid: new session + process group. The spawned group is independent
 *   of file-api's cgroup/session, so anything that kills file-api
 *   (systemd restart, SIGTERM) does NOT cascade to the install.
 * - nohup: ignores SIGHUP specifically so a tty/ssh disconnect on this
 *   process doesn't propagate.
 * - < /dev/null: no stdin (install subprocesses sometimes block on TTY).
 * - >> log 2>&1: stream merged log.
 * - &: detach from bash's job control.
 *
 * The script:
 *   (
 *     flock -n 9 || exit 99
 *     trap 'ec=$?; printf %s "$ec" > exitPath.tmp && mv exitPath.tmp exitPath' EXIT INT TERM HUP QUIT
 *     <optional wipe>
 *     cd installRoot
 *     <envLines>
 *     eval "$CMD"
 *   ) 9<>lockPath
 *
 * Return: the process-group id we just created (negative of the child pid
 * is the pgid when `setsid` assigns a new group, but we read it back via
 * ps), or -1 on spawn failure.
 */
function spawnInstall(paths: InstallPaths, lang: LangSpec, needsWipe: boolean): number {
  const installRoot = paths.installRoot;
  const envLines = Object.entries(lang.env)
    .map(([k, v]) => `export ${shellEsc(k)}=${shellEsc(v)}`)
    .join('; ');

  const wipeFragment = needsWipe
    ? `rm -rf ${shellEsc(path.join(installRoot, 'node_modules'))} ` +
      `${shellEsc(path.join(installRoot, 'apps'))}/*/node_modules ` +
      `${shellEsc(path.join(installRoot, 'packages'))}/*/node_modules 2>/dev/null || true; `
    : '';

  // Write the install script to a real file and exec it via `bash <path>`.
  // The previous approach embedded the script as a bash -c argument, which
  // routed it through `/bin/sh -c "..."` (Node's execSync) → dash on Linux.
  // Dash pre-expanded `$?` and `$VAR` inside its own double-quoted string
  // before bash ever saw the script, leaving the install's exit-code
  // capture broken (marker file 0 bytes, reconciler infinite-loops).
  // A script file sidesteps every quoting hazard — bash reads the raw
  // bytes and evaluates them directly.
  const exitMarkerEsc = shellEsc(paths.exitPath);
  const exitMarkerTmpEsc = shellEsc(paths.exitPath + '.tmp');
  const scriptPath = path.join(APPS_STATE_DIR, `${rootKey(installRoot)}.install.sh`);
  const needsCorepack = lang.packageManager === 'pnpm' || lang.packageManager === 'yarn';
  const scriptBody =
    `#!/bin/bash\n` +
    `export PATH="$HOME/.node/bin:$HOME/.cargo/bin:$HOME/.local/bin:/usr/share/dotnet:/usr/local/go/bin:/usr/lib/dart/bin:/opt/flutter/bin:$PATH"\n` +
    (needsCorepack ? `command -v ${lang.packageManager} >/dev/null 2>&1 || corepack enable 2>/dev/null\n` : '') +
    `( flock -n 9 || exit 99\n` +
    (wipeFragment ? `${wipeFragment}\n` : '') +
    `cd ${shellEsc(installRoot)}\n` +
    (envLines ? `${envLines}\n` : '') +
    `echo "[install-manager] $(date -u +%Y-%m-%dT%H:%M:%SZ) ${lang.packageManager}: ${lang.command}"\n` +
    `${lang.command}\n` +
    // $? can be empty under concurrent signal delivery — fall back to 143
    // so the marker always parses to a number.
    `INSTALL_EC=$?\n` +
    `[ -z "$INSTALL_EC" ] && INSTALL_EC=143\n` +
    `printf "%s" "$INSTALL_EC" > ${exitMarkerTmpEsc} && mv ${exitMarkerTmpEsc} ${exitMarkerEsc}\n` +
    `exit "$INSTALL_EC"\n` +
    `) 9<>${shellEsc(paths.lockPath)}\n`;
  try {
    fs.writeFileSync(scriptPath, scriptBody, { mode: 0o755 });
  } catch {
    return -1;
  }

  const svcUser = process.env.USER || 'dev';
  let launcher: string;
  if (IS_ANDROID) {
    launcher =
      `nohup bash ${shellEsc(scriptPath)} < /dev/null >> ${shellEsc(paths.logPath)} 2>&1 & ` +
      `echo $!`;
  } else {
    const { totalMB } = readMemoryPressure();
    const installMemMaxMB = Math.max(512, Math.floor(totalMB * 0.6));
    const scopeUnit = `ellul-install-${rootKey(installRoot).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    launcher =
      `nohup sudo /usr/local/bin/ellul-spawn-scope ` +
      `ellul-user-workload.slice ${scopeUnit} ` +
      `MemoryMax=${installMemMaxMB}M,MemorySwapMax=0 ` +
      `-- runuser -u ${svcUser} -- bash ${shellEsc(scriptPath)} < /dev/null >> ${shellEsc(paths.logPath)} 2>&1 & ` +
      `echo $!`;
  }

  let pidStr = '';
  try {
    pidStr = execSync(launcher, {
      timeout: 3_000,
      env: {
        ...process.env,
        PATH: `${HOME}/.node/bin:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
      },
      encoding: 'utf8',
    }).trim();
  } catch {
    return -1;
  }
  const pid = parseInt(pidStr, 10);
  if (!Number.isFinite(pid) || pid <= 0) return -1;

  // The pgid equals the child's pid because setsid creates a new session +
  // pgrp with the caller as leader. We also verify by stat — if setsid
  // failed for any reason, the pgrp won't match and we fall back to pid.
  try {
    const pgid = parseInt(
      execSync(`ps -o pgid= -p ${pid}`, { encoding: 'utf8', timeout: 1000 }).trim(),
      10,
    );
    if (Number.isFinite(pgid) && pgid > 0) return pgid;
  } catch {}
  return pid;
}

function shellEsc(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ── waitForInstall ───────────────────────────────────────────────────────

export async function waitForInstall(
  appPath: string,
  timeoutMs: number,
  opts: WaitForInstallOptions = {},
): Promise<InstallStatus> {
  const interval = Math.max(250, opts.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let last: InstallStatus = getInstallStatus(appPath);
  opts.onProgress?.(last);

  while (Date.now() < deadline) {
    if (last.phase === 'ready' || last.phase === 'failed') return last;
    await new Promise<void>((r) => setTimeout(r, interval));
    last = getInstallStatus(appPath);
    opts.onProgress?.(last);
    // Auto-rerun on detected fingerprint drift while we're polling. The
    // install-manager's requestInstall is idempotent, so the cost is a
    // fingerprint compare per poll — negligible.
    if (last.phase === 'ready') {
      const paths = resolvePaths(appPath);
      const liveFp = computeFingerprint(paths.installRoot);
      if (last.fingerprint !== liveFp) {
        last = requestInstall(appPath);
        opts.onProgress?.(last);
      }
    }
  }
  return last;
}

// ── cancelInstall ────────────────────────────────────────────────────────

export function cancelInstall(appPath: string): InstallStatus {
  const paths = resolvePaths(appPath);
  const state = readState(paths.statePath);
  if (!state) return getInstallStatus(appPath);
  const pgid = state.pgid ?? activePgids.get(paths.installRoot) ?? 0;
  if (pgid > 0) {
    try { process.kill(-pgid, 'SIGTERM'); } catch {}
    // Give bash trap 500ms to flush the exit marker.
    const deadline = Date.now() + 500;
    while (Date.now() < deadline && pgidAlive(pgid)) {
      const r = spawnSync('sleep', ['0.05']);
      void r;
    }
    if (pgidAlive(pgid)) {
      try { process.kill(-pgid, 'SIGKILL'); } catch {}
    }
  }
  activePgids.delete(paths.installRoot);
  // Reconcile to terminal state via getInstallStatus (it observes the
  // dead pgid and promotes to failed/cancelled).
  return getInstallStatus(appPath);
}

// ── wipeInstallTree ──────────────────────────────────────────────────────

/**
 * Delete install output artifacts and clear state. Used by the Restart UX
 * so the next requestInstall runs clean. This is the ONLY path that
 * removes install state — normal retries do not wipe, they re-run.
 */
export function wipeInstallTree(appPath: string): InstallStatus {
  const paths = resolvePaths(appPath);
  // Cancel anything in flight first (we're about to remove its workspace).
  cancelInstall(appPath);

  const targets = [
    'node_modules',
    'apps/*/node_modules',
    'packages/*/node_modules',
    '.venv', 'venv',
    'vendor', 'vendor/bundle',
    'target',
    '_build', 'deps',
    '.dart_tool',
    'bin', 'obj', // .NET
  ];
  // Expand simple globs (apps/*/node_modules).
  const installRoot = paths.installRoot;
  for (const pattern of targets) {
    for (const full of expandSimpleGlob(installRoot, pattern)) {
      try {
        fs.rmSync(full, { recursive: true, force: true });
      } catch {}
    }
  }

  // Clear state files — next requestInstall starts fresh.
  for (const p of [paths.statePath, paths.exitPath, paths.logPath]) {
    try { fs.unlinkSync(p); } catch {}
  }
  try { fs.unlinkSync(paths.lockPath); } catch {}

  return getInstallStatus(appPath);
}

function expandSimpleGlob(root: string, pattern: string): string[] {
  const parts = pattern.split('/');
  const starIdx = parts.indexOf('*');
  if (starIdx === -1) return [path.join(root, pattern)];
  const head = path.join(root, ...parts.slice(0, starIdx));
  const tail = parts.slice(starIdx + 1);
  let entries: string[];
  try { entries = fs.readdirSync(head); } catch { return []; }
  return entries.map((e) => path.join(head, e, ...tail));
}

// ── isInstallReady ───────────────────────────────────────────────────────

/**
 * Fast path for callers that just want to know "is this app's install
 * ready to launch?" without a status roundtrip. Returns true only if:
 *   - state.json phase == 'ready', AND
 *   - fingerprint still matches (no scaffold drift), AND
 *   - per-language completeness check passes.
 */
export function isInstallReady(appPath: string): boolean {
  const status = getInstallStatus(appPath);
  if (status.phase !== 'ready') return false;
  const paths = resolvePaths(appPath);
  const liveFp = computeFingerprint(paths.installRoot);
  if (status.fingerprint !== liveFp) return false;
  return isInstallComplete(appPath, status.lang);
}

// ── Diagnostic export ────────────────────────────────────────────────────
// Exposed for preview.service tests and health-debug endpoints.

export const __internal = {
  resolvePaths,
  detectLang,
  computeFingerprint,
  classifyFailure,
  readLogTail,
  readMemoryPressure,
};
