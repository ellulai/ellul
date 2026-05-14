// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// late-returning response from a previous project never races onto the

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ActionContext,
  IntegrationsResponse,
  ResolvedAction,
} from "@ellul.ai/types";
import { getAvailableActions } from "@ellul.ai/chat-actions";

export interface UseIntegrationsResult {
  // Full response from the VPS — null before the first successful fetch.
  data: IntegrationsResponse | null;
  // Actions that passed the resolver for the chat's `workspace` context.
  resolvedActions: ResolvedAction[];
  // True while the first fetch for the current project is in flight.
  loading: boolean;
  // Last fetch error — non-fatal; the dropdown simply hides.
  error: string | null;
  // Force a re-fetch, bypassing any freshness heuristics.
  refetch: () => void;
}

const DEFAULT_CONTEXT: ActionContext = { currentContext: "workspace" };

export function useIntegrations(
  project: string | null,
): UseIntegrationsResult {
  const [data, setData] = useState<IntegrationsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  // Bump to force a revalidate; effect body reads it off deps.
  const [revalidateTick, setRevalidateTick] = useState(0);

  const abortRef = useRef<AbortController | null>(null);

  const refetch = useCallback(() => {
    setRevalidateTick((t) => t + 1);
  }, []);

  useEffect(() => {
    if (!project) {
      // Project cleared — drop stale state so the dropdown re-evaluates.
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }

    let alive = true;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);

    (async () => {
      try {
        // Same-origin query-param route (wired via caddy-gen on the -srv
        const res = await fetch(
          `/api/app-integrations?project=${encodeURIComponent(project)}`,
          {
            credentials: "include",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          },
        );
        if (!res.ok) {
          throw new Error(`integrations fetch ${res.status}`);
        }
        const body = (await res.json()) as IntegrationsResponse;
        if (!alive) return;
        setData(body);
        setError(null);
      } catch (err) {
        if (!alive) return;
        if ((err as Error).name === "AbortError") return;
        setData(null);
        setError((err as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [project, revalidateTick]);

  // Revalidate on any signal that the world might have changed under us:
  useEffect(() => {
    if (!project) return;
    const tick = () => setRevalidateTick((t) => t + 1);
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    window.addEventListener("focus", tick);
    window.addEventListener("online", tick);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", tick);
      window.removeEventListener("online", tick);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [project]);

  const resolvedActions = data
    ? getAvailableActions(data.state, DEFAULT_CONTEXT)
    : [];

  return { data, resolvedActions, loading, error, refetch };
}
