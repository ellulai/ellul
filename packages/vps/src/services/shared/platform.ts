// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Centralized platform detection and capability-gated operations.
 *
 * On VPS (real Linux): full privileges — sudo, namespaces, nftables, UID separation.
 * On Android PRoot: userspace-only — direct filesystem ops, no privilege wrappers.
 *
 * Every privilege-dependent operation is encapsulated here. Consumers import
 * helpers and capabilities instead of scattering IS_ANDROID checks.
 * Adding a new platform (WSL2, Lima) means updating this file only.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

// ── Platform detection (evaluated once at module load) ──

export type Platform = 'vps' | 'android';

export const PLATFORM: Platform =
  process.env.ELLUL_PLATFORM === 'android' ? 'android' : 'vps';

export const IS_ANDROID = PLATFORM === 'android';

// ── Capability queries ──

export const capabilities = {
  sudo: !IS_ANDROID,
  namespaces: !IS_ANDROID,
  nftables: !IS_ANDROID,
  uidSeparation: !IS_ANDROID,
  shieldedWorkspaces: !IS_ANDROID,
  cgroups: !IS_ANDROID,
} as const;

// ── Project directory operations ──

const SHIELD_PROJECT_LOCK = '/usr/local/bin/shield-project-lock';
const SHIELD_PG_WRAPPER = '/usr/local/bin/shield-pg-wrapper';

/**
 * Create a project directory with proper ownership.
 * VPS: root-owned via sudo shield-project-lock (agent cannot delete/rename).
 * Android: regular mkdir (single-user, no privilege separation).
 */
export function createProjectDir(
  projectsDir: string,
  slug: string,
  displayName?: string,
): void {
  const projectDir = path.join(projectsDir, slug);

  if (capabilities.sudo) {
    const args = displayName
      ? [SHIELD_PROJECT_LOCK, 'create-with-meta', slug, displayName.slice(0, 200)]
      : [SHIELD_PROJECT_LOCK, 'create', slug];
    execFileSync('sudo', args, { stdio: 'pipe', timeout: 10_000 });
  } else {
    fs.mkdirSync(projectDir, { recursive: true, mode: 0o755 });
    const configPath = path.join(projectDir, 'ellul.json');
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ displayName: displayName || slug }, null, 2) + '\n',
      );
    }
  }
}

/**
 * Remove a project directory.
 * VPS: sudo shield-project-lock rm (handles root-owned dirs).
 * Android: direct recursive remove.
 */
export function removeProjectDir(projectsDir: string, slug: string): void {
  if (capabilities.sudo) {
    execFileSync('sudo', [SHIELD_PROJECT_LOCK, 'rm', slug], {
      stdio: 'pipe',
      timeout: 10_000,
    });
  } else {
    fs.rmSync(path.join(projectsDir, slug), { recursive: true, force: true });
  }
}

/**
 * Lock a project directory (sticky bit + ownership enforcement).
 * VPS: sudo shield-project-lock lock.
 * Android: no-op (single-user, no privilege separation).
 */
export function lockProjectDir(slug: string): void {
  if (!capabilities.sudo) return;
  execFileSync('sudo', [SHIELD_PROJECT_LOCK, 'lock', slug], {
    stdio: 'pipe',
    timeout: 5_000,
  });
}

/**
 * Check whether a project directory has valid ownership.
 * VPS: must be root-owned (created by shield-project-lock).
 * Android: any owner is valid (PRoot fakes UIDs).
 */
export function isValidProjectOwner(stat: fs.Stats): boolean {
  if (!capabilities.uidSeparation) return true;
  return stat.uid === 0;
}

// ── Database role operations ──

/**
 * Drop PostgreSQL roles for a project.
 * VPS: sudo -u postgres via shield-pg-wrapper.
 * Android: psql directly (engine runs PG as peer-authed user).
 */
export function dropDbRoles(slug: string): void {
  const sanitized = slug.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 48);
  const roles = [
    `shield_${sanitized}_owner`,
    `shield_${sanitized}_app`,
    `shield_${sanitized}_readonly`,
  ];
  for (const role of roles) {
    const dropOwned = `DROP OWNED BY "${role}" CASCADE;`;
    const dropRole = `DROP ROLE IF EXISTS "${role}";`;
    try {
      if (capabilities.sudo) {
        execFileSync('sudo', ['-u', 'postgres', SHIELD_PG_WRAPPER, '/usr/bin/psql', '-c', dropOwned], { stdio: 'pipe' });
        execFileSync('sudo', ['-u', 'postgres', SHIELD_PG_WRAPPER, '/usr/bin/psql', '-c', dropRole], { stdio: 'pipe' });
      } else {
        execFileSync('psql', ['-U', 'postgres', '-Atc', dropOwned], { stdio: 'pipe' });
        execFileSync('psql', ['-U', 'postgres', '-Atc', dropRole], { stdio: 'pipe' });
      }
    } catch {
      // Role may not exist — acceptable during cleanup
    }
  }
}
