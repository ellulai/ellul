// SPDX-License-Identifier: MIT
"use client";

import { useCallback, useRef, useEffect } from "react";
import type { ThreadMessage } from "@/contexts/WorkbenchContext";

// Offline Message Cache for instant thread display.

const CACHE_KEY = "ellul_threads_cache";
const MAX_CACHED_THREADS = 50;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_THREAD_CACHE_SIZE = 200 * 1024; // 200KB per thread

interface CachedThread {
  messages: ThreadMessage[];
  lastUpdated: number;
}

type ThreadCache = Record<string, CachedThread>;

// ── Pure helpers (no React state) ──

function readCache(): ThreadCache {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as ThreadCache;
  } catch {
    return {};
  }
}

function writeCache(cache: ThreadCache): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage full or unavailable — silently skip.
    try {
      const pruned = evictOldest(cache, Math.floor(MAX_CACHED_THREADS / 2));
      localStorage.setItem(CACHE_KEY, JSON.stringify(pruned));
    } catch {
      console.warn("[OfflineCache] localStorage full, cache degraded");
    }
  }
}

// Evict expired entries (older than TTL).
function evictExpired(cache: ThreadCache): ThreadCache {
  const now = Date.now();
  const result: ThreadCache = {};
  for (const [id, entry] of Object.entries(cache)) {
    if (now - entry.lastUpdated < CACHE_TTL_MS) {
      result[id] = entry;
    }
  }
  return result;
}

// Keep only the N most recently updated threads.
function evictOldest(cache: ThreadCache, keepCount: number): ThreadCache {
  const entries = Object.entries(cache).sort(
    ([, a], [, b]) => b.lastUpdated - a.lastUpdated
  );
  const result: ThreadCache = {};
  for (const [id, entry] of entries.slice(0, keepCount)) {
    result[id] = entry;
  }
  return result;
}

// Enforce all limits: TTL expiry, then LRU cap.
function enforce(cache: ThreadCache): ThreadCache {
  let cleaned = evictExpired(cache);
  if (Object.keys(cleaned).length > MAX_CACHED_THREADS) {
    cleaned = evictOldest(cleaned, MAX_CACHED_THREADS);
  }
  return cleaned;
}

// ── Exported standalone functions ──

// Get cached messages for a thread, or null if not cached / expired.
export function getCachedMessages(threadId: string): ThreadMessage[] | null {
  const cache = readCache();
  const entry = cache[threadId];
  if (!entry) return null;
  if (Date.now() - entry.lastUpdated > CACHE_TTL_MS) return null;
  return entry.messages;
}

// Cache messages for a thread. Enforces LRU eviction and TTL.
export function cacheMessages(threadId: string, messages: ThreadMessage[]): void {
  // Skip caching empty message arrays or local-only messages
  const persistable = messages.filter((m) => !m.id.startsWith("local-"));
  if (persistable.length === 0) return;

  // Enforce per-thread size limit — keep most recent messages if too large
  let toCache = persistable;
  let serialized = JSON.stringify(toCache);
  if (serialized.length > MAX_THREAD_CACHE_SIZE) {
    // Binary search for the largest suffix that fits
    let lo = 1;
    let hi = toCache.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const slice = toCache.slice(-mid);
      if (JSON.stringify(slice).length <= MAX_THREAD_CACHE_SIZE) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    toCache = toCache.slice(-lo);
  }

  let cache = readCache();
  cache[threadId] = {
    messages: toCache,
    lastUpdated: Date.now(),
  };
  cache = enforce(cache);
  writeCache(cache);
}

// Clear the entire offline cache.
export function clearCache(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    // best-effort
  }
}

// Remove a single thread from the cache (e.g., on thread delete).
export function removeCachedThread(threadId: string): void {
  const cache = readCache();
  if (cache[threadId]) {
    delete cache[threadId];
    writeCache(cache);
  }
}

// ── React Hook ──

// It debounces writes to avoid excessive serialization on rapid updates
export function useOfflineCache({
  activeThreadId,
  messages,
}: {
  activeThreadId: string | null;
  messages: ThreadMessage[];
}) {
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced cache write — waits 2s after last message change to avoid
  useEffect(() => {
    if (!activeThreadId || messages.length === 0) return;

    // Skip if all messages are local-only (optimistic, not yet confirmed)
    const hasPersistedMessages = messages.some((m) => !m.id.startsWith("local-"));
    if (!hasPersistedMessages) return;

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      cacheMessages(activeThreadId, messages);
      debounceRef.current = null;
    }, 2000);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        // Flush the pending write so data isn't lost on thread switch
        cacheMessages(activeThreadId, messages);
        debounceRef.current = null;
      }
    };
  }, [activeThreadId, messages]);

  // Cleanup expired cache entries on mount (once per session)
  useEffect(() => {
    const cache = readCache();
    const cleaned = enforce(cache);
    if (Object.keys(cleaned).length !== Object.keys(cache).length) {
      writeCache(cleaned);
    }
  }, []);

  return {
    getCachedMessages,
    cacheMessages,
    clearCache,
    removeCachedThread,
  };
}
