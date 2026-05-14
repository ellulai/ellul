// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { SafePeekResponse } from "@vps/shared/claude-oat";
import type {
  AuthStateCache,
  AuthStateSnapshot,
  ShieldOatGateway,
} from "../application/ports";

const BACKGROUND_REFRESH_MS = 60_000;

const INIT_SNAPSHOT: AuthStateSnapshot = {
  peek: null,
  source: "init",
  checkedAt: 0,
};

export class AuthStateCacheImpl implements AuthStateCache {
  private snapshot: AuthStateSnapshot = INIT_SNAPSHOT;
  private inflight: Promise<AuthStateSnapshot> | null = null;
  private bgTimer: NodeJS.Timeout | null = null;

  constructor(private readonly gateway: ShieldOatGateway) {}

  getSnapshot(): AuthStateSnapshot {
    return this.snapshot;
  }

  isAuthed(): boolean {
    return this.snapshot.peek?.hasToken === true;
  }

  setFromSave(): void {
    const now = new Date();
    const peek: SafePeekResponse = {
      state: "active",
      hasToken: true,
      tokenPrefix: null,
      lastVerifiedAt: now.toISOString(),
      lastFailedAt: null,
      suspectFailureCount: 0,
      revokedAt: null,
      revokedReason: null,
    };
    this.snapshot = { peek, source: "save", checkedAt: now.getTime() };
  }

  setFromRevoke(): void {
    const now = new Date();
    const peek: SafePeekResponse = {
      state: "revoked",
      hasToken: false,
      tokenPrefix: null,
      lastVerifiedAt: this.snapshot.peek?.lastVerifiedAt ?? null,
      lastFailedAt: null,
      suspectFailureCount: 0,
      revokedAt: now.toISOString(),
      revokedReason: "user-logout",
    };
    this.snapshot = { peek, source: "revoke", checkedAt: now.getTime() };
  }

  refresh(): Promise<AuthStateSnapshot> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const peek = await this.gateway.peek();
        // Stale-on-error: peek === null means timeout/shield error; keep
        // the existing snapshot rather than blanking the UI to "unknown".
        if (peek) {
          this.snapshot = { peek, source: "peek", checkedAt: Date.now() };
        }
        return this.snapshot;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  start(): void {
    if (this.bgTimer) return;
    void this.refresh();
    this.bgTimer = setInterval(() => {
      void this.refresh();
    }, BACKGROUND_REFRESH_MS);
    if (typeof this.bgTimer.unref === "function") this.bgTimer.unref();
  }

  stop(): void {
    if (this.bgTimer) clearInterval(this.bgTimer);
    this.bgTimer = null;
  }

  refreshAsync(): void {
    void this.refresh();
  }

  invalidate(): void {
    this.snapshot = { ...this.snapshot, checkedAt: 0 };
  }

  async invalidateAndAwaitRefresh(): Promise<boolean> {
    await this.refresh();
    return this.isAuthed();
  }
}
