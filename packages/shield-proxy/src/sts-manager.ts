// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Client-side per-project STS tokens. Auto-refresh at 80% TTL; debounced forceRefresh on expiry race.
// Volatile heap only, never disk. Daemon-owned; MCP subprocesses share tokens.

import type { IHostEnvironment } from './ports';

/** Cached STS token for a single project slug. */
interface TokenEntry {
  /** Compact JWS string. */
  token: string;
  /** Expiration timestamp (unix ms). */
  expiresAtMs: number;
  /** Timer handle for auto-refresh. */
  refreshTimer: ReturnType<typeof setTimeout> | null;
  /** Immutable infrastructure slug (e.g., "sbx-a1b2c3d"). */
  slug: string;
}

/** Result of a token acquisition or refresh. */
interface TokenResult {
  token: string;
  expiresAt: number;
  slug: string;
}

/** Default STS token TTL in seconds (must match VPS sts.service.ts). */
const STS_TOKEN_TTL_SECONDS = 15 * 60;

/** Refresh at 80% of TTL (12 minutes for 15-minute tokens). */
const REFRESH_RATIO = 0.8;

/** Minimum time between force-refresh attempts (debounce). */
const FORCE_REFRESH_DEBOUNCE_MS = 2000;

export class StsManager {
  private tokens = new Map<string, TokenEntry>();
  private proxyPort: number = 0;
  private host: IHostEnvironment;

  /**
   * In-flight force-refresh promises per project.
   * Multiple concurrent 401s trigger only ONE refresh.
   * All waiters receive the same result.
   */
  private forceRefreshInFlight = new Map<string, Promise<string | null>>();

  /** Timestamp of last force-refresh attempt per project. */
  private lastForceRefreshAt = new Map<string, number>();

  constructor(host: IHostEnvironment) {
    this.host = host;
  }

  /** Set the proxy port for making requests to the VPS through the local proxy. */
  setProxyPort(port: number): void {
    this.proxyPort = port;
  }

  /**
   * Acquire an STS token for a project by its immutable slug.
   * If a valid cached token exists, returns it immediately.
   * Otherwise, fetches a new token from the VPS.
   */
  async acquireToken(slug: string): Promise<string | null> {
    // Check cache first
    const cached = this.tokens.get(slug);
    if (cached && cached.expiresAtMs > Date.now() + 30_000) {
      // Valid with at least 30s remaining
      return cached.token;
    }

    return this.fetchToken(slug);
  }

  /**
   * Get a cached token synchronously (for header injection in hot path).
   * Returns null if no valid cached token exists.
   */
  getToken(slug: string): string | null {
    const cached = this.tokens.get(slug);
    if (!cached) return null;
    if (cached.expiresAtMs <= Date.now()) {
      // Expired — don't return stale token
      return null;
    }
    return cached.token;
  }

  /**
   * Force-refresh a token (for Gotcha #4: in-flight request expiry).
   *
   * This is debounced: multiple concurrent calls for the same project
   * coalesce into a single refresh. The first caller initiates the
   * refresh, subsequent callers await the same promise.
   *
   * Returns the new token string, or null if refresh failed.
   */
  async forceRefresh(slug: string): Promise<string | null> {
    // Debounce: don't refresh if we just did
    const lastRefresh = this.lastForceRefreshAt.get(slug) || 0;
    if (Date.now() - lastRefresh < FORCE_REFRESH_DEBOUNCE_MS) {
      // Return current token (may be the just-refreshed one)
      return this.getToken(slug);
    }

    // Coalesce concurrent calls
    const inFlight = this.forceRefreshInFlight.get(slug);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.doForceRefresh(slug);
    this.forceRefreshInFlight.set(slug, promise);

    try {
      return await promise;
    } finally {
      this.forceRefreshInFlight.delete(slug);
    }
  }

  /**
   * Remove a project's cached token (e.g., when project is unregistered).
   */
  removeToken(slug: string): void {
    const entry = this.tokens.get(slug);
    if (entry?.refreshTimer) {
      clearTimeout(entry.refreshTimer);
    }
    this.tokens.delete(slug);
    this.forceRefreshInFlight.delete(slug);
    this.lastForceRefreshAt.delete(slug);
  }

  /**
   * Get all currently registered project names with tokens.
   */
  getRegisteredProjects(): string[] {
    return [...this.tokens.keys()];
  }

  /**
   * Stop all refresh timers (for graceful shutdown).
   */
  dispose(): void {
    for (const [, entry] of this.tokens) {
      if (entry.refreshTimer) {
        clearTimeout(entry.refreshTimer);
      }
    }
    this.tokens.clear();
    this.forceRefreshInFlight.clear();
    this.lastForceRefreshAt.clear();
  }

  // ── Private ──

  private async doForceRefresh(slug: string): Promise<string | null> {
    this.lastForceRefreshAt.set(slug, Date.now());

    const cached = this.tokens.get(slug);
    if (cached?.token) {
      // Try refresh endpoint first (validates existing token + session)
      const refreshed = await this.refreshToken(slug, cached.token);
      if (refreshed) return refreshed;
    }

    // Refresh failed — try full acquisition
    return this.fetchToken(slug);
  }

  private async fetchToken(slug: string): Promise<string | null> {
    if (!this.proxyPort) {
      this.host.log('[sts] Cannot acquire token: proxy port not set');
      return null;
    }

    try {
      const res = await fetch(`http://127.0.0.1:${this.proxyPort}/_auth/sts/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.host.log(`[sts] Token acquisition failed for "${slug}": ${res.status} ${body}`);
        if (res.status === 401) {
          this.host.notifyUser('Session expired — re-authenticate to continue.', 'warning');
        }
        return null;
      }

      const data = await res.json() as TokenResult;
      this.cacheToken(slug, data);
      return data.token;
    } catch (err) {
      this.host.log(`[sts] Token acquisition error for "${slug}": ${err}`);
      return null;
    }
  }

  private async refreshToken(slug: string, existingToken: string): Promise<string | null> {
    if (!this.proxyPort) return null;

    try {
      const res = await fetch(`http://127.0.0.1:${this.proxyPort}/_auth/sts/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: existingToken }),
      });

      if (!res.ok) {
        // Refresh failed — could be expired, session rotated, etc.
        return null;
      }

      const data = await res.json() as TokenResult;
      this.cacheToken(slug, data);
      return data.token;
    } catch {
      return null;
    }
  }

  private cacheToken(slug: string, data: TokenResult): void {
    // Cancel existing refresh timer
    const existing = this.tokens.get(slug);
    if (existing?.refreshTimer) {
      clearTimeout(existing.refreshTimer);
    }

    const expiresAtMs = data.expiresAt * 1000;
    const ttlMs = expiresAtMs - Date.now();

    // Schedule auto-refresh at 80% TTL
    const refreshDelayMs = Math.max(ttlMs * REFRESH_RATIO, 5000);
    const refreshTimer = setTimeout(() => {
      this.refreshToken(slug, data.token).catch(() => {
        // Refresh failed silently — next getToken() will return null,
        // triggering acquireToken() on the next request
        this.host.log(`[sts] Background refresh failed for "${slug}"`);
      });
    }, refreshDelayMs);
    refreshTimer.unref(); // Don't prevent process exit

    this.tokens.set(slug, {
      token: data.token,
      expiresAtMs,
      refreshTimer,
      slug: data.slug,
    });

    this.host.log(`[sts] Token cached for "${slug}" (expires in ${Math.round(ttlMs / 1000)}s, refresh in ${Math.round(refreshDelayMs / 1000)}s)`);
  }
}
