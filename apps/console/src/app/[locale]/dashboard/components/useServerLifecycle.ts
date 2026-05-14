// SPDX-License-Identifier: MIT
"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useEncryptionPasskey } from "@/hooks/useEncryptionPasskey";
import { useTabVisibility } from "@/hooks/useVisibility";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import type { ServerStatus } from "@/contexts/DashboardContext";

// Manages server lifecycle state: auto-wake, volume unlock, resize timers,
export function useServerLifecycle(
  serverStatus: ServerStatus | undefined,
  effectiveServerStatus: ServerStatus | undefined,
  wakeServerMutation: { isPending: boolean; error: Error | null; mutate: () => void },
  triggerRapidPoll: () => void,
) {
  const queryClient = useQueryClient();
  const t = useTranslations("console");
  const { getPrfKey, unlockVolume, isUnlocking } = useEncryptionPasskey();
  const isVisible = useTabVisibility();
  const prfKeyRef = useRef<string | null>(null);
  const [unlockError, setUnlockError] = useState<string | null>(null);

  // ── Auto-wake ──

  const [autoWakeTriggered, setAutoWakeTriggered] = useState(false);
  const [wakeStartedAt, setWakeStartedAt] = useState<number | null>(null);
  const [wakeElapsed, setWakeElapsed] = useState(0);
  const prevStatusRef = useRef<string | undefined>(undefined);
  const prevUpdateStatusRef = useRef<string | undefined>(undefined);

  // When status is "waking", show wake UI without firing another call
  useEffect(() => {
    if (serverStatus?.state === "waking" && !autoWakeTriggered) {
      setAutoWakeTriggered(true);
      if (!wakeStartedAt) setWakeStartedAt(Date.now());
      triggerRapidPoll();
    }
  }, [serverStatus?.state, autoWakeTriggered, wakeStartedAt, triggerRapidPoll]);

  // Auto-wake when hibernated — only when tab is visible (same pattern as passkey popup).
  useEffect(() => {
    if (!isVisible) return;
    if (serverStatus?.state === "hibernated" && !wakeServerMutation.isPending && !autoWakeTriggered) {
      setAutoWakeTriggered(true);
      setWakeStartedAt(Date.now());

      if (serverStatus?.server?.volumeSecurityMode === "sovereign") {
        setUnlockError(null);
        getPrfKey()
          .then((key) => { prfKeyRef.current = key; wakeServerMutation.mutate(); })
          .catch((err) => {
            const msg = err instanceof Error ? err.message : "Passkey authentication failed";
            if (!msg.includes("cancelled") && !msg.includes("abort")) setUnlockError(msg);
            setAutoWakeTriggered(false);
          });
      } else {
        wakeServerMutation.mutate();
      }
    }
  }, [isVisible, serverStatus?.state, serverStatus?.server?.volumeSecurityMode, wakeServerMutation, autoWakeTriggered, getPrfKey]);

  // Auto-unlock when awaiting_unlock + PRF key available
  useEffect(() => {
    const serverId = serverStatus?.server?.id;
    const key = prfKeyRef.current;
    if (serverStatus?.state === "awaiting_unlock" && key && serverId && !isUnlocking) {
      setUnlockError(null);
      unlockVolume({ serverId, prfKey: key })
        .then(() => { prfKeyRef.current = null; })
        .catch((err) => {
          prfKeyRef.current = null;
          setUnlockError(err instanceof Error ? err.message : "Volume unlock failed");
        });
    }
  }, [serverStatus?.state, serverStatus?.server?.id, isUnlocking, unlockVolume]);

  // Tick elapsed time while waking
  useEffect(() => {
    if (!wakeStartedAt || (serverStatus?.state !== "hibernated" && serverStatus?.state !== "waking")) return;
    const interval = setInterval(() => setWakeElapsed(Math.floor((Date.now() - wakeStartedAt) / 1000)), 1000);
    return () => clearInterval(interval);
  }, [wakeStartedAt, serverStatus?.state]);

  // ── Resize elapsed ──

  const [resizeStartedAt, setResizeStartedAt] = useState<number | null>(null);
  const [resizeElapsed, setResizeElapsed] = useState(0);

  useEffect(() => {
    if ((serverStatus?.state === "upgrading" || serverStatus?.state === "downgrading") && !resizeStartedAt) {
      const lockTime = serverStatus.server?.tierTransitionLockedAt;
      setResizeStartedAt(lockTime ? new Date(lockTime).getTime() : Date.now());
    } else if (serverStatus?.state !== "upgrading" && serverStatus?.state !== "downgrading") {
      setResizeStartedAt(null);
      setResizeElapsed(0);
    }
  }, [serverStatus?.state, serverStatus?.server?.tierTransitionLockedAt, resizeStartedAt]);

  useEffect(() => {
    if (!resizeStartedAt) return;
    const tick = () => setResizeElapsed(Math.floor((Date.now() - resizeStartedAt) / 1000));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [resizeStartedAt]);

  // ── Status transitions ──

  useEffect(() => {
    const prev = prevStatusRef.current;
    const curr = serverStatus?.state;
    prevStatusRef.current = curr;
    if ((prev === "hibernated" || prev === "upgrading" || prev === "downgrading") && curr === "running") {
      queryClient.invalidateQueries({ queryKey: ["server-status"] });
      queryClient.invalidateQueries({ queryKey: ["server-deployment-model"] });
      queryClient.invalidateQueries({ queryKey: ["security-tier"] });
      queryClient.invalidateQueries({ queryKey: ["access-status"] });
    }
  }, [serverStatus?.state, queryClient]);

  // Track update operation transitions for completion toast
  useEffect(() => {
    const currentStep = effectiveServerStatus?.operation?.step;
    const prevStep = prevUpdateStatusRef.current;
    if (prevStep && prevStep !== "ready" && !currentStep && !effectiveServerStatus?.operation?.type) {
      toast.success(t("toasts.serverUpdated"));
    }
    prevUpdateStatusRef.current = currentStep ?? undefined;
  }, [effectiveServerStatus?.operation?.type, effectiveServerStatus?.operation?.step]);

  return {
    // Wake state
    autoWakeTriggered, setAutoWakeTriggered,
    wakeStartedAt, setWakeStartedAt,
    wakeElapsed, setWakeElapsed,
    // Encryption
    getPrfKey, isUnlocking, unlockError, setUnlockError, prfKeyRef, unlockVolume,
    // Resize state
    resizeElapsed,
  };
}
