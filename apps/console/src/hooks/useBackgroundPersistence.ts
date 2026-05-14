// SPDX-License-Identifier: MIT
"use client";

import { useEffect, useRef, useCallback } from "react";
import { isTauriApp } from "@/lib/utils";

type TauriWindowModule = {
  getCurrentWindow: () => {
    listen: (event: string, handler: () => void) => Promise<() => void>;
    show: () => Promise<void>;
    setFocus: () => Promise<void>;
  };
};

// Module specifier extracted to bypass TypeScript's static import resolution.
const TAURI_WINDOW_MODULE = "@tauri-apps/api/window";

// desktop app, Tauri webviews don't throttle like browser tabs, so connections

export function useBackgroundPersistence() {
  const tauriEventUnlisteners = useRef<Array<() => void>>([]);

  // Listen for Tauri focus events to trigger reconnect after sleep/wake
  useEffect(() => {
    if (!isTauriApp()) return;

    let mounted = true;

    const setupTauriListeners = async () => {
      try {
        const { getCurrentWindow } = await import(
          /* webpackIgnore: true */ TAURI_WINDOW_MODULE
        ) as TauriWindowModule;
        const appWindow = getCurrentWindow();

        // On focus: dispatch a synthetic visibilitychange so existing reconnect
        const focusUnlisten = await appWindow.listen("tauri://focus", () => {
          if (document.visibilityState === "visible") {
            document.dispatchEvent(new Event("visibilitychange"));
          }
        });

        if (mounted) {
          tauriEventUnlisteners.current.push(focusUnlisten);
        } else {
          focusUnlisten();
        }
      } catch (err) {
        console.warn("[BackgroundPersistence] Failed to setup Tauri listeners:", err);
      }
    };

    setupTauriListeners();

    return () => {
      mounted = false;
      for (const unlisten of tauriEventUnlisteners.current) {
        unlisten();
      }
      tauriEventUnlisteners.current = [];
    };
  }, []);

  // Public API: allow showing the window (e.g., from a tray click handler)
  const showWindow = useCallback(async () => {
    if (!isTauriApp()) return;
    try {
      const { getCurrentWindow } = await import(
        /* webpackIgnore: true */ TAURI_WINDOW_MODULE
      ) as TauriWindowModule;
      const appWindow = getCurrentWindow();
      await appWindow.show();
      await appWindow.setFocus();
    } catch (err) {
      console.warn("[BackgroundPersistence] Failed to show window:", err);
    }
  }, []);

  return { showWindow };
}
