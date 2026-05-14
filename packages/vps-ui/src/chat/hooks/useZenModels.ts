// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Polls the agent-bridge ellul.getZenModels RPC on mount + every 30 minutes
// and returns the current OpenCode Zen free-model list. Server-side the
// service refreshes on the same cadence, so the client side is mostly a
// cache reader — the 30-min client poll exists to pick up server-side
// changes when the WebSocket reconnects on a new bridge deploy.
//
// The WsRpcClient is set on the ref asynchronously after auth/connect
// finishes. We probe the ref until it becomes available, then switch to
// the 30-min cadence.

import { useEffect, useRef, useState, type RefObject } from "react";
import type { WsRpcClient } from "../lib/ws-rpc-client";
import type { ZenModel } from "../types";

const CLIENT_REFRESH_MS = 30 * 60 * 1000;
const CONNECT_PROBE_MS = 2_000;

export interface UseZenModelsResult {
  readonly models: ReadonlyArray<ZenModel>;
  readonly loading: boolean;
  readonly error: string | null;
}

export function useZenModels(
  wsRpcRef: RefObject<WsRpcClient | null>,
): UseZenModelsResult {
  const [models, setModels] = useState<ReadonlyArray<ZenModel>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    let probeTimer: ReturnType<typeof setInterval> | null = null;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    const refresh = async () => {
      const client = wsRpcRef.current;
      if (!client) return false;
      setLoading(true);
      try {
        const result = await client.getZenModels();
        if (!activeRef.current) return true;
        setModels(result.models.map((m) => ({ id: m.id, openCodeId: m.openCodeId })));
        setError(null);
        return true;
      } catch (err) {
        if (!activeRef.current) return true;
        setError((err as Error).message ?? "failed to load zen models");
        return false;
      } finally {
        if (activeRef.current) setLoading(false);
      }
    };

    const startInterval = () => {
      if (refreshTimer) return;
      refreshTimer = setInterval(() => void refresh(), CLIENT_REFRESH_MS);
    };

    const tryOnce = async () => {
      if (await refresh()) {
        if (probeTimer) {
          clearInterval(probeTimer);
          probeTimer = null;
        }
        startInterval();
      }
    };

    void tryOnce();
    probeTimer = setInterval(() => void tryOnce(), CONNECT_PROBE_MS);

    return () => {
      activeRef.current = false;
      if (probeTimer) clearInterval(probeTimer);
      if (refreshTimer) clearInterval(refreshTimer);
    };
  }, [wsRpcRef]);

  return { models, loading, error };
}
