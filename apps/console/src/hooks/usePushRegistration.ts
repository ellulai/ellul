// SPDX-License-Identifier: MIT
"use client";

import { useEffect, useRef } from "react";
import { isTauriApp } from "@/lib/utils";
import { API_URL } from "@/lib/api";
import { getNotificationPrefs } from "@/hooks/useNativeNotifications";

type TauriCoreModule = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

// Module specifier extracted to bypass TypeScript's static import resolution.
const TAURI_CORE_MODULE = "@tauri-apps/api/core";

// Detect the current platform for push token registration.
function detectPlatform(): "ios" | "android" | "macos" | "web" {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Mac/.test(ua)) return "macos";
  return "web";
}

// Get a user-friendly device name from the user agent.
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

// Register the device's push token with the API on app open.
export function usePushRegistration() {
  const registered = useRef(false);

  useEffect(() => {
    if (!isTauriApp()) return;
    if (registered.current) return;

    const platform = detectPlatform();

    // Remote push is only for mobile platforms where the app can be killed
    if (platform !== "ios" && platform !== "android") return;

    (async () => {
      try {
        // Get device token via our native-auth Tauri plugin
        const { invoke } = await import(
          /* webpackIgnore: true */ TAURI_CORE_MODULE
        ) as TauriCoreModule;

        const result = await invoke("plugin:native-auth|register_push") as { token: string };

        if (!result?.token) {
          console.warn("Push registration: no device token returned");
          return;
        }

        // Register with our API
        const prefs = getNotificationPrefs();
        const res = await fetch(`${API_URL}/api/push/register`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: result.token,
            platform,
            deviceName: getDeviceName(),
            bundleId: platform === "ios" ? "ai.ellul.app" : undefined,
            preferences: prefs,
          }),
        });

        if (res.ok) {
          registered.current = true;
          console.log("Push token registered successfully");
        } else {
          console.warn("Push token registration failed:", res.status);
        }
      } catch (err) {
        // Expected on desktop — push not available
        console.debug("Push registration not available:", err);
      }
    })();
  }, []);
}
