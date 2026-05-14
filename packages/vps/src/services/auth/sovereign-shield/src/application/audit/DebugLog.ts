// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Structured debug log for the passkey/gating flow.
//
// Writes JSONL to /var/log/ellul/shield-debug.jsonl with mode 0644 so the
// non-privileged service user can `tail -f` over plain SSH without sudo.
// Append-only, sync writes, never throws — auth flow must not depend on
// debug logging working.

import fs from 'fs';
import path from 'path';

const DEBUG_LOG_PATH = '/var/log/ellul/shield-debug.jsonl';
const ROTATE_AT_BYTES = 50 * 1024 * 1024;
const ROTATE_CHECK_EVERY_BYTES = 1 * 1024 * 1024;
// Shield runs as shield-runner; /var/log/ellul is dev:dev 0755, so file
// creation fails until provisioning touches it. Retry on each dbg() call
// (throttled) so a pre-created world-writable file picks up logging without
// a service restart.
const REOPEN_RETRY_MS = 30_000;

let fd: number | null = null;
let lastReopenAttemptMs = 0;
let bytesSinceCheck = 0;

function openLog(): void {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG_PATH), { recursive: true, mode: 0o755 });
    fd = fs.openSync(DEBUG_LOG_PATH, 'a', 0o644);
    // Self-destruct guard: shield runs as shield-runner with CAP_FOWNER,
    // so chmodSync would succeed even when we don't own the file —
    // tightening dev-owned 666 to 644 made openSync fail on the NEXT
    // restart (shield-runner is "other", 644 = read-only). Take ownership
    // first (CAP_CHOWN is in AmbientCapabilities), then 644 leaves the
    // file rw for the owner shield-runner and r for everyone else
    // including dev.
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    const gid = typeof process.getgid === 'function' ? process.getgid() : -1;
    if (uid >= 0 && gid >= 0) {
      try { fs.chownSync(DEBUG_LOG_PATH, uid, gid); } catch {}
    }
    try { fs.chmodSync(DEBUG_LOG_PATH, 0o644); } catch {}
  } catch {
    fd = null;
  }
}

function tryReopenIfClosed(): void {
  if (fd !== null) return;
  const now = Date.now();
  if (now - lastReopenAttemptMs < REOPEN_RETRY_MS) return;
  lastReopenAttemptMs = now;
  openLog();
}

function rotateIfNeeded(): void {
  if (bytesSinceCheck < ROTATE_CHECK_EVERY_BYTES) return;
  bytesSinceCheck = 0;
  try {
    const st = fs.statSync(DEBUG_LOG_PATH);
    if (st.size > ROTATE_AT_BYTES) {
      if (fd !== null) { try { fs.closeSync(fd); } catch {} }
      fd = null;
      try { fs.renameSync(DEBUG_LOG_PATH, DEBUG_LOG_PATH + '.1'); } catch {}
      openLog();
    }
  } catch {}
}

export function initDebugLog(): void {
  openLog();
  dbg('shield', 'debug_log_init', { path: DEBUG_LOG_PATH, pid: process.pid });
}

export function dbg(phase: string, decision: string, details?: Record<string, unknown>): void {
  tryReopenIfClosed();
  if (fd === null) return;
  try {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      phase,
      decision,
      ...(details ?? {}),
    }) + '\n';
    fs.writeSync(fd, line);
    bytesSinceCheck += line.length;
    rotateIfNeeded();
  } catch {}
}
