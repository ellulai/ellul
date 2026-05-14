// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Vault Watcher Service
 *
 * Monitors vault directories for file changes and triggers re-indexing.
 * Uses fs.watch with debounced batching to avoid index churn on rapid edits.
 *
 * Architecture:
 *   - One watcher per initialized vault (project)
 *   - 500ms debounce batches concurrent file saves into a single re-index pass
 *   - Only re-indexes changed files (content hash comparison in vault-index.service)
 *   - After re-indexing, re-resolves links and rebuilds scope membership
 *   - Emits 'vault_index_changed' events for downstream consumers (WebSocket broadcast)
 *
 * Security:
 *   - Watcher runs within sovereign-shield process (shield-runner user)
 *   - Index DB in shield-data — agent cannot access
 *   - File reads use the same path validation as vault-index.service
 */

import fs from 'fs';
import path from 'path';
import {
  VAULT_WATCHER_DEBOUNCE_MS,
  VAULT_NOTE_EXTENSIONS,
  VAULT_MAX_NOTE_SIZE,
} from '@vps/shared/vault-types';
import {
  getVaultDb,
  getVaultRoot,
  indexNote,
  resolveAllLinks,
  deleteNoteFromIndex,
  getNoteByPath,
} from './VaultIndex';
import { rebuildAllScopeMemberships } from './VaultScope';

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

type VaultChangeListener = (project: string, changedNotes: string[], deletedNotes: string[]) => void;

interface WatcherState {
  /** Active fs.watch watchers (one per watched directory) */
  watchers: fs.FSWatcher[];
  /** Pending changed file paths (batched before re-index) */
  pendingChanges: Set<string>;
  /** Debounce timer */
  debounceTimer: NodeJS.Timeout | null;
  /** Project slug */
  project: string;
}

// ═══════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════

const activeWatchers = new Map<string, WatcherState>();
const changeListeners: VaultChangeListener[] = [];

// ═══════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════

/**
 * Start watching a vault for file changes.
 * Idempotent — calling with an already-watched project is a no-op.
 */
export function startWatching(project: string): void {
  if (activeWatchers.has(project)) return;

  const vaultRoot = getVaultRoot(project);
  if (!fs.existsSync(vaultRoot)) return;

  const state: WatcherState = {
    watchers: [],
    pendingChanges: new Set(),
    debounceTimer: null,
    project,
  };

  // Watch the vault root recursively
  try {
    const watcher = fs.watch(vaultRoot, { recursive: true }, (eventType, filename) => {
      if (!filename) return;

      // Only watch markdown files
      const ext = path.extname(filename).toLowerCase();
      if (!VAULT_NOTE_EXTENSIONS.has(ext)) return;

      // Skip hidden files and .obsidian
      if (filename.startsWith('.') || filename.includes('/.') || filename.includes('.obsidian')) return;

      // Normalize path separators
      const relPath = filename.replace(/\\/g, '/');
      state.pendingChanges.add(relPath);

      // Debounce
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = setTimeout(() => {
        processPendingChanges(state);
      }, VAULT_WATCHER_DEBOUNCE_MS);
    });

    state.watchers.push(watcher);
    activeWatchers.set(project, state);
  } catch (err) {
    console.error(`[vault-watcher] Failed to start watching ${project}:`, err);
  }
}

/**
 * Stop watching a vault.
 */
export function stopWatching(project: string): void {
  const state = activeWatchers.get(project);
  if (!state) return;

  if (state.debounceTimer) clearTimeout(state.debounceTimer);
  for (const watcher of state.watchers) {
    try { watcher.close(); } catch {}
  }
  activeWatchers.delete(project);
}

/**
 * Stop all watchers. Called on process shutdown.
 */
export function stopAllWatchers(): void {
  for (const project of activeWatchers.keys()) {
    stopWatching(project);
  }
}

/**
 * Register a listener for vault index changes.
 * Called after re-indexing completes with the list of changed/deleted note paths.
 */
export function onVaultChange(listener: VaultChangeListener): void {
  changeListeners.push(listener);
}

/**
 * Check if a project's vault is being watched.
 */
export function isWatching(project: string): boolean {
  return activeWatchers.has(project);
}

// ═══════════════════════════════════════════════════════════════════
// Internal: Process Pending Changes
// ═══════════════════════════════════════════════════════════════════

function processPendingChanges(state: WatcherState): void {
  const { project, pendingChanges } = state;
  if (pendingChanges.size === 0) return;

  const changedPaths = [...pendingChanges];
  pendingChanges.clear();
  state.debounceTimer = null;

  const db = getVaultDb(project);
  const vaultRoot = getVaultRoot(project);
  const changedNotes: string[] = [];
  const deletedNotes: string[] = [];

  // Process each changed file
  for (const relPath of changedPaths) {
    const fullPath = path.join(vaultRoot, relPath);

    // Validate path stays within vault root (prevent traversal)
    const resolved = path.resolve(fullPath);
    if (!resolved.startsWith(path.resolve(vaultRoot) + path.sep) && resolved !== path.resolve(vaultRoot)) {
      continue;
    }

    try {
      const stat = fs.statSync(fullPath);

      // Skip oversized files, symlinks, directories
      if (!stat.isFile()) continue;
      if (stat.size > VAULT_MAX_NOTE_SIZE) continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      indexNote(db, project, relPath, content, stat);
      changedNotes.push(relPath);
    } catch (err: any) {
      // File was deleted or became unreadable
      if (err?.code === 'ENOENT') {
        const existing = getNoteByPath(db, project, relPath);
        if (existing) {
          deleteNoteFromIndex(db, existing.id);
          deletedNotes.push(relPath);
        }
      }
    }
  }

  if (changedNotes.length === 0 && deletedNotes.length === 0) return;

  // Re-resolve all links (changed notes may have created/broken links)
  resolveAllLinks(db, project);

  // Rebuild scope memberships (tags/frontmatter may have changed)
  rebuildAllScopeMemberships(db);

  // Notify listeners
  for (const listener of changeListeners) {
    try {
      listener(project, changedNotes, deletedNotes);
    } catch (err) {
      console.error('[vault-watcher] Listener error:', err);
    }
  }
}
