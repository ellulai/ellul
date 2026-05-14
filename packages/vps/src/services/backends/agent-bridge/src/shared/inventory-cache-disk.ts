// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Durable inventory cache (resource-v2 Phase C).
//
// Each adapter (opencode, cursor, codex) maintains an in-memory provider
// inventory cache so its probe doesn't respawn `serve` on every reconciler
// tick. Without disk persistence the cache evaporates on bridge restart,
// hibernate/wake, or release rollover — and the very next reconciler tick
// pays the full probe cost again. On a 4 GB box with 30 s reconciler
// cadence and a probe that takes ~5 s, a fleet-wide restart can saturate
// the bridge cgroup just on probe storms.
//
// This module provides the L2 (disk) layer. Each adapter calls
// `loadInventoryCacheFromDisk` at module load to hydrate L1, and
// `persistInventoryCacheToDisk` on every successful probe write. Cache
// payloads are public CLI inventory data — model names, version strings,
// agent definitions; never auth tokens, never user data. Schema-validated
// on read; corruption is treated as cache miss, never an exception.
//
// Disk layout
// ───────────
//   /etc/ellul/agent-bridge/inventory/opencode.json
//   /etc/ellul/agent-bridge/inventory/cursor.json
//   /etc/ellul/agent-bridge/inventory/codex.json
//
// Permissions: dev:dev 0o640. Same envelope as the existing
// orchestration.db / chat.db files in the parent directory.
//
// Atomic writes: tmp+rename within the same directory. Crash-safe: a
// half-written tmp file is never observed by readers; rename is atomic
// on every reasonable filesystem.
//
// Cache invalidation
// ──────────────────
// The cache key is the adapter's choice — typically a function of the
// binary path + mtime + size, OR the binary's reported `--version`. On
// load, the adapter compares the loaded cacheKey against its current
// expected key; mismatch is a miss. TTL is enforced by the adapter (this
// module is key-agnostic) — typically 6 h.
//
// Security envelope
// ─────────────────
// - File written by the bridge process (uid=dev, gid=dev). No new
//   privileges, no sudo.
// - Mode 0o640: world-unreadable; group-readable for shield-runner if
//   that's later useful for ops, but not currently granted.
// - Schema-validated on read: payload must be JSON, must match the
//   declared shape (version field === expected, fetchedAt is finite,
//   cacheKey is a string). Anything else → treated as cache miss, file
//   left untouched (so the next persist overwrites it cleanly).
// - Path is fixed (no adapter-supplied path component). The only var
//   is the adapter name, which is allowlisted to {opencode,cursor,codex}.

import * as fs from "node:fs";
import * as path from "node:path";

import { logEvent } from "./event-log";

/** Adapters that own an inventory cache backed by this module. */
export type InventoryCacheAdapter = "opencode" | "cursor" | "codex";

/** Schema version of the on-disk format. Bump on incompatible payload changes. */
export const INVENTORY_CACHE_FORMAT_VERSION = 1;

/** Default cache directory. Overridable for tests. */
export const DEFAULT_INVENTORY_CACHE_DIR = "/etc/ellul/agent-bridge/inventory";

const ADAPTER_ALLOWLIST: ReadonlySet<InventoryCacheAdapter> = new Set([
  "opencode",
  "cursor",
  "codex",
]);

const FILE_MODE = 0o640;
const DIR_MODE = 0o750;

/** On-disk envelope. The adapter-specific payload is opaque to this module. */
export interface InventoryCacheFile<T> {
  readonly version: typeof INVENTORY_CACHE_FORMAT_VERSION;
  readonly adapter: InventoryCacheAdapter;
  readonly cacheKey: string;
  readonly fetchedAt: number;
  readonly payload: T;
}

export interface LoadOptions<T> {
  readonly adapter: InventoryCacheAdapter;
  /** Override the cache directory (test only). */
  readonly cacheDir?: string;
  /**
   * Adapter-side schema validator for the payload. Return null to reject
   * the cached entry as cache miss. Defaults to a no-op (accept any
   * payload type — adapter is expected to type-narrow on use).
   */
  readonly validatePayload?: (raw: unknown) => T | null;
  /**
   * Optional TTL guard: if the cached entry is older than this, treat as
   * miss. The adapter typically enforces TTL; this is belt-and-suspenders
   * for cache files written by an older bundle that may have used a
   * shorter TTL than the current one.
   */
  readonly maxAgeMs?: number;
  readonly now?: () => number;
}

export interface PersistOptions<T> {
  readonly adapter: InventoryCacheAdapter;
  readonly cacheKey: string;
  readonly fetchedAt: number;
  readonly payload: T;
  readonly cacheDir?: string;
}

/** Load + validate the on-disk cache for an adapter. Returns null on any error. */
export function loadInventoryCacheFromDisk<T>(
  opts: LoadOptions<T>,
): InventoryCacheFile<T> | null {
  if (!ADAPTER_ALLOWLIST.has(opts.adapter)) return null;
  const filePath = inventoryCachePath(opts.adapter, opts.cacheDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    logEvent("inventory.cache.loadError", {
      adapter: opts.adapter,
      filePath,
      code: code ?? null,
    });
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logEvent("inventory.cache.loadCorrupt", {
      adapter: opts.adapter,
      filePath,
      reason: "json-parse",
    });
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== INVENTORY_CACHE_FORMAT_VERSION ||
    (parsed as { adapter?: unknown }).adapter !== opts.adapter ||
    typeof (parsed as { cacheKey?: unknown }).cacheKey !== "string" ||
    !Number.isFinite((parsed as { fetchedAt?: unknown }).fetchedAt)
  ) {
    logEvent("inventory.cache.loadCorrupt", {
      adapter: opts.adapter,
      filePath,
      reason: "envelope-shape",
    });
    return null;
  }
  const envelope = parsed as InventoryCacheFile<unknown>;
  // Optional TTL guard.
  if (opts.maxAgeMs !== undefined) {
    const now = (opts.now ?? Date.now)();
    if (now - envelope.fetchedAt >= opts.maxAgeMs) {
      logEvent("inventory.cache.loadStale", {
        adapter: opts.adapter,
        filePath,
        ageMs: now - envelope.fetchedAt,
        maxAgeMs: opts.maxAgeMs,
      });
      return null;
    }
  }
  // Adapter-side payload validation (rejects shape drift across releases).
  const payload = opts.validatePayload
    ? opts.validatePayload(envelope.payload)
    : (envelope.payload as T);
  if (payload === null || payload === undefined) {
    logEvent("inventory.cache.loadRejected", {
      adapter: opts.adapter,
      filePath,
      reason: "payload-validate",
    });
    return null;
  }
  logEvent("inventory.cache.loadHit", {
    adapter: opts.adapter,
    filePath,
    cacheKey: envelope.cacheKey,
    ageMs: ((opts.now ?? Date.now)()) - envelope.fetchedAt,
  });
  return { ...envelope, payload };
}

/**
 * Persist the in-memory cache entry to disk. Atomic via tmp+rename.
 * Errors are logged and swallowed — durability is best-effort, never
 * load-bearing for the live request path.
 */
export function persistInventoryCacheToDisk<T>(opts: PersistOptions<T>): void {
  if (!ADAPTER_ALLOWLIST.has(opts.adapter)) return;
  const cacheDir = opts.cacheDir ?? DEFAULT_INVENTORY_CACHE_DIR;
  const filePath = path.join(cacheDir, `${opts.adapter}.json`);
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now().toString(36)}`;
  const envelope: InventoryCacheFile<T> = {
    version: INVENTORY_CACHE_FORMAT_VERSION,
    adapter: opts.adapter,
    cacheKey: opts.cacheKey,
    fetchedAt: opts.fetchedAt,
    payload: opts.payload,
  };
  try {
    fs.mkdirSync(cacheDir, { recursive: true, mode: DIR_MODE });
  } catch (err) {
    logEvent("inventory.cache.persistError", {
      adapter: opts.adapter,
      step: "mkdir",
      cacheDir,
      code: (err as NodeJS.ErrnoException).code ?? null,
    });
    return;
  }
  let body: string;
  try {
    body = JSON.stringify(envelope);
  } catch (err) {
    logEvent("inventory.cache.persistError", {
      adapter: opts.adapter,
      step: "stringify",
      message: (err as Error).message,
    });
    return;
  }
  try {
    fs.writeFileSync(tmpPath, body, { mode: FILE_MODE });
  } catch (err) {
    logEvent("inventory.cache.persistError", {
      adapter: opts.adapter,
      step: "write-tmp",
      tmpPath,
      code: (err as NodeJS.ErrnoException).code ?? null,
    });
    safeUnlink(tmpPath);
    return;
  }
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    logEvent("inventory.cache.persistError", {
      adapter: opts.adapter,
      step: "rename",
      filePath,
      code: (err as NodeJS.ErrnoException).code ?? null,
    });
    safeUnlink(tmpPath);
    return;
  }
  logEvent("inventory.cache.persistOk", {
    adapter: opts.adapter,
    filePath,
    cacheKey: opts.cacheKey,
    bytes: body.length,
  });
}

/** Unlink + ignore ENOENT. */
function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {}
}

export function inventoryCachePath(
  adapter: InventoryCacheAdapter,
  cacheDir: string = DEFAULT_INVENTORY_CACHE_DIR,
): string {
  return path.join(cacheDir, `${adapter}.json`);
}

/**
 * Compute a content-addressable cache key for an adapter binary based on
 * its absolute path + mtime + size. A binary upgrade (atomic-rename
 * deploy or in-place install) flips at least mtime and usually size, so
 * the cached inventory is invalidated automatically without an
 * explicit version compare.
 */
export function inventoryCacheKeyForBinary(binaryPath: string): string | null {
  try {
    const st = fs.statSync(binaryPath);
    return `${binaryPath}:${st.mtimeMs.toFixed(0)}:${st.size}`;
  } catch {
    return null;
  }
}
