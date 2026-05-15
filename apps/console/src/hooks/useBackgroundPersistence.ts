// SPDX-License-Identifier: MIT
"use client";

import { useEffect, useRef, useCallback } from "react";
import { isElectronApp } from "@/lib/utils";

export function useBackgroundPersistence() {
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!isElectronApp()) return;

    const electronShield = (window as any).electronShield;
    if (!electronShield?.onSessionExpired) return;

    const unsubscribe = electronShield.onSessionExpired(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    cleanupRef.current = unsubscribe;

    return () => {
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }
    };
  }, []);

  const showWindow = useCallback(async () => {
    // Electron windows are managed by the main process via tray/shortcuts.
    // Android WebView is always visible. No-op from renderer.
  }, []);

  return { showWindow };
}
