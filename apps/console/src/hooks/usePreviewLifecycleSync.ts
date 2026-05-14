// SPDX-License-Identifier: MIT
"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRealtimeSubscribe } from "@/providers/realtime-provider";
import {
  CANONICAL_PREVIEW_PHASES,
  type PreviewLifecycleEvent,
  type PreviewLifecyclePhase,
} from "@ellul.ai/types";

// seconds because the port isn't bound yet and getPreviewHealth's
// starting_server) do NOT invalidate — they're UI-annotation events
export function usePreviewLifecycleSync() {
  const queryClient = useQueryClient();

  const handleMessage = useCallback(
    (message: { type: string; data?: unknown }) => {
      if (message.type !== "preview_install_status") return;
      const data = message.data as Partial<PreviewLifecycleEvent> | undefined;
      const phase = data?.phase;
      // Single source of truth for which phases warrant a refetch — the
      if (!phase || !CANONICAL_PREVIEW_PHASES.has(phase as PreviewLifecyclePhase)) return;
      // Prefix invalidation — matches every ["current-app", ...] query
      queryClient.invalidateQueries({ queryKey: ["current-app"] });
    },
    [queryClient],
  );

  useRealtimeSubscribe(handleMessage);
}
