// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

export interface PreviewKeepalivePing {
  appDirectory: string;
  port: number;
  at: number;
}

export interface ActivityObserver {
  /** Returns the latest HTTP-side activity timestamp (ms) for an app. */
  httpActivityAt(appDirectory: string): number | null;
}

export interface PreviewKeepaliveDeps {
  http: ActivityObserver;
  defaultIdleMs?: number;
  now?: () => number;
}

export interface PreviewKeepaliveService {
  observePing(p: PreviewKeepalivePing): void;
  isIdle(appDirectory: string): boolean;
  lastActivityAt(appDirectory: string): number | null;
  setIdleThresholdMs(ms: number): void;
  idleThresholdMs(): number;
}

export function makePreviewKeepalive(deps: PreviewKeepaliveDeps): PreviewKeepaliveService {
  const now = deps.now ?? Date.now;
  let idleMs = deps.defaultIdleMs ?? 8 * 60 * 1000;
  const wsActivity = new Map<string, number>();

  function activity(appDirectory: string): number | null {
    const ws = wsActivity.get(appDirectory) ?? null;
    const http = deps.http.httpActivityAt(appDirectory);
    if (ws === null && http === null) return null;
    return Math.max(ws ?? 0, http ?? 0);
  }

  return {
    observePing(p) {
      const cur = wsActivity.get(p.appDirectory);
      const at = Math.max(cur ?? 0, p.at);
      wsActivity.set(p.appDirectory, at);
    },
    isIdle(appDirectory) {
      const last = activity(appDirectory);
      if (last === null) return true;
      return now() - last >= idleMs;
    },
    lastActivityAt(appDirectory) { return activity(appDirectory); },
    setIdleThresholdMs(ms) { idleMs = Math.max(60_000, ms); },
    idleThresholdMs() { return idleMs; },
  };
}
