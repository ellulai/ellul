// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// One-way local→VPS sync. 3 layers: L1 fs.watch+5s debounce (degrades on ENOSPC),
// L2 SIGINT/SIGTERM final sync (10s timeout, 2nd SIGINT skips), L3 5-min heartbeat.

import * as fs from 'fs';
import * as path from 'path';
import type { ContentHasher, MerkleResult } from '../shared/content-hash';

/** Interval for heartbeat sync (Layer 3). */
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/** Debounce after file changes before triggering sync (Layer 1). */
const CHANGE_DEBOUNCE_MS = 5_000;

/** Maximum time to wait for a sync on graceful shutdown (per project). */
const SHUTDOWN_SYNC_TIMEOUT_MS = 10_000;

/** Battery threshold for power-saving mode (%). */
const LOW_BATTERY_THRESHOLD = 10;

/** Reduced sync frequency when on low battery. */
const LOW_BATTERY_DEBOUNCE_MS = 60_000;

export type SyncMode = 'watching' | 'heartbeat-only' | 'stopped';

export interface SyncState {
  projectSlug: string;
  mode: SyncMode;
  lastSyncHash: string | null;
  lastSyncAt: number;
  pendingChanges: boolean;
  error: string | null;
}

export interface BackgroundSyncDeps {
  /** The proxy port for uploading to VPS. */
  proxyPort: number;
  /** Content hasher (shared with MCP sync receipt flow). */
  hasher: ContentHasher;
  /** Log function (writes to stderr). */
  log: (msg: string) => void;
}

interface ProjectSync {
  projectSlug: string;
  directory: string;
  watcher: fs.FSWatcher | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  lastSyncHash: string | null;
  lastSyncAt: number;
  syncInFlight: boolean;
  pendingAfterInflight: boolean;
  mode: SyncMode;
  error: string | null;
}

export class BackgroundSyncManager {
  private projects = new Map<string, ProjectSync>();
  private deps: BackgroundSyncDeps;

  constructor(deps: BackgroundSyncDeps) {
    this.deps = deps;
  }

  /**
   * Start background sync for a project.
   * Performs an initial sync immediately, then starts watching + heartbeat.
   */
  async startProject(projectSlug: string, directory: string): Promise<void> {
    if (this.projects.has(projectSlug)) return;

    const ps: ProjectSync = {
      projectSlug,
      directory,
      watcher: null,
      heartbeatTimer: null,
      debounceTimer: null,
      lastSyncHash: null,
      lastSyncAt: 0,
      syncInFlight: false,
      pendingAfterInflight: false,
      mode: 'stopped',
      error: null,
    };

    this.projects.set(projectSlug, ps);

    // Initial sync
    await this.syncProject(ps).catch(() => {});

    // Layer 1: File watcher
    this.startFileWatcher(ps);

    // Layer 3: Heartbeat
    ps.heartbeatTimer = setInterval(() => {
      this.syncProject(ps).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
    ps.heartbeatTimer.unref();
  }

  /**
   * Stop background sync for a project.
   */
  stopProject(projectSlug: string): void {
    const ps = this.projects.get(projectSlug);
    if (!ps) return;

    this.cleanupProject(ps);
    this.projects.delete(projectSlug);
  }

  /**
   * Get sync state for all projects (for REPL /status command).
   */
  getStates(): SyncState[] {
    return [...this.projects.values()].map(ps => ({
      projectSlug: ps.projectSlug,
      mode: ps.mode,
      lastSyncHash: ps.lastSyncHash,
      lastSyncAt: ps.lastSyncAt,
      pendingChanges: ps.pendingAfterInflight || !!ps.debounceTimer,
      error: ps.error,
    }));
  }

  /**
   * Layer 2: Sync all projects before shutdown.
   * Returns when all syncs complete or timeout.
   */
  async syncAllBeforeExit(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const ps of this.projects.values()) {
      if (ps.lastSyncHash === null || ps.pendingAfterInflight || ps.debounceTimer) {
        const syncPromise = Promise.race([
          this.syncProject(ps).then(() => {
            this.deps.log(`[sync] ${ps.projectSlug}: synced before exit`);
          }),
          new Promise<void>((resolve) => {
            setTimeout(() => {
              this.deps.log(`[sync] ${ps.projectSlug}: shutdown sync timed out`);
              resolve();
            }, SHUTDOWN_SYNC_TIMEOUT_MS);
          }),
        ]);
        promises.push(syncPromise);
      }
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  /**
   * Stop all projects and clean up.
   */
  dispose(): void {
    for (const ps of this.projects.values()) {
      this.cleanupProject(ps);
    }
    this.projects.clear();
  }

  // ── Private ──

  private startFileWatcher(ps: ProjectSync): void {
    try {
      ps.watcher = fs.watch(ps.directory, { recursive: true }, (_event, filename) => {
        if (!filename) return;

        // Skip node_modules, .git, and other excluded dirs in the watcher callback
        // (the watcher itself may still create inotify watches on them)
        if (shouldIgnoreWatchEvent(filename)) return;

        this.scheduleSync(ps);
      });

      ps.watcher.on('error', (err) => {
        const errno = err as NodeJS.ErrnoException;
        if (errno.code === 'ENOSPC') {
          // Gotcha #1: Linux inotify limit reached
          this.deps.log(
            `[sync] inotify limit hit for ${ps.projectSlug}. Degrading to heartbeat polling.\n` +
            `[sync] To fix: echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p`,
          );
          if (ps.watcher) {
            ps.watcher.close();
            ps.watcher = null;
          }
          ps.mode = 'heartbeat-only';
        } else {
          this.deps.log(`[sync] Watcher error for ${ps.projectSlug}: ${err.message}`);
        }
      });

      ps.mode = 'watching';
      this.deps.log(`[sync] File watcher started for ${ps.projectSlug}`);
    } catch (err) {
      const errno = err as NodeJS.ErrnoException;
      if (errno.code === 'ENOSPC') {
        // Gotcha #1: inotify limit reached at watch creation time
        this.deps.log(
          `[sync] inotify watch limit reached for ${ps.projectSlug}. Falling back to heartbeat polling.\n` +
          `[sync] To fix: echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p`,
        );
        ps.mode = 'heartbeat-only';
      } else {
        this.deps.log(`[sync] Failed to start watcher for ${ps.projectSlug}: ${errno.message}`);
        ps.mode = 'heartbeat-only';
      }
    }
  }

  private scheduleSync(ps: ProjectSync): void {
    if (ps.syncInFlight) {
      ps.pendingAfterInflight = true;
      return;
    }

    if (ps.debounceTimer) {
      clearTimeout(ps.debounceTimer);
    }

    const debounceMs = isLowBattery() ? LOW_BATTERY_DEBOUNCE_MS : CHANGE_DEBOUNCE_MS;

    ps.debounceTimer = setTimeout(() => {
      ps.debounceTimer = null;
      this.syncProject(ps).catch(() => {});
    }, debounceMs);
  }

  private async syncProject(ps: ProjectSync): Promise<void> {
    if (ps.syncInFlight) {
      ps.pendingAfterInflight = true;
      return;
    }

    ps.syncInFlight = true;
    ps.error = null;

    try {
      // Compute Merkle hash
      const result = await this.deps.hasher.computeMerkleRoot(ps.directory);

      // Skip if hash unchanged since last sync
      if (result.root === ps.lastSyncHash) {
        return;
      }

      // Upload tarball to VPS
      await this.uploadSync(ps, result);

      ps.lastSyncHash = result.root;
      ps.lastSyncAt = Date.now();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ps.error = message;
      this.deps.log(`[sync] Sync failed for ${ps.projectSlug}: ${message}`);
    } finally {
      ps.syncInFlight = false;

      // If changes accumulated during sync, schedule another
      if (ps.pendingAfterInflight) {
        ps.pendingAfterInflight = false;
        this.scheduleSync(ps);
      }
    }
  }

  private async uploadSync(ps: ProjectSync, _merkle: MerkleResult): Promise<void> {
    // Build tarball using the same pattern as ellul-dev.ts
    const tarball = buildSyncTarball(ps.directory);

    const resp = await fetch(
      `http://127.0.0.1:${this.deps.proxyPort}/_auth/exec/sync`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/gzip',
          'X-Ellul-Project': ps.projectSlug, // STS keyed by slug
          'X-Content-Hash': _merkle.root,
        },
        body: new Uint8Array(tarball),
      },
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Sync upload failed: ${resp.status} ${body}`);
    }
  }

  private cleanupProject(ps: ProjectSync): void {
    if (ps.watcher) {
      ps.watcher.close();
      ps.watcher = null;
    }
    if (ps.heartbeatTimer) {
      clearInterval(ps.heartbeatTimer);
      ps.heartbeatTimer = null;
    }
    if (ps.debounceTimer) {
      clearTimeout(ps.debounceTimer);
      ps.debounceTimer = null;
    }
    ps.mode = 'stopped';
  }
}

// ── Helpers ──

/** Patterns to ignore in file watcher callbacks (not worth triggering sync). */
const WATCH_IGNORE_PREFIXES = [
  'node_modules/',
  '.git/',
  '.next/',
  'dist/',
  'build/',
  '__pycache__/',
  '.pytest_cache/',
  '.mypy_cache/',
];

function shouldIgnoreWatchEvent(filename: string): boolean {
  const normalized = filename.replace(/\\/g, '/');
  return WATCH_IGNORE_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

/**
 * Build a gzip tarball of the project directory for sync upload.
 * Uses the same exclusion patterns as ellul-dev.ts.
 */
function buildSyncTarball(directory: string): Buffer {
  const { spawnSync } = require('child_process') as typeof import('child_process');
  const os = require('os') as typeof import('os');

  const excludes = [
    '.git/', '.env', '.env.*', '.envrc', '.ellulignore',
    'credentials.json', 'service-account.json',
    '.npmrc', '.pypirc', '.netrc', '.htpasswd', '.pgpass',
    'node_modules/',
  ];

  // Read .gitignore
  const gitignorePath = path.join(directory, '.gitignore');
  try {
    for (const line of fs.readFileSync(gitignorePath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) excludes.push(trimmed);
    }
  } catch { /* no .gitignore */ }

  // Read .ellulignore
  const ellulignorePath = path.join(directory, '.ellulignore');
  try {
    for (const line of fs.readFileSync(ellulignorePath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) excludes.push(trimmed);
    }
  } catch { /* no .ellulignore */ }

  const excludeFile = path.join(os.tmpdir(), `.ellul-sync-exclude-${process.pid}`);
  try {
    fs.writeFileSync(excludeFile, excludes.join('\n') + '\n');
    const result = spawnSync('tar', ['czf', '-', `--exclude-from=${excludeFile}`, '.'], {
      cwd: directory,
      maxBuffer: 100 * 1024 * 1024,
    });

    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`tar failed: ${result.stderr?.toString()}`);
    }

    return result.stdout as Buffer;
  } finally {
    try { fs.unlinkSync(excludeFile); } catch { /* cleanup */ }
  }
}

/**
 * Check if running on battery with low charge.
 * On low battery, we reduce sync frequency to conserve power.
 */
function isLowBattery(): boolean {
  try {
    if (process.platform === 'darwin') {
      const { spawnSync } = require('child_process') as typeof import('child_process');
      const result = spawnSync('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 2000 });
      if (result.status !== 0) return false;

      const output = result.stdout;
      // Check if on battery (not AC)
      if (!output.includes('Battery Power')) return false;

      // Extract percentage
      const match = output.match(/(\d+)%/);
      if (match) {
        return parseInt(match[1], 10) < LOW_BATTERY_THRESHOLD;
      }
    } else if (process.platform === 'linux') {
      // Check /sys/class/power_supply/BAT0/
      try {
        const status = fs.readFileSync('/sys/class/power_supply/BAT0/status', 'utf8').trim();
        if (status === 'Charging' || status === 'Full') return false;

        const capacity = parseInt(
          fs.readFileSync('/sys/class/power_supply/BAT0/capacity', 'utf8').trim(),
          10,
        );
        return capacity < LOW_BATTERY_THRESHOLD;
      } catch {
        return false; // No battery or can't read
      }
    }
  } catch {
    // Can't determine battery state — assume power is fine
  }
  return false;
}
