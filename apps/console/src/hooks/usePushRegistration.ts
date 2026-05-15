// SPDX-License-Identifier: MIT
"use client";

import { useEffect, useRef } from "react";
import { isAndroidApp } from "@/lib/utils";
import { API_URL } from "@/lib/api";
import { getNotificationPrefs } from "@/hooks/useNativeNotifications";

function detectPlatform(): "ios" | "android" | "macos" | "web" {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Mac/.test(ua)) return "macos";
  return "web";
}

function getDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) {
    const match = ua.match(/;\s*([^;)]+)\s*Build/);
    return match?.[1]?.trim() || "Android Device";
  }
  if (/Mac/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux";
  return "Unknown Device";
}

export function usePushRegistration() {
  const registered = useRef(false);

  useEffect(() => {
    if (!isAndroidApp()) return;
    if (registered.current) return;

    const platform = detectPlatform();
    if (platform !== "ios" && platform !== "android") return;

    (async () => {
      try {
        const androidShield = (window as any).androidShield;
        if (!androidShield?.invokeAsync) return;

        const result = await new Promise<{ token: string }>((resolve, reject) => {
          const cbId = `cb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const callbacks = ((window as any).__shieldCallbacks = (window as any).__shieldCallbacks || {});
          callbacks[cbId] = { resolve, reject: (msg: string) => reject(new Error(msg)) };
          androidShield.invokeAsync("get_push_token", "{}", cbId);
        });

        if (!result?.token) return;

        const prefs = getNotificationPrefs();
        const res = await fetch(`${API_URL}/api/push/register`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: result.token,
            platform,
            deviceName: getDeviceName(),
            preferences: prefs,
          }),
        });

        if (res.ok) {
          registered.current = true;
        }
      } catch {
        // Push registration not available on this platform
      }
    })();
  }, []);
}
