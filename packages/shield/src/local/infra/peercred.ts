// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Unix socket peer-UID check. Tiers: N-API addon → C helper → null (rely on 0700 dir perms).
// Uses private `socket._handle.fd` (stable in practice); checked at runtime.

import { execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type * as net from 'net';

export interface PeerCredentials {
  uid: number;
  gid: number;
  pid?: number;
}

// ── Tier 1: N-API Native Addon ──

interface NativeAddon {
  getPeerCredentials(fd: number): PeerCredentials | null;
}

let nativeAddon: NativeAddon | null = null;
let nativeAddonChecked = false;

function loadNativeAddon(): NativeAddon | null {
  if (nativeAddonChecked) return nativeAddon;
  nativeAddonChecked = true;

  try {
    // node-gyp places the built addon at build/Release/peercred.node
    // relative to the native/ directory. After npm install, it's at
    // packages/cli/build/Release/peercred.node
    const addonPath = path.resolve(__dirname, '..', 'build', 'Release', 'peercred.node');
    if (fs.existsSync(addonPath)) {
      nativeAddon = require(addonPath) as NativeAddon;
    }
  } catch {
    nativeAddon = null;
  }
  return nativeAddon;
}

// ── Tier 2: C Helper Binary ──

const HELPER_LOCATIONS = [
  // Installed alongside the daemon
  () => path.resolve(__dirname, '..', 'native', 'get-peercred'),
  // User's local bin
  () => path.join(process.env.HOME || '~', '.ellul', 'bin', 'get-peercred'),
];

let helperPath: string | null | undefined; // undefined = not checked yet

function findHelperBinary(): string | null {
  if (helperPath !== undefined) return helperPath;

  for (const locate of HELPER_LOCATIONS) {
    const p = locate();
    try {
      fs.accessSync(p, fs.constants.X_OK);
      helperPath = p;
      return p;
    } catch {
      // not found or not executable, try next
    }
  }
  helperPath = null;
  return null;
}

function getCredsViaHelper(fd: number): PeerCredentials | null {
  const bin = findHelperBinary();
  if (!bin) return null;

  try {
    const output = execFileSync(bin, [String(fd)], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(output.trim());
    if (typeof parsed.uid !== 'number' || typeof parsed.gid !== 'number') {
      return null;
    }
    return {
      uid: parsed.uid,
      gid: parsed.gid,
      pid: typeof parsed.pid === 'number' ? parsed.pid : undefined,
    };
  } catch {
    return null;
  }
}

// ── Tier 3: null (filesystem-only) ──
// If both tiers fail, the caller gets null and must decide how to proceed.
// The daemon logs a warning and relies on socket directory permissions.

// ── Public API ──

/**
 * Extract the file descriptor from a connected net.Socket.
 *
 * Uses the private `_handle.fd` property. Returns -1 if unavailable.
 * This is the only place in the codebase that touches this private API.
 */
function getSocketFd(socket: net.Socket): number {
  try {
    const handle = (socket as unknown as { _handle?: { fd?: number } })._handle;
    if (handle && typeof handle.fd === 'number' && handle.fd >= 0) {
      return handle.fd;
    }
  } catch {
    // Property access failed
  }
  return -1;
}

/**
 * Get peer credentials for a connected Unix domain socket.
 *
 * Tries in order:
 *   1. N-API native addon (getsockopt call, zero overhead)
 *   2. C helper binary (execFileSync, ~2ms overhead per call)
 *   3. null (filesystem permissions only)
 *
 * Returns null if:
 *   - Not a Unix domain socket
 *   - socket._handle.fd not available
 *   - All resolution tiers failed
 *   - Platform is not Linux or macOS
 */
export function getPeerCredentials(socket: net.Socket): PeerCredentials | null {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    return null;
  }

  const fd = getSocketFd(socket);
  if (fd < 0) return null;

  // Tier 1: native addon
  const addon = loadNativeAddon();
  if (addon) {
    try {
      return addon.getPeerCredentials(fd);
    } catch {
      // Fall through to tier 2
    }
  }

  // Tier 2: C helper binary
  const helperResult = getCredsViaHelper(fd);
  if (helperResult) return helperResult;

  // Tier 3: null — caller must decide
  return null;
}

/** Which tier of peer credential resolution is available. */
export type PeercredTier = 'native-addon' | 'helper-binary' | 'filesystem-only';

/**
 * Check which peer credential tier is available (for diagnostics / ellul doctor).
 * Does NOT require a connected socket — just checks if the addon or helper exists.
 */
export function getAvailableTier(): PeercredTier {
  if (loadNativeAddon()) return 'native-addon';
  if (findHelperBinary()) return 'helper-binary';
  return 'filesystem-only';
}
