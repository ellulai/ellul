// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Project Garbage Collector — Reclaims orphaned root-owned project directories.
 *
 * Orphans occur when shield creates a root-owned project dir (consuming an
 * entitlement slot) but the caller (file-api) crashes before completing setup,
 * or the DELETE cleanup fails. Without GC, the empty root-owned dir persists
 * forever, permanently consuming an entitlement slot.
 *
 * Detection heuristic (ALL must be true):
 *   1. Matches slug regex (sbx-{7 alnum})
 *   2. Owned by root (uid === 0) — created by shield, not agent
 *   3. mtime older than ORPHAN_AGE_MS — prevents racing with in-flight creates
 *   4. No ellul.json — every completed project has this (blank or git)
 *   5. No .git directory — partial clone should not be reclaimed
 *   6. No shielded workspace — tamper-proof marker at /var/lib/ellul-shielded/projects/{slug}/
 *      (agent cannot create/delete this — shield-runner:shield-runner 0700)
 *   7. Effectively empty — 0 entries, or only .zeroclaw directory
 *
 * Security: condition 6 prevents agent manipulation attacks. If an agent
 * deletes ellul.json from a real project to trigger GC, the shielded
 * workspace check blocks reclamation. Agent cannot touch shielded workspaces
 * (parent dir is shield-runner:shield-runner 0700).
 *
 * Schedule: startup sweep (60s delay) + hourly interval.
 * Maximum orphan lifetime: ~2 hours worst case.
 */

import fs from 'fs';
import path from 'path';
import { execSync, execFileSync } from 'child_process';
import { SANDBOX_ID_RE } from '@ellul.ai/types';
import { SVC_HOME } from '../../config';
import { logAuditEvent } from '../audit/Audit';

const PROJECTS_DIR = path.join(SVC_HOME, 'projects');
const SHIELDED_PROJECTS_DIR = '/var/lib/ellul-shielded/projects';
const SLUG_REGEX = SANDBOX_ID_RE;

/** Minimum age before a directory is considered orphaned (1 hour). */
const ORPHAN_AGE_MS = 60 * 60 * 1000;

/** Files/dirs that an empty orphan might contain (from partial create). */
const ALLOWED_ORPHAN_ENTRIES = new Set(['.zeroclaw']);

export function sweepOrphanedProjects(): void {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return;

    const entries = fs.readdirSync(PROJECTS_DIR);
    const now = Date.now();
    let reclaimed = 0;

    for (const entry of entries) {
      if (!SLUG_REGEX.test(entry)) continue;

      const fullPath = path.join(PROJECTS_DIR, entry);

      try {
        const stat = fs.statSync(fullPath);

        // Must be a directory owned by root
        if (!stat.isDirectory() || stat.uid !== 0) continue;

        // Must be older than ORPHAN_AGE_MS (prevents racing with in-flight creates)
        const ageMs = now - stat.mtimeMs;
        if (ageMs < ORPHAN_AGE_MS) continue;

        // If ellul.json exists, this is a completed project — NOT an orphan
        if (fs.existsSync(path.join(fullPath, 'ellul.json'))) continue;

        // If .git exists, this might be a partial clone — don't reclaim
        if (fs.existsSync(path.join(fullPath, '.git'))) continue;

        // Tamper-proof check: if shielded workspace exists, this is a real project
        // whose ellul.json was deleted (possibly by agent). Do NOT reclaim.
        const shieldedWorkspace = path.join(SHIELDED_PROJECTS_DIR, entry, 'workspace');
        if (fs.existsSync(shieldedWorkspace)) continue;

        // Must be effectively empty (only allowed entries like .zeroclaw)
        const contents = fs.readdirSync(fullPath);
        const hasUnexpected = contents.some(c => !ALLOWED_ORPHAN_ENTRIES.has(c));
        if (hasUnexpected) continue;

        // All checks passed — this is an orphan. Reclaim it.
        console.log(`[project-gc] Reclaiming orphaned project dir: ${entry} (age: ${Math.round(ageMs / 60000)}min)`);

        try {
          execFileSync('sudo', ['/usr/local/bin/shield-project-lock', 'rm', entry], {
            stdio: 'pipe',
            timeout: 5000,
          });
        } catch (rmErr) {
          console.error(`[project-gc] Failed to rm ${entry}:`, (rmErr as Error).message);
          continue;
        }

        // Clean up any partial shielded dirs (shouldn't exist per check above, but belt+suspenders)
        try {
          fs.rmSync(path.join(SHIELDED_PROJECTS_DIR, entry), { recursive: true, force: true });
        } catch {}
        try {
          fs.rmSync(path.join(SHIELDED_PROJECTS_DIR, `${entry}.epoch`), { force: true });
        } catch {}

        logAuditEvent({
          type: 'project_gc_reclaimed',
          ip: 'system',
          details: { slug: entry, ageMinutes: Math.round(ageMs / 60000) },
        });

        reclaimed++;
      } catch {
        // stat or readdir failed for this entry — skip
      }
    }

    if (reclaimed > 0) {
      console.log(`[project-gc] Sweep complete: reclaimed ${reclaimed} orphaned project(s)`);
    }
  } catch (err) {
    console.error('[project-gc] Sweep failed:', (err as Error).message);
  }
}
