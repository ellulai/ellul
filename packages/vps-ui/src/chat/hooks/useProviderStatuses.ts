// SPDX-License-Identifier: MIT
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Subscribes to the agent-bridge ellul.subscribeProviders WS stream and
// returns the current ServerProvider list. Also exposes a refresh() helper
// that re-probes one or all providers (used after the user completes an
// interactive auth flow so the banner updates without waiting for the
// periodic server-side refresh cycle).

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { ProviderKind, ServerProvider } from "@ellul.ai/types";
import type { WsRpcClient } from "../lib/ws-rpc-client";

const CONNECT_PROBE_MS = 2_000;

export interface UseProviderStatusesResult {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: (provider?: ProviderKind) => Promise<ReadonlyArray<ServerProvider> | undefined>;
}

export function useProviderStatuses(
  wsRpcRef: RefObject<WsRpcClient | null>,
  wsEpoch = 0,
): UseProviderStatusesResult {
  const [providers, setProviders] = useState<ReadonlyArray<ServerProvider>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(true);
  const cancelRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    activeRef.current = true;
    let probeTimer: ReturnType<typeof setInterval> | null = null;

    const consumeStream = async (client: WsRpcClient) => {
      try {
        const iterable = client.subscribeProviders();
        const iterator = iterable[Symbol.asyncIterator]();
        cancelRef.current = () => {
          const maybe = iterator as unknown as { cancel?: () => void };
          maybe.cancel?.();
        };
        while (activeRef.current) {
          const { value, done } = await iterator.next();
          if (done || !activeRef.current) break;
          setProviders(value.providers);
          setError(null);
        }
      } catch (err) {
        if (!activeRef.current) return;
        setError((err as Error).message ?? "failed to subscribe to providers");
      } finally {
        if (activeRef.current) setLoading(false);
      }
    };

    const tryOnce = () => {
      const client = wsRpcRef.current;
      if (!client) return false;
      setLoading(true);
      void consumeStream(client);
      return true;
    };

    if (!tryOnce()) {
      probeTimer = setInterval(() => {
        if (tryOnce() && probeTimer) {
          clearInterval(probeTimer);
          probeTimer = null;
        }
      }, CONNECT_PROBE_MS);
    }

    return () => {
      activeRef.current = false;
      if (probeTimer) clearInterval(probeTimer);
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, [wsRpcRef, wsEpoch]);

  const refresh = useCallback(
    async (provider?: ProviderKind): Promise<ReadonlyArray<ServerProvider> | undefined> => {
      const client = wsRpcRef.current;
      if (!client) return undefined;
      try {
        const result = await client.refreshProvider(provider ? { provider } : {});
        if (!activeRef.current) return undefined;
        setProviders(result.providers);
        setError(null);
        return result.providers;
      } catch (err) {
        if (!activeRef.current) return undefined;
        setError((err as Error).message ?? "failed to refresh provider");
        return undefined;
      }
    },
    [wsRpcRef],
  );

  return { providers, loading, error, refresh };
}
