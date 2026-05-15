// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Project listing, registration, deletion, rename.
// Identity: slug = immutable dir name; displayName = mutable label in ellul.json; id = sha256(slug).
// All infra keys use slug; renaming is metadata-only.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync, execFileSync } from 'child_process';
import type { Hono } from 'hono';
import { SANDBOX_ID_RE } from '@ellul.ai/types';
import { SVC_HOME } from '../config';
import { getClientIp } from '../auth/fingerprint';
import { checkApiRateLimit } from '../application/platform/RateLimiter';
import { logAuditEvent } from '../application/audit/Audit';
import { destroyNamespace, isShielded } from '../application/process/Netns';
import { checkSandboxEntitlement, getEntitlementStatus } from '../application/platform/Entitlement';

const PROJECTS_DIR = path.join(SVC_HOME, 'projects');
const SECRETS_DIR = '/etc/ellul/secrets';
const SHIELDED_PROJECTS_DIR = '/var/lib/ellul-shielded/projects';

const SLUG_REGEX = SANDBOX_ID_RE;
const DISPLAY_NAME_MAX_LENGTH = 64;

// UID/GID resolution is in the shield-project-lock wrapper (runs as root via sudo).

// ── Slug generation ────────────────────────────────────────────────────────

// 36^7 ≈ 78B combinations.
const NANOID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const NANOID_LENGTH = 7;

function generateSlug(): string {
  // Rejection sampling: 252 = 36 * 7, reject 252-255 to eliminate modulo bias.
  const bytes = crypto.randomBytes(NANOID_LENGTH * 2);
  let id = '';
  let byteIdx = 0;
  while (id.length < NANOID_LENGTH) {
    if (byteIdx >= bytes.length) {
      const more = crypto.randomBytes(NANOID_LENGTH);
      for (let i = 0; i < more.length && id.length < NANOID_LENGTH; i++) {
        if (more[i]! < 252) {
          id += NANOID_ALPHABET[more[i]! % NANOID_ALPHABET.length];
        }
      }
      continue;
    }
    const byte = bytes[byteIdx++]!;
    if (byte < 252) {
      id += NANOID_ALPHABET[byte % NANOID_ALPHABET.length];
    }
  }
  return `sbx-${id}`;
}

function allocateSlug(): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const slug = generateSlug();
    if (!fs.existsSync(path.join(PROJECTS_DIR, slug))) {
      return slug;
    }
  }
  throw new Error('Failed to allocate unique project slug after 10 attempts');
}

// ── Namespace subnet ──────────────────────────────────────────────────────

// MD5-derived /30 in 10.200.x.y. Must match namespace-spawn.service.ts.
function computeNamespaceSubnet(slug: string): { hostIp: string; nsIp: string; subnet: string } {
  const hash = crypto.createHash('md5').update(slug).digest();
  const third = hash[0]!;
  const fourth = (hash[1]! & 0x3f) * 4;
  return {
    hostIp: `10.200.${third}.${fourth + 1}`,
    nsIp: `10.200.${third}.${fourth + 2}`,
    subnet: `10.200.${third}.${fourth}/30`,
  };
}

// ── Shielded workspace ────────────────────────────────────────────────────

function provisionShieldedWorkspace(slug: string): { workspace: string; cache: string; subnet: ReturnType<typeof computeNamespaceSubnet> } {
  const projectShieldDir = path.join(SHIELDED_PROJECTS_DIR, slug);
  const workspaceDir = path.join(projectShieldDir, 'workspace');
  const cacheDir = path.join(projectShieldDir, '.cache');

  fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });

  try {
    fs.chmodSync(projectShieldDir, 0o700);
  } catch { /* not owner — acceptable */ }

  const subnet = computeNamespaceSubnet(slug);
  return { workspace: workspaceDir, cache: cacheDir, subnet };
}

// ── Display name helpers ──────────────────────────────────────────────────

function readDisplayName(slug: string): string {
  try {
    const configPath = path.join(PROJECTS_DIR, slug, 'ellul.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (typeof config.displayName === 'string' && config.displayName.trim()) {
      return config.displayName.trim();
    }
  } catch { /* missing or invalid */ }
  return slug;
}

function writeDisplayName(slug: string, displayName: string): void {
  const configPath = path.join(PROJECTS_DIR, slug, 'ellul.json');
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch { /* start fresh */ }
  config.displayName = displayName;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

// ── Orphan reaper ─────────────────────────────────────────────────────────
// A sandbox dir without ellul.json older than the grace window is a
// partial-create/delete (sbx-uc0lc01 / sbx-6e6mo98 on b91cf877 2026-04-21).
// Each candidate re-checked under a per-slug lock to avoid racing in-flight creates.

const ORPHAN_GRACE_MS = 5 * 60 * 1000;
const REAP_INTERVAL_MS = 60 * 1000;
let reapTimer: ReturnType<typeof setInterval> | null = null;

function isOrphan(slug: string): { orphan: boolean; reason?: string } {
  const dir = path.join(PROJECTS_DIR, slug);
  let stat: fs.Stats;
  try { stat = fs.statSync(dir); } catch { return { orphan: false }; }
  if (!stat.isDirectory()) return { orphan: false };
  if (stat.uid !== 0) return { orphan: false }; // not a shield-managed dir
  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs < ORPHAN_GRACE_MS) return { orphan: false, reason: 'within grace window' };
  if (fs.existsSync(path.join(dir, 'ellul.json'))) return { orphan: false };
  return { orphan: true, reason: `no ellul.json after ${Math.round(ageMs / 1000)}s` };
}

function reapOrphans(): void {
  let entries: string[];
  try { entries = fs.readdirSync(PROJECTS_DIR); } catch { return; }

  for (const entry of entries) {
    if (!SLUG_REGEX.test(entry)) continue;
    const probe1 = isOrphan(entry);
    if (!probe1.orphan) continue;

    // Defer one cycle if create lock is fresh (< 30s) — don't race a legitimate create.
    try {
      const lockStat = fs.statSync('/run/ellul-project-create.lock');
      if (Date.now() - lockStat.mtimeMs < 30_000) {
        console.log(`[orphan-reaper] deferring reap for ${entry} — create lock active`);
        continue;
      }
    } catch { /* no lock */ }

    // Re-probe so we don't act on a stale snapshot.
    const probe2 = isOrphan(entry);
    if (!probe2.orphan) continue;

    console.log(`[orphan-reaper] reaping ${entry} — ${probe2.reason}`);
    logAuditEvent({
      type: 'orphan_reaped',
      ip: 'system',
      details: { slug: entry, reason: probe2.reason },
    });
    try {
      execFileSync('sudo', ['/usr/local/bin/shield-project-lock', 'rm', entry], {
        stdio: 'pipe',
        timeout: 10_000,
      });
    } catch (err) {
      console.error(`[orphan-reaper] rm failed for ${entry}:`, (err as Error).message);
      logAuditEvent({
        type: 'orphan_reap_failed',
        ip: 'system',
        details: { slug: entry, error: (err as Error).message },
      });
      continue;
    }
    // Best-effort companion cleanup — bookkeeping artefacts, next create overwrites.
    for (const pattern of [entry, `${entry}.env`, `${entry}.dev.env`]) {
      try { fs.rmSync(path.join(SECRETS_DIR, pattern), { recursive: true, force: true }); } catch {}
    }
    try { fs.rmSync(path.join(SHIELDED_PROJECTS_DIR, entry), { recursive: true, force: true }); } catch {}
    try { fs.rmSync(path.join(SHIELDED_PROJECTS_DIR, `${entry}.epoch`), { force: true }); } catch {}
  }
}

// Idempotent — only first call installs the interval.
export function startOrphanReaper(): void {
  if (reapTimer) return;
  // Fire once so restart doesn't sit on existing orphans for a full cycle.
  try { reapOrphans(); } catch (err) {
    console.error('[orphan-reaper] initial sweep failed:', (err as Error).message);
  }
  reapTimer = setInterval(() => {
    try { reapOrphans(); } catch (err) {
      console.error('[orphan-reaper] sweep failed:', (err as Error).message);
    }
  }, REAP_INTERVAL_MS);
  if (typeof reapTimer.unref === 'function') reapTimer.unref();
  console.log(`[orphan-reaper] started — sweeping every ${REAP_INTERVAL_MS / 1000}s, grace ${ORPHAN_GRACE_MS / 1000}s`);
}

// ── Routes ────────────────────────────────────────────────────────────────

export function registerProjectsRoutes(app: Hono): void {
  app.get('/_auth/projects', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const projects = discoverProjects();
    const entitlement = await getEntitlementStatus();
    return c.json({ projects, entitlement });
  });

  app.post('/_auth/projects', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    // Entitlement check + mkdir happen in one synchronous block (no TOCTOU).
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const displayName = typeof body.displayName === 'string'
      ? body.displayName.trim().slice(0, DISPLAY_NAME_MAX_LENGTH)
      : null;

    // Dedup: blocks double-submits from React strict mode / bridge reconnects / retries.
    if (displayName) {
      const existing = discoverProjects();
      if (existing.some(p => p.displayName === displayName)) {
        return c.json({
          error: 'duplicate_name',
          message: `A project named "${displayName}" already exists.`,
        }, 409);
      }
    }

    const entitlementCheck = await checkSandboxEntitlement();
    if (!entitlementCheck.allowed) {
      logAuditEvent({
        type: 'project_create_denied',
        ip,
        details: {
          reason: entitlementCheck.reason,
          current: entitlementCheck.status.current,
          max: entitlementCheck.status.max,
        },
      });
      if (entitlementCheck.reason === 'insufficient_resources') {
        return c.json({
          error: 'insufficient_resources',
          message: 'Not enough system resources to create a new workspace. Free up RAM or disk space and try again.',
        }, 503);
      }
      return c.json({
        error: 'sandbox_limit_reached',
        message: `Sandbox limit reached (${entitlementCheck.status.current}/${entitlementCheck.status.max}). Purchase additional sandboxes at $5/each.`,
        current: entitlementCheck.status.current,
        max: entitlementCheck.status.max,
        remaining: 0,
      }, 402);
    }

    // Lockfile blocks concurrent entitlement+dedup TOCTOU; held for ~100ms during create.
    const lockFile = '/run/ellul-project-create.lock';
    if (fs.existsSync(lockFile)) {
      const lockAge = Date.now() - (fs.statSync(lockFile).mtimeMs || 0);
      if (lockAge < 10000) {
        return c.json({ error: 'Project creation already in progress' }, 429);
      }
      try { fs.unlinkSync(lockFile); } catch {}
    }
    try { fs.writeFileSync(lockFile, String(Date.now())); } catch {}

    // Re-check dedup under lock (first check ran before the entitlement await).
    if (displayName) {
      const postLockProjects = discoverProjects();
      if (postLockProjects.some(p => p.displayName === displayName)) {
        try { fs.unlinkSync(lockFile); } catch {}
        return c.json({
          error: 'duplicate_name',
          message: `A project named "${displayName}" already exists.`,
        }, 409);
      }
    }

    const slug = allocateSlug();
    const id = crypto.createHash('sha256').update(slug).digest('hex').slice(0, 16);

    // Atomic mkdir+chown+chmod+ellul.json under one root call. Shield runs as
    // shield-runner (not in dev group), so metadata write MUST happen in the
    // same root context as the mkdir. No fallback — fail clean if wrapper is old.
    const fallbackName = (displayName || slug).slice(0, 200);
    try {
      execFileSync('sudo', [
        '/usr/local/bin/shield-project-lock',
        'create-with-meta',
        slug,
        fallbackName,
      ], { stdio: 'pipe', timeout: 10_000 });
    } catch (createErr) {
      const stderr = (createErr as { stderr?: Buffer }).stderr?.toString() ?? '';
      console.error(`[projects] CRITICAL: create-with-meta failed for ${slug}:`, (createErr as Error).message, stderr);
      try { execFileSync('sudo', ['/usr/local/bin/shield-project-lock', 'rm', slug], { stdio: 'pipe', timeout: 5000 }); } catch {}
      if (/unknown action|usage:/i.test(stderr)) {
        return c.json({
          error: 'host_wrapper_outdated',
          message: 'Host shield-project-lock is on the pre-Apr-21 version. The next provisioning cycle will upgrade the wrapper; retry after ~15 minutes.',
        }, 503);
      }
      return c.json({ error: 'Failed to provision project directory' }, 500);
    }

    let shielded: ReturnType<typeof provisionShieldedWorkspace> | null = null;
    try {
      shielded = provisionShieldedWorkspace(slug);
    } catch (err) {
      console.warn(`[projects] Shielded workspace provisioning failed for "${slug}":`, (err as Error).message);
    }

    logAuditEvent({
      type: 'project_registered',
      ip,
      details: {
        slug,
        displayName: displayName || slug,
        id,
        shielded: !!shielded,
        subnet: shielded?.subnet.subnet,
      },
    });

    try { fs.unlinkSync(lockFile); } catch {}

    const postCreateEntitlement = await getEntitlementStatus();

    return c.json({
      id,
      slug,
      displayName: displayName || slug,
      shielded: shielded ? {
        workspace: shielded.workspace,
        cache: shielded.cache,
        subnet: shielded.subnet,
      } : null,
      entitlement: postCreateEntitlement,
    });
  });

  app.patch('/_auth/projects/:slug/name', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const slug = c.req.param('slug');
    if (!SLUG_REGEX.test(slug)) {
      return c.json({ error: 'Invalid project slug' }, 400);
    }

    const projectDir = path.join(PROJECTS_DIR, slug);
    if (!fs.existsSync(projectDir)) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.displayName !== 'string' || !body.displayName.trim()) {
      return c.json({ error: 'Missing displayName' }, 400);
    }

    const displayName = body.displayName.trim().slice(0, DISPLAY_NAME_MAX_LENGTH);
    writeDisplayName(slug, displayName);

    logAuditEvent({ type: 'project_renamed', ip, details: { slug, displayName } });
    return c.json({ slug, displayName });
  });

  app.get('/_auth/projects/lookup', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const name = c.req.query('name');
    if (!name) {
      return c.json({ error: 'Missing name query parameter' }, 400);
    }

    const projects = discoverProjects();
    const match = projects.find(
      (p) => p.displayName.toLowerCase() === name.toLowerCase() || p.slug === name,
    );

    if (!match) {
      return c.json({ error: 'Project not found' }, 404);
    }

    return c.json({ id: match.id, slug: match.slug, displayName: match.displayName });
  });

  // Strict all-or-nothing teardown. Every step must succeed AND dir verifiably gone.
  // Prior silent-success masking caused orphan slot sbx-6e6mo98 on b91cf877 (2026-04-21).
  app.delete('/_auth/projects/:slug', async (c) => {
    const ip = getClientIp(c);
    const rateLimit = checkApiRateLimit(ip);
    if (rateLimit.blocked) {
      return c.json({ error: 'Rate limit exceeded' }, 429);
    }

    const slug = c.req.param('slug');
    if (!SLUG_REGEX.test(slug)) {
      return c.json({ error: 'Invalid project slug' }, 400);
    }

    const projectPath = path.join(PROJECTS_DIR, slug);

    const fail = (step: string, err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logAuditEvent({
        type: 'project_delete_failed',
        ip,
        details: { slug, step, error: message },
      });
      return c.json({ deleted: false, slug, failedStep: step, error: message }, 500);
    };

    // 1. Namespace.
    if (isShielded(slug)) {
      try { destroyNamespace(slug); }
      catch (err) { return fail('namespace', err); }
    }

    // 2. DB roles. MUST go through shield-pg-wrapper — sudoers only allow sudo as
    // postgres through the wrapper; raw psql blocks on hidden password prompt.
    try {
      const roles = [`shield_${slug}_owner`, `shield_${slug}_app`, `shield_${slug}_readonly`];
      for (const role of roles) {
        execFileSync('sudo', ['-u', 'postgres', '/usr/local/bin/shield-pg-wrapper', '/usr/bin/psql', '-c', `DROP OWNED BY "${role}" CASCADE;`], { stdio: 'pipe' });
        execFileSync('sudo', ['-u', 'postgres', '/usr/local/bin/shield-pg-wrapper', '/usr/bin/psql', '-c', `DROP ROLE IF EXISTS "${role}";`], { stdio: 'pipe' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/role .* does not exist/i.test(msg)) return fail('database', err);
    }

    // 3. Secrets.
    try {
      for (const pattern of [slug, `${slug}.env`, `${slug}.dev.env`]) {
        fs.rmSync(path.join(SECRETS_DIR, pattern), { recursive: true, force: true });
      }
    } catch (err) { return fail('secrets', err); }

    // 4. Shielded workspace.
    try {
      fs.rmSync(path.join(SHIELDED_PROJECTS_DIR, slug), { recursive: true, force: true });
    } catch (err) { return fail('shielded-workspace', err); }

    // 5. Project dir (entitlement counter's source of truth).
    try {
      execFileSync('sudo', ['/usr/local/bin/shield-project-lock', 'rm', slug], {
        stdio: 'pipe',
        timeout: 10_000,
      });
    } catch (err) { return fail('project-directory', err); }

    // Wrapper can exit 0 while leaving the dir (stale bind mount, immutable bit, race).
    let dirGone = false;
    try { fs.statSync(projectPath); }
    catch { dirGone = true; }
    if (!dirGone) {
      return fail('project-directory-verify',
        new Error(`shield-project-lock exited 0 but ${projectPath} still exists`));
    }

    // 6. Epoch marker.
    try {
      fs.rmSync(path.join(SHIELDED_PROJECTS_DIR, `${slug}.epoch`), { force: true });
    } catch (err) { return fail('epoch', err); }

    logAuditEvent({ type: 'project_deleted', ip, details: { slug } });
    return c.json({ deleted: true, slug });
  });

  // ── Internal endpoints (file-api → shield, gated by requireInternalTokenMiddleware) ──

  // root:$SVC_GID 0775 + sticky parent — agent cannot delete/rename.
  app.post('/api/internal/projects/lock', async (c) => {
    const body = await c.req.json().catch(() => null);
    const slug = body?.slug;
    if (!slug || !SLUG_REGEX.test(slug)) {
      return c.json({ error: 'Invalid slug' }, 400);
    }

    const projectDir = path.join(PROJECTS_DIR, slug);
    if (!fs.existsSync(projectDir)) {
      return c.json({ error: 'Directory not found' }, 404);
    }

    try {
      execFileSync('sudo', ['/usr/local/bin/shield-project-lock', 'lock', slug], {
        stdio: 'pipe',
        timeout: 5000,
      });
    } catch (err) {
      console.error(`[projects] Failed to lock dir:`, (err as Error).message);
      return c.json({ error: 'Failed to lock directory' }, 500);
    }

    logAuditEvent({ type: 'project_locked', ip: getClientIp(c), details: { slug } });
    return c.json({ success: true, slug });
  });

  app.post('/api/internal/projects/entitlement-check', async (c) => {
    const result = await checkSandboxEntitlement();
    const status = await getEntitlementStatus();
    return c.json({
      allowed: result.allowed,
      reason: result.allowed ? undefined : result.reason,
      current: status.current,
      max: status.max,
      remaining: status.remaining,
    });
  });

  // Privileged service call from file-api. This endpoint ONLY mkdirs — the caller
  // (file-api, in dev group) writes ellul.json in the next ~10ms. Orphan reaper
  // catches any dir without metadata after the 5-min grace.
  app.post('/api/internal/projects/create', async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const displayName = typeof body.displayName === 'string'
      ? body.displayName.trim().slice(0, DISPLAY_NAME_MAX_LENGTH)
      : null;

    const entitlementCheck = await checkSandboxEntitlement();
    if (!entitlementCheck.allowed) {
      logAuditEvent({
        type: 'project_create_denied',
        ip: getClientIp(c),
        details: {
          reason: entitlementCheck.reason,
          current: entitlementCheck.status.current,
          max: entitlementCheck.status.max,
          source: 'internal',
        },
      });
      if (entitlementCheck.reason === 'insufficient_resources') {
        return c.json({
          error: 'insufficient_resources',
          message: 'Not enough system resources to create a new workspace. Free up RAM or disk space and try again.',
        }, 503);
      }
      return c.json({
        error: 'sandbox_limit_reached',
        message: `Sandbox limit reached (${entitlementCheck.status.current}/${entitlementCheck.status.max}). Purchase additional sandboxes at $5/each.`,
        current: entitlementCheck.status.current,
        max: entitlementCheck.status.max,
        remaining: 0,
      }, 402);
    }

    const slug = allocateSlug();
    const id = crypto.createHash('sha256').update(slug).digest('hex').slice(0, 16);
    const projectDir = path.join(PROJECTS_DIR, slug);

    // Wrapper self-destructs on uid != 0; Node-side stat below is defense-in-depth.
    try {
      execFileSync('sudo', ['/usr/local/bin/shield-project-lock', 'create', slug], {
        stdio: 'pipe',
        timeout: 5000,
      });
    } catch (createErr) {
      console.error(`[projects] CRITICAL: Internal create failed for ${slug}:`, (createErr as Error).message);
      try { execFileSync('sudo', ['/usr/local/bin/shield-project-lock', 'rm', slug], { stdio: 'pipe', timeout: 5000 }); } catch {}
      return c.json({ error: 'Failed to provision project directory' }, 500);
    }

    try {
      const dirStat = fs.statSync(projectDir);
      if (dirStat.uid !== 0) {
        console.error(`[projects] CRITICAL: Post-create verification failed: uid=${dirStat.uid}, expected 0`);
        try { execFileSync('sudo', ['/usr/local/bin/shield-project-lock', 'rm', slug], { stdio: 'pipe', timeout: 5000 }); } catch {}
        return c.json({ error: 'Failed to provision project directory' }, 500);
      }
    } catch (statErr) {
      console.error(`[projects] CRITICAL: Cannot stat after create:`, (statErr as Error).message);
      try { execFileSync('sudo', ['/usr/local/bin/shield-project-lock', 'rm', slug], { stdio: 'pipe', timeout: 5000 }); } catch {}
      return c.json({ error: 'Failed to provision project directory' }, 500);
    }

    // Optional — failure logs but does NOT roll back; caller retries on next shielded op.
    let shielded: ReturnType<typeof provisionShieldedWorkspace> | null = null;
    try {
      shielded = provisionShieldedWorkspace(slug);
    } catch (err) {
      console.warn(`[projects] Shielded workspace provisioning failed for "${slug}":`, (err as Error).message);
    }

    logAuditEvent({
      type: 'project_registered',
      ip: getClientIp(c),
      details: { slug, displayName: displayName || slug, id, shielded: !!shielded, source: 'internal' },
    });

    const postCreateEntitlement = await getEntitlementStatus();

    return c.json({
      id,
      slug,
      displayName: displayName || slug,
      shielded: shielded ? {
        workspace: shielded.workspace,
        cache: shielded.cache,
        subnet: shielded.subnet,
      } : null,
      entitlement: postCreateEntitlement,
    });
  });

  // Strict all-or-nothing — no silent partial-success masking (2026-04-21 b91cf877).
  app.delete('/api/internal/projects/:slug', async (c) => {
    const slug = c.req.param('slug');
    if (!SLUG_REGEX.test(slug)) {
      return c.json({ error: 'Invalid project slug' }, 400);
    }

    const projectPath = path.join(SVC_HOME, 'projects', slug);

    const fail = (step: string, err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logAuditEvent({
        type: 'project_delete_failed',
        ip: getClientIp(c),
        details: { slug, step, error: message },
      });
      return c.json({ deleted: false, slug, failedStep: step, error: message }, 500);
    };

    // 1. Namespace.
    if (isShielded(slug)) {
      try { destroyNamespace(slug); }
      catch (err) { return fail('namespace', err); }
    }

    // 2. DB roles (must go through shield-pg-wrapper — raw psql has no sudoers entry).
    try {
      const roles = [`shield_${slug}_owner`, `shield_${slug}_app`, `shield_${slug}_readonly`];
      for (const role of roles) {
        execFileSync('sudo', ['-u', 'postgres', '/usr/local/bin/shield-pg-wrapper', '/usr/bin/psql', '-c', `DROP OWNED BY "${role}" CASCADE;`], { stdio: 'pipe' });
        execFileSync('sudo', ['-u', 'postgres', '/usr/local/bin/shield-pg-wrapper', '/usr/bin/psql', '-c', `DROP ROLE IF EXISTS "${role}";`], { stdio: 'pipe' });
      }
    } catch (err) {
      // DROP OWNED BY on non-existent role exits non-zero — not fatal.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/role .* does not exist/i.test(msg)) return fail('database', err);
    }

    // 3. Secrets.
    try {
      for (const pattern of [slug, `${slug}.env`, `${slug}.dev.env`]) {
        fs.rmSync(path.join(SECRETS_DIR, pattern), { recursive: true, force: true });
      }
    } catch (err) { return fail('secrets', err); }

    // 4. Shielded workspace.
    try {
      fs.rmSync(path.join(SHIELDED_PROJECTS_DIR, slug), { recursive: true, force: true });
    } catch (err) { return fail('shielded-workspace', err); }

    // 5. Project dir (entitlement counter's source of truth).
    try {
      execFileSync('sudo', ['/usr/local/bin/shield-project-lock', 'rm', slug], {
        stdio: 'pipe',
        timeout: 10_000,
      });
    } catch (err) { return fail('project-directory', err); }

    // Wrapper can exit 0 while leaving the dir (stale bind mount, immutable bit, race).
    let dirGone = false;
    try { fs.statSync(projectPath); }
    catch { dirGone = true; }
    if (!dirGone) {
      return fail('project-directory-verify',
        new Error(`shield-project-lock exited 0 but ${projectPath} still exists`));
    }

    // 7. Epoch marker.
    try {
      fs.rmSync(path.join(SHIELDED_PROJECTS_DIR, `${slug}.epoch`), { force: true });
    } catch (err) { return fail('epoch', err); }

    logAuditEvent({ type: 'project_deleted', ip: getClientIp(c), details: { slug } });
    return c.json({ deleted: true, slug });
  });
}

// ── Discovery ─────────────────────────────────────────────────────────────

// Sandbox iff dir exists + root-owned + has ellul.json. Same predicate as
// countProjects() so UI/entitlement/reaper always agree. Secrets dirs are NOT
// a discovery source (legitimate bookkeeping persists past project dir).
function discoverProjects(): Array<{ id: string; slug: string; displayName: string }> {
  const slugs: string[] = [];
  try {
    const projectDirs = fs.readdirSync(PROJECTS_DIR);
    for (const entry of projectDirs) {
      if (!SLUG_REGEX.test(entry)) continue;
      const dir = path.join(PROJECTS_DIR, entry);
      try {
        const stat = fs.statSync(dir);
        if (!stat.isDirectory() || stat.uid !== 0) continue;
        if (!fs.existsSync(path.join(dir, 'ellul.json'))) continue;
        slugs.push(entry);
      } catch { /* stat failed — skip */ }
    }
  } catch { /* dir may not exist yet */ }
  slugs.sort();

  return slugs.map((slug) => ({
    id: crypto.createHash('sha256').update(slug).digest('hex').slice(0, 16),
    slug,
    displayName: readDisplayName(slug),
  }));
}
