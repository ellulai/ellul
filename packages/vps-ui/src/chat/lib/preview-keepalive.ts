// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

export interface KeepaliveConfig {
  appDirectory: string;
  port: number;
  intervalMs?: number;
  send: (payload: { appDirectory: string; port: number; at: number }) => void;
  isVisible?: () => boolean;
  onVisibilityChange?: (cb: () => void) => () => void;
  now?: () => number;
}

export interface KeepaliveHandle {
  stop(): void;
}

const DEFAULT_INTERVAL = 60_000;

export function startPreviewKeepalive(cfg: KeepaliveConfig): KeepaliveHandle {
  const intervalMs = cfg.intervalMs ?? DEFAULT_INTERVAL;
  const isVisible = cfg.isVisible ?? (() => typeof document === "undefined" || document.visibilityState === "visible");
  const onVisibilityChange = cfg.onVisibilityChange ?? defaultVisibilitySubscribe;
  const now = cfg.now ?? Date.now;

  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function tick(): void {
    if (stopped) return;
    if (!isVisible()) return;
    cfg.send({ appDirectory: cfg.appDirectory, port: cfg.port, at: now() });
  }

  function start(): void {
    if (timer || stopped) return;
    tick();
    timer = setInterval(tick, intervalMs);
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  if (isVisible()) start();

  const unsub = onVisibilityChange(() => {
    if (stopped) return;
    if (isVisible()) start();
    else stop();
  });

  return {
    stop() {
      stopped = true;
      stop();
      unsub();
    },
  };
}

function defaultVisibilitySubscribe(cb: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}
