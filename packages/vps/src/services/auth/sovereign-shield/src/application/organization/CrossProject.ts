// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Cross-Project Read Access Service
 *
 * Manages read-only access rules between sandboxes. When sandbox A is
 * granted read access to sandbox B, the agent-namespace script bind-mounts
 * a filtered source-code snapshot of B at `.shared/{B}` inside A's
 * namespace (see `packages/vps/src/scripts/helpers/agent-namespace`).
 *
 * Rules are stored in the shield-owned DB (agent cannot modify) and synced
 * to a JSON config file that the namespace script reads at spawn time.
 *
 * ── Scope ────────────────────────────────────────────────────────────────
 *
 * Cross-project grants are **sandbox-scoped**. The mount boundary is
 * physically per-sandbox — rsync exposes the whole sandbox directory,
 * with a strict allow-list for files. App-level grants would be a lie:
 * if app-A in sandbox X had "read access" to app-B in sandbox X but not
 * app-C in sandbox X, nothing on the OS enforces that. The sandbox IS
 * the security boundary.
 *
 * The branded `SandboxId` type from `@ellul.ai/types` lifts that design
 * decision into the type system — this module cannot be called with an
 * app directory or an unvalidated string.
 *
 * ── Authorization ────────────────────────────────────────────────────────
 *
 * Browser session + PoP (web_locked / private_locked tiers) required for
 * all writes. The agent cannot request or modify cross-project access.
 */

import fs from 'fs';
import { execFileSync } from 'child_process';
import { parseSandboxId, type SandboxId } from '@ellul.ai/types';
import { RSYNC_ALLOWLIST_ARGS } from '@vps/services/shared/rsync-allowlist';
import { db } from '../../database';
import { SHIELD_DATA_DIR } from '../../config';
import { ensureSandbox } from '../process/SandboxRegistry';
import { matchScopeConfusionInReason } from '@vps/shared/cross-project-scope';

const CONFIG_FILE = `${SHIELD_DATA_DIR}/cross-project-access.json`;
const CONFIG_TMP = `${SHIELD_DATA_DIR}/cross-project-access.json.tmp`;

// ── Prepared statements (lazy init) ──────────────────────────────────────────

let insertStmt: ReturnType<typeof db.prepare> | null = null;
let deleteStmt: ReturnType<typeof db.prepare> | null = null;
let listForSandboxStmt: ReturnType<typeof db.prepare> | null = null;
let listAllStmt: ReturnType<typeof db.prepare> | null = null;
let cleanupStmt: ReturnType<typeof db.prepare> | null = null;

function initStatements(): void {
  if (insertStmt) return;
  insertStmt = db.prepare(`
    INSERT INTO cross_project_access
      (sandbox_id, shared_sandbox_id, granted_at, share_preview)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(sandbox_id, shared_sandbox_id) DO UPDATE SET
      granted_at    = excluded.granted_at,
      share_preview = excluded.share_preview
  `);
  deleteStmt = db.prepare(`
    DELETE FROM cross_project_access
    WHERE sandbox_id = ? AND shared_sandbox_id = ?
  `);
  listForSandboxStmt = db.prepare(`
    SELECT shared_sandbox_id, granted_at, share_preview
    FROM cross_project_access
    WHERE sandbox_id = ?
  `);
  listAllStmt = db.prepare(`
    SELECT sandbox_id, shared_sandbox_id, granted_at, share_preview
    FROM cross_project_access
  `);
  cleanupStmt = db.prepare(`
    DELETE FROM cross_project_access
    WHERE sandbox_id = ? OR shared_sandbox_id = ?
  `);
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface CrossProjectRule {
  sandboxId: SandboxId;
  sharedSandboxId: SandboxId;
  grantedAt: number;
  sharePreview: boolean;
}

/**
 * Grant sandbox `reader` read-only access to sandbox `source`'s files.
 *
 * @param reader        The sandbox that will gain read access.
 * @param source        The sandbox whose files will be exposed.
 * @param sharePreview  Also expose a scoped DNAT path to the source's
 *                      preview port (agent can hit the source sandbox's
 *                      running dev server over the internal network).
 *
 * Throws if `reader === source` — a sandbox cannot share with itself.
 */
export function grantCrossProjectAccess(
  reader: SandboxId,
  source: SandboxId,
  sharePreview = false,
): void {
  if (reader === source) {
    throw new Error('A sandbox cannot share with itself');
  }
  initStatements();

  // Ensure both parent rows exist before inserting the child — FK would
  // otherwise reject. `ensureSandbox` is idempotent.
  ensureSandbox(reader);
  ensureSandbox(source);

  insertStmt!.run(reader, source, Date.now(), sharePreview ? 1 : 0);
  syncConfigFile();

  // Populate the snapshot immediately if the reader's namespace is live.
  // Best-effort — DB + config are the durable state; the snapshot will be
  // created on next namespace setup if this fails.
  try { populateSharedSnapshot(reader, source); } catch { /* logged below */ }
  try { refreshReaderContext(reader); } catch { /* context refreshes on next session */ }
}

/**
 * Revoke a cross-project grant. Atomic: purges the `.shared/<source>`
 * snapshot from the running namespace BEFORE committing the DB delete.
 * If the snapshot cannot be removed from a live namespace, the entire
 * operation fails and the grant remains in place.
 */
export function revokeCrossProjectAccess(
  reader: SandboxId,
  source: SandboxId,
): boolean {
  initStatements();

  // Phase 1: purge snapshot from the live namespace (must succeed first).
  purgeSharedSnapshot(reader, source);

  // Phase 2: commit the DB delete + sync the on-disk config.
  const result = deleteStmt!.run(reader, source);
  if (result.changes > 0) {
    syncConfigFile();
    refreshReaderContext(reader);
  }
  return result.changes > 0;
}

/**
 * Temporarily widen `.shared/` permissions so shield-runner can create
 * or remove snapshot subdirectories, then restore the read-only state.
 *
 * `.shared/` is 0555 root:root (ns-mount.c) — prevents agent symlink-to-
 * secret attacks. Shield-runner has CAP_CHOWN + CAP_FOWNER as ambient
 * capabilities, allowing it to take temporary ownership of root-owned
 * directories and modify their mode bits.
 *
 * During the window, `.shared/` is 0701 shield-runner:shield-runner —
 * the agent (uid 1000, "other") retains traverse-only access to existing
 * snapshots but cannot write, list, or plant symlinks. Access is strictly
 * MORE restrictive than the normal 0555 state during this window.
 */
function withSharedDirWritable<T>(sharedDir: string, fn: () => T): T {
  const uid = process.getuid!();
  const gid = process.getgid!();
  fs.chownSync(sharedDir, uid, gid);
  fs.chmodSync(sharedDir, 0o701);
  try {
    return fn();
  } finally {
    fs.chmodSync(sharedDir, 0o555);
    fs.chownSync(sharedDir, 0, 0);
  }
}

function syncSnapshotInto(
  sharedDir: string,
  destDir: string,
  sourceDir: string,
): void {
  if (!fs.existsSync(sharedDir)) return;
  withSharedDirWritable(sharedDir, () => {
    fs.mkdirSync(destDir, { recursive: true });
    try {
      execFileSync('rsync', [
        '-aq', '--no-links', '--no-H', '--no-D', '--max-size=50m',
        ...RSYNC_ALLOWLIST_ARGS,
        `${sourceDir}/`,
        `${destDir}/`,
      ], { timeout: 30000, stdio: 'ignore' });
    } catch { /* source may be empty or rsync may fail on edge cases */ }
    try {
      execFileSync('chown', ['-R', 'root:root', destDir], { timeout: 10000, stdio: 'ignore' });
      execFileSync('chmod', ['-R', 'a+rX,a-w', destDir], { timeout: 10000, stdio: 'ignore' });
    } catch { /* best-effort permissions */ }
  });
}

/**
 * Rsync the source sandbox's source code into the reader's live
 * namespace at `.shared/<source>/`. Mirrors the setup.sh cross-project
 * rsync block so that granting access to an already-running namespace
 * takes effect immediately (no restart required).
 *
 * If the namespace is not running, returns silently — the snapshot
 * will be created on next namespace setup.
 */
function populateSharedSnapshot(reader: SandboxId, source: SandboxId): void {
  const home = process.env.SVC_HOME ?? '/home/dev';
  const pidFile = `/run/.ns-${reader}/anchor.pid`;

  let pid: string | null = null;
  try {
    pid = fs.readFileSync(pidFile, 'utf8').trim();
    if (!pid || !/^\d+$/.test(pid)) pid = null;
  } catch {
    return;
  }
  if (!pid) return;

  // Check anchor liveness via /proc — kill(pid,0) fails with EPERM when
  // shield-runner (uid 994) signals a root-owned anchor process.
  if (!fs.existsSync(`/proc/${pid}`)) return;

  const sourcePath = `${home}/projects/${source}`;
  if (!fs.existsSync(sourcePath)) return;

  const nsSharedDir = `/proc/${pid}/root${home}/projects/${reader}/.shared`;
  syncSnapshotInto(nsSharedDir, `${nsSharedDir}/${source}`, sourcePath);

  const hostSharedDir = `${home}/projects/${reader}/.shared`;
  if (hostSharedDir !== nsSharedDir) {
    syncSnapshotInto(hostSharedDir, `${hostSharedDir}/${source}`, sourcePath);
  }
}

/**
 * Remove `.shared/<source>` from a running namespace. Throws if the
 * namespace is live and the directory cannot be removed — the caller
 * must not proceed with the DB delete in that case.
 *
 * If the namespace is not running (no anchor PID), there is nothing
 * to purge and the function returns silently — the grant will simply
 * not be restored on next setup because the DB row will be gone.
 */
function purgeSharedSnapshot(reader: SandboxId, source: SandboxId): void {
  const home = process.env.SVC_HOME ?? '/home/dev';
  const pidFile = `/run/.ns-${reader}/anchor.pid`;

  let pid: string | null = null;
  try {
    pid = fs.readFileSync(pidFile, 'utf8').trim();
    if (!pid || !/^\d+$/.test(pid)) pid = null;
  } catch {
    return;
  }
  if (!pid) return;

  if (!fs.existsSync(`/proc/${pid}`)) return;

  const nsSharedDir = `/proc/${pid}/root${home}/projects/${reader}/.shared`;
  const nsTarget = `${nsSharedDir}/${source}`;
  if (fs.existsSync(nsSharedDir)) {
    withSharedDirWritable(nsSharedDir, () => {
      fs.rmSync(nsTarget, { recursive: true, force: true });
    });
  }

  const hostSharedDir = `${home}/projects/${reader}/.shared`;
  const hostTarget = `${hostSharedDir}/${source}`;
  if (fs.existsSync(hostSharedDir)) {
    try {
      withSharedDirWritable(hostSharedDir, () => {
        fs.rmSync(hostTarget, { recursive: true, force: true });
      });
    } catch { /* host shadow is best-effort */ }
  }
}

/**
 * Re-run the context script so CLAUDE.md/AGENTS.md no longer mention
 * the revoked sandbox. Targets both the sandbox root and active app.
 */
function refreshReaderContext(reader: SandboxId): void {
  const home = process.env.SVC_HOME ?? '/home/dev';
  const sandboxDir = `${home}/projects/${reader}`;
  try {
    execFileSync('/usr/local/bin/ellul-ctx', [sandboxDir, 'base'], {
      timeout: 10000,
      stdio: 'ignore',
    });
  } catch { /* best-effort — context will refresh on next session */ }
  try {
    const entries = fs.readdirSync(sandboxDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const appDir = `${sandboxDir}/${e.name}`;
      execFileSync('/usr/local/bin/ellul-ctx', [appDir, 'base'], {
        timeout: 10000,
        stdio: 'ignore',
      });
    }
  } catch { /* best-effort */ }
}

/**
 * List which sandboxes a given sandbox has read access to.
 */
export function listCrossProjectAccess(reader: SandboxId): Array<{
  sharedSandboxId: SandboxId;
  grantedAt: number;
  sharePreview: boolean;
}> {
  initStatements();
  const rows = listForSandboxStmt!.all(reader) as Array<{
    shared_sandbox_id: string;
    granted_at: number;
    share_preview: number;
  }>;
  return rows.map((r) => ({
    sharedSandboxId: r.shared_sandbox_id as SandboxId,
    grantedAt: r.granted_at,
    sharePreview: r.share_preview === 1,
  }));
}

/**
 * Detect scope confusion in an agent-supplied gate-request reason.
 *
 * Agents operating inside a sandbox that has `.shared/<other>/` snapshots
 * mounted sometimes read that other sandbox's code and then — misreading
 * scope — proactively request gates (via `ellul_gate_request`) to "access"
 * data from that other sandbox. Those gates apply to THIS sandbox, not the
 * source, so granting would be meaningless and the popup is pure noise to
 * the user.
 *
 * This check is the authoritative structural enforcement: if the agent's
 * stated `reason` references a sandbox we've granted `reader` cross-project
 * read access to — either as a `.shared/<slug>/` path or as a bare slug
 * token — we reject the gate request before it ever reaches the operator
 * notification path.
 *
 * Matches:
 *   - Literal `.shared/<slug>` path references (any trailing chars)
 *   - Bare `sbx-xxxxx` slug tokens that equal one of the shared sandboxes
 *
 * Returns the matched shared-sandbox id + the offending substring, or null
 * if the reason is clean. Deterministic; no false positives — only flags
 * reasons that name an actually-shared sandbox.
 */
export function detectCrossProjectScopeConfusion(
  reader: SandboxId,
  reason: string,
): { sharedSandbox: SandboxId; matchedToken: string } | null {
  if (!reason) return null;
  const sharedSlugs = listCrossProjectAccess(reader).map((r) => r.sharedSandboxId);
  return matchScopeConfusionInReason(sharedSlugs, reason);
}

/**
 * All cross-project access rules (admin view).
 */
export function listAllCrossProjectAccess(): CrossProjectRule[] {
  initStatements();
  const rows = listAllStmt!.all() as Array<{
    sandbox_id: string;
    shared_sandbox_id: string;
    granted_at: number;
    share_preview: number;
  }>;
  return rows.map((r) => ({
    sandboxId: r.sandbox_id as SandboxId,
    sharedSandboxId: r.shared_sandbox_id as SandboxId,
    grantedAt: r.granted_at,
    sharePreview: r.share_preview === 1,
  }));
}

/**
 * Remove ALL rules involving a sandbox (as reader or source). Called
 * during sandbox deletion as a defense-in-depth companion to the FK
 * CASCADE — the CASCADE handles the DB side, this function also
 * triggers a sync of the on-disk JSON config consumed by the
 * agent-namespace spawn script.
 *
 * Accepts a raw string because callers may be tearing down a sandbox
 * whose id was read from disk; parses before use.
 */
export function cleanupSandboxCrossProjectAccess(rawSandboxId: string): number {
  const sandboxId = parseSandboxId(rawSandboxId);
  initStatements();
  const result = cleanupStmt!.run(sandboxId, sandboxId);
  if (result.changes > 0) syncConfigFile();
  return result.changes;
}

/**
 * Materialize DB grants to the on-disk JSON config. Call on startup so
 * the config file exists (with correct setgid-inherited group) even if
 * no grant/revoke has happened since boot.
 */
export function syncCrossProjectConfigOnStartup(): void {
  syncConfigFile();
}

/**
 * Reconcile all shared snapshots for a reader sandbox. Reads the DB for
 * all grants where this sandbox is the reader, and ensures each source
 * has a populated `.shared/<source>/` snapshot.
 *
 * Called by the bridge after namespace setup completes — the NSD daemon
 * creates the empty `.shared/` directory but does not populate it.
 * Also called on shield startup to heal any snapshots that failed
 * during a previous grant.
 *
 * Idempotent: rsync with `--delete` is not used, so stale files from a
 * previously removed source file do not get cleaned up — but the next
 * sync will overwrite changed files. A revoke purges the directory
 * entirely via `purgeSharedSnapshot`.
 */
export function reconcileSharedSnapshots(reader: SandboxId): number {
  const grants = listCrossProjectAccess(reader);
  let populated = 0;
  for (const grant of grants) {
    try {
      populateSharedSnapshot(reader, grant.sharedSandboxId);
      populated++;
    } catch { /* best-effort per source */ }
  }
  return populated;
}

// ── JSON sync for agent-namespace consumer ───────────────────────────────────

/**
 * Sync DB state to the JSON config read by the agent-namespace script.
 *
 * Format: `{ "sbx-aaaaaaa": [{"sandbox":"sbx-bbbbbbb","preview":true}, ...] }`
 *
 * The namespace script reads this at spawn time to determine:
 *   - Which sandboxes to rsync-snapshot into `.shared/<sandbox>`
 *   - Which shared sandboxes get DNAT preview access (`preview: true`)
 *
 * Written atomically: tmp file → fsync → rename. The tmp file is created
 * with 0640 permissions so a race between unlink and chmod cannot widen
 * access.
 */
function syncConfigFile(): void {
  initStatements();
  const rules = listAllStmt!.all() as Array<{
    sandbox_id: string;
    shared_sandbox_id: string;
    share_preview: number;
  }>;

  const config: Record<string, Array<{ sandbox: string; preview: boolean }>> = {};
  for (const rule of rules) {
    if (!config[rule.sandbox_id]) config[rule.sandbox_id] = [];
    config[rule.sandbox_id]!.push({
      sandbox: rule.shared_sandbox_id,
      preview: rule.share_preview === 1,
    });
  }

  const data = JSON.stringify(config, null, 2) + '\n';
  const fd = fs.openSync(CONFIG_TMP, 'w', 0o640);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(CONFIG_TMP, CONFIG_FILE);
}
