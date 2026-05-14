// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Settings Service
 *
 * Local settings CRUD with atomic writes and tier-based overrides.
 *
 * **Polarity rule (per Playbook Appendix D, 2026-04-30):**
 *
 *   This file is authoritative for **VPS-operational state** ONLY:
 *     - terminalEnabled / sshEnabled (what's running on this specific VPS)
 *     - desktopViewMode / uiMode (how the VPS-served UI renders here)
 *
 *   It must NOT carry **user-identity preferences** that travel with the
 *   user across surfaces — locale, timezone, notification channels.
 *   Those live in the api DB `users` table (single source of truth for
 *   every consumer: web, console, docs, every VPS the user has).
 *
 *   The two polarities serve different durability needs:
 *     - VPS-operational state changes per-VPS, often, and is meaningless
 *       outside this host. VPS-authoritative + api-mirror is correct.
 *     - User-identity preferences are one-per-user and read by every
 *       surface. api-DB-authoritative + transient projection (JWT claim
 *       or URL query) is correct — see chat.routes.ts and the file-api
 *       /browser handler for the projection sites.
 *
 *   Adding a new setting? Decide polarity first. Wrong choice creates
 *   drift across the user's surfaces.
 *
 * Flow (VPS-authoritative state):
 *   Dashboard → Bridge → toggleTerminal/toggleSsh → atomic write + apply
 *   → vps-event webhook → API mirrors to DB
 *   → Heartbeat reports actual state every 30s (reconciliation fallback)
 */

import fs from 'fs';
import { exec, execFileSync } from 'child_process';
import { getCurrentTier } from '../gates/Tier';
import { SSH_AUTH_KEYS_PATH } from '../../config';

const SETTINGS_FILE = '/etc/ellul/shield-data/settings.json';
const SETTINGS_TMP = '/etc/ellul/shield-data/settings.json.tmp';

export type DesktopViewMode = 'focus' | 'studio';
export type UiMode = 'lite' | 'pro';

export interface LocalSettings {
  terminalEnabled: boolean;
  sshEnabled: boolean;
  desktopViewMode: DesktopViewMode;
  uiMode: UiMode;
  updatedAt: string;
}

/**
 * Read settings from disk. If file missing/corrupt, return tier-based defaults.
 * Never throws.
 */
export function readSettings(): LocalSettings {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      terminalEnabled: typeof parsed.terminalEnabled === 'boolean' ? parsed.terminalEnabled : true,
      sshEnabled: typeof parsed.sshEnabled === 'boolean' ? parsed.sshEnabled : false,
      desktopViewMode: ['focus', 'studio'].includes(parsed.desktopViewMode) ? parsed.desktopViewMode : 'focus',
      uiMode: ['lite', 'pro'].includes(parsed.uiMode) ? parsed.uiMode : 'pro',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    // File missing or corrupt — return tier-based defaults
    return applyTierOverrides({
      terminalEnabled: true,
      sshEnabled: false,
      desktopViewMode: 'focus',
      uiMode: 'pro',
      updatedAt: new Date().toISOString(),
    });
  }
}

/**
 * Atomic write: write to tmp, fsync, rename.
 * Throws on I/O failure (caller handles).
 */
function writeSettings(settings: LocalSettings): void {
  const data = JSON.stringify(settings, null, 2) + '\n';
  const fd = fs.openSync(SETTINGS_TMP, 'w', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(SETTINGS_TMP, SETTINGS_FILE);
  // Ensure root:root 644 — readable by file-api for __SHIELD_SETTINGS__ injection
  try {
    execFileSync('chown', ['root:root', SETTINGS_FILE], { stdio: 'pipe' });
    fs.chmodSync(SETTINGS_FILE, 0o644);
  } catch {}
}

/**
 * Apply tier-based overrides. This is the canonical enforcement logic.
 * Mirrors enforce_settings() in enforcement.sh exactly:
 * - standard: terminal=true, ssh=false
 * - web_locked: terminal=true, ssh=(keys present)
 * - SAFETY: SSH always true if authorized_keys exists and non-empty
 */
export function applyTierOverrides(settings: LocalSettings): LocalSettings {
  const tier = getCurrentTier();
  const result = { ...settings };

  switch (tier) {
    case 'standard':
      result.sshEnabled = false;
      result.terminalEnabled = true;
      break;
    case 'web_locked': case 'private_locked':
      result.terminalEnabled = true;
      // SSH enabled if keys are present
      try {
        const authKeys = fs.readFileSync(SSH_AUTH_KEYS_PATH, 'utf8');
        result.sshEnabled = authKeys.split('\n').some(line => line.trim() && !line.startsWith('#'));
      } catch {
        result.sshEnabled = false;
      }
      break;
  }

  // SAFETY CHECK: Never close SSH if keys are present (prevents lockout)
  try {
    const authKeys = fs.readFileSync(SSH_AUTH_KEYS_PATH, 'utf8');
    if (authKeys.split('\n').some(line => line.trim() && !line.startsWith('#'))) {
      result.sshEnabled = true;
    }
  } catch {}

  return result;
}

/**
 * Toggle terminal. Writes to disk, applies via systemctl, returns new state.
 * Throws if systemctl fails (caller returns 500).
 */
export function toggleTerminal(enabled: boolean): LocalSettings {
  const settings = readSettings();
  settings.terminalEnabled = enabled;
  settings.updatedAt = new Date().toISOString();
  const effective = applyTierOverrides(settings);
  writeSettings(effective);
  applyTerminalState(effective.terminalEnabled);
  return effective;
}

/**
 * Toggle SSH. Writes to disk, applies via ufw, returns new state.
 * Throws if ufw fails.
 */
export function toggleSsh(enabled: boolean): LocalSettings {
  const settings = readSettings();
  settings.sshEnabled = enabled;
  settings.updatedAt = new Date().toISOString();
  const effective = applyTierOverrides(settings);
  writeSettings(effective);
  applySshState(effective.sshEnabled);
  return effective;
}

/**
 * Start or stop all terminal services.
 */
function applyTerminalState(enabled: boolean): void {
  // Non-blocking: systemctl can take seconds and would block sovereign-shield's
  // event loop, causing forward_auth timeouts → 502 during tier switch.
  if (enabled) {
    exec('systemctl start ellul-agent-bridge ellul-term-proxy 2>/dev/null || true', { timeout: 10_000 }, () => {});
  } else {
    exec('systemctl stop ellul-agent-bridge ellul-term-proxy 2>/dev/null || true', { timeout: 10_000 }, () => {});
    exec("systemctl list-units 'ttyd@*' --no-legend | awk '{print $1}' | xargs -r systemctl stop 2>/dev/null || true", { timeout: 10_000 }, () => {});
  }
}

/**
 * Start/stop sshd + open/close firewall port.
 * sshd is disabled at provisioning — must be explicitly started.
 */
function applySshState(enabled: boolean): void {
  if (enabled) {
    exec("systemctl enable --now sshd 2>/dev/null || true", { timeout: 10_000 }, () => {});
    exec("ufw status | grep -q '22/tcp.*ALLOW' || ufw allow 22/tcp comment 'SSH' 2>/dev/null || true", { timeout: 5_000 }, () => {});
  } else {
    exec("ufw status | grep -q '22/tcp.*ALLOW' && ufw delete allow 22/tcp 2>/dev/null || true", { timeout: 5_000 }, () => {});
    exec("systemctl disable --now sshd 2>/dev/null || true", { timeout: 10_000 }, () => {});
  }
}

/**
 * Set desktop view mode. Pure UI preference — no system side effects.
 */
export function setDesktopViewMode(mode: DesktopViewMode): LocalSettings {
  const settings = readSettings();
  settings.desktopViewMode = mode;
  settings.updatedAt = new Date().toISOString();
  writeSettings(settings);
  return settings;
}

/**
 * Set UI mode (lite/pro). Pure UI preference — no system side effects.
 */
export function setUiMode(mode: UiMode): LocalSettings {
  const settings = readSettings();
  settings.uiMode = mode;
  settings.updatedAt = new Date().toISOString();
  writeSettings(settings);
  return settings;
}

/**
 * Initialize settings file if missing (called on boot).
 * Creates with tier-appropriate defaults.
 */
export function initSettings(): void {
  if (fs.existsSync(SETTINGS_FILE)) return;
  const defaults = applyTierOverrides({
    terminalEnabled: true,
    sshEnabled: false,
    desktopViewMode: 'focus',
    uiMode: 'lite',
    updatedAt: new Date().toISOString(),
  });
  writeSettings(defaults);
}

/**
 * Called when tier changes — recompute settings with new tier overrides.
 */
export function onTierChanged(): void {
  const current = readSettings();
  const effective = applyTierOverrides(current);
  writeSettings(effective);
  applyTerminalState(effective.terminalEnabled);
  applySshState(effective.sshEnabled);
}

/**
 * Called after SSH key add/remove — recompute settings based on key presence.
 * For web_locked: sshEnabled follows authorized_keys (keys present = ssh on).
 * Returns the effective settings for webhook notification.
 */
export function syncSettingsAfterKeyChange(): LocalSettings {
  const current = readSettings();
  const effective = applyTierOverrides(current);
  writeSettings(effective);
  applySshState(effective.sshEnabled);
  return effective;
}
