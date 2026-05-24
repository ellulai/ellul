// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Preview activity tracking.

import { execSync } from 'node:child_process';

// Per-preview activity record.
export interface PreviewActivity {
  // `appDirectory` — the sandbox/app-relative path.
  directory: string;
  // Dev-server port (from the preview spec).
  port: number;
  // ms-epoch of the first start after the reconciler last observed it.
  startedAt: number;
  // ms-epoch of the most recent observation of >=1 established connection.
  lastActivityAt: number;
}

const records = new Map<string, PreviewActivity>();

// Record that a preview just started. Sets startedAt + lastActivityAt
export function recordStart(directory: string, port: number): void {
  const now = Date.now();
  records.set(directory, {
    directory,
    port,
    startedAt: now,
    lastActivityAt: now,
  });
}

// Forget a preview — it's been fully stopped / deleted.
export function recordStop(directory: string): void {
  records.delete(directory);
}

// Reset the whole map (tests + full resync).
export function _resetTrackingForTests(): void {
  records.clear();
}

// Snapshot of all currently-tracked previews.
export function listTracked(): PreviewActivity[] {
  return Array.from(records.values());
}

// Current idleness for a preview (ms since last observed activity).
export function idlenessMs(directory: string, now: number = Date.now()): number | null {
  const r = records.get(directory);
  if (!r) return null;
  return now - r.lastActivityAt;
}

// Observe a preview and update `lastActivityAt` if the kernel shows
export function observeActivity(directory: string): number | null {
  const r = records.get(directory);
  if (!r) return null;
  const count = countEstablishedConnections(r.port);
  if (count > 0) r.lastActivityAt = Date.now();
  return count;
}

// Report the LRU ordering of tracked previews (most-recent-activity
export function lruOrder(): PreviewActivity[] {
  return Array.from(records.values()).sort((a, b) => a.lastActivityAt - b.lastActivityAt);
}

// sockets that would otherwise falsely extend idleness windows.
// optimal; we never fail a preview because of a tracking miscount.
function countEstablishedConnections(port: number): number {
  try {
    const out = execSync(`ss -tnH state established sport = :${port}`, {
      encoding: 'utf8',
      timeout: 1000,
    });
    if (!out) return 0;
    // Each non-empty line = one connection. ss adds no header with -H.
    return out.split('\n').filter(l => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}
