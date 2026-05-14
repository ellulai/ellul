// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { API_URL } from "@/lib/api";

export interface SessionInfo {
  remainingMs: number;
  warningActive: boolean;
  softCapHit: boolean;
  graceRemainingMs: number | null;
  canRenew: boolean;
  renewalsRemaining: number;
  expired: boolean;
}

interface HeartbeatState {
  sessionInfo: SessionInfo | null;
  isHeartbeating: boolean;
  error: string | null;
}

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
const ACTIVITY_THRESHOLD_MS = 30_000; // 30s of no activity = inactive

// Browser heartbeat hook for Shield Gateway anti-squatting.
export function useBrowserHeartbeat(
  serverId: string | null,
  tier: string | undefined
): HeartbeatState & { forceRefresh: () => void } {
  const [state, setState] = useState<HeartbeatState>({
    sessionInfo: null,
    isHeartbeating: false,
    error: null,
  });

  const sessionKeyRef = useRef<string | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const isVisibleRef = useRef<boolean>(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Track user activity
  useEffect(() => {
    const onActivity = () => {
      lastActivityRef.current = Date.now();
    };

    window.addEventListener("mousemove", onActivity, { passive: true });
    window.addEventListener("keydown", onActivity, { passive: true });
    window.addEventListener("click", onActivity, { passive: true });
    window.addEventListener("touchstart", onActivity, { passive: true });
    window.addEventListener("scroll", onActivity, { passive: true });

    return () => {
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("click", onActivity);
      window.removeEventListener("touchstart", onActivity);
      window.removeEventListener("scroll", onActivity);
    };
  }, []);

  // Track tab visibility
  useEffect(() => {
    const onVisibility = () => {
      isVisibleRef.current = document.visibilityState === "visible";
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // HMAC-SHA256 signing using Web Crypto API
  const signNonce = useCallback(async (key: string, nonce: string): Promise<string> => {
    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      encoder.encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(nonce));
    return Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }, []);

  // Heartbeat cycle
  const sendHeartbeat = useCallback(async () => {
    if (!serverId) return;

    // Skip if tab hidden or user inactive
    if (!isVisibleRef.current) return;
    if (Date.now() - lastActivityRef.current > ACTIVITY_THRESHOLD_MS) return;

    try {
      // 1. Get challenge
      const challengeRes = await fetch(
        `${API_URL}/api/servers/${serverId}/heartbeat-challenge`,
        { credentials: "include" }
      );

      if (!challengeRes.ok) {
        if (challengeRes.status === 401) {
          setState((prev) => ({ ...prev, error: "Session expired" }));
          return;
        }
        return;
      }

      const challenge = await challengeRes.json() as {
        nonce: string;
        sessionKey: string;
        session: {
          remainingMs: number;
          warningActive: boolean;
          softCapHit: boolean;
          graceRemainingMs: number | null;
          renewalsRemaining: number;
        };
      };

      // Cache session key
      sessionKeyRef.current = challenge.sessionKey;

      // 2. Sign nonce
      const signature = await signNonce(challenge.sessionKey, challenge.nonce);

      // 3. Send heartbeat
      const heartbeatRes = await fetch(
        `${API_URL}/api/servers/${serverId}/browser-heartbeat`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nonce: challenge.nonce,
            signature,
            viewport: {
              width: window.innerWidth,
              height: window.innerHeight,
            },
            hasFocus: document.hasFocus(),
          }),
        }
      );

      if (heartbeatRes.status === 403) {
        const errorData = await heartbeatRes.json() as {
          code?: string;
          canRenew?: boolean;
        };
        if (errorData.code === "SESSION_EXPIRED") {
          setState({
            sessionInfo: {
              remainingMs: 0,
              warningActive: true,
              softCapHit: true,
              graceRemainingMs: 0,
              canRenew: errorData.canRenew ?? false,
              renewalsRemaining: 0,
              expired: true,
            },
            isHeartbeating: false,
            error: null,
          });
          return;
        }
      }

      if (heartbeatRes.status === 400) {
        // Invalid signature — session key may have rotated, re-fetch on next cycle
        sessionKeyRef.current = null;
        return;
      }

      if (heartbeatRes.ok) {
        const result = await heartbeatRes.json() as {
          session: {
            remainingMs: number;
            warningActive: boolean;
            softCapHit: boolean;
            graceRemainingMs: number | null;
            canRenew: boolean;
          };
        };

        setState({
          sessionInfo: {
            ...result.session,
            renewalsRemaining: challenge.session.renewalsRemaining,
            expired: false,
          },
          isHeartbeating: true,
          error: null,
        });
      }
    } catch {
      // Network error — retry next cycle
      setState((prev) => ({ ...prev, error: "Network error" }));
    }
  }, [serverId, signNonce]);

  // Start/stop heartbeat loop
  useEffect(() => {
    if (!serverId || tier !== "shield_proxy") {
      setState({ sessionInfo: null, isHeartbeating: false, error: null });
      return;
    }

    // Send first heartbeat immediately
    sendHeartbeat();

    // Set up interval
    intervalRef.current = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [serverId, tier, sendHeartbeat]);

  const forceRefresh = useCallback(() => {
    // Optimistically clear softCapHit so the modal closes immediately
    setState((prev) => prev.sessionInfo
      ? { ...prev, sessionInfo: { ...prev.sessionInfo, softCapHit: false, graceRemainingMs: null } }
      : prev
    );
    sendHeartbeat();
  }, [sendHeartbeat]);

  return { ...state, forceRefresh };
}
