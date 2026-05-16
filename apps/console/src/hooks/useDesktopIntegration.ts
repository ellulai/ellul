// SPDX-License-Identifier: MIT
"use client";

import { useEffect, useCallback, useRef } from "react";
import { isTauriApp } from "@/lib/utils";

type TauriEventModule = {
  emit: (event: string, payload?: unknown) => Promise<void>;
  listen: (event: string, handler: (event: { payload: string }) => void) => Promise<() => void>;
};

// Module specifier extracted to a variable so TypeScript doesn't
const TAURI_EVENT_MODULE = "@tauri-apps/api/event";

interface DesktopIntegration {
  // Update the tray menu server status label
  updateServerStatus: (status: string) => void;
  // Update the tray menu pending gates count
  updatePendingGates: (count: number) => void;
}

// Hook for desktop-specific integrations: system tray updates and global shortcut events.
export function useDesktopIntegration(
  onOpenGates?: () => void,
  onShowDashboard?: () => void,
): DesktopIntegration {
  const eventModuleRef = useRef<TauriEventModule | null>(null);
  const onOpenGatesRef = useRef(onOpenGates);
  const onShowDashboardRef = useRef(onShowDashboard);

  // Keep callback refs current without re-subscribing
  useEffect(() => {
    onOpenGatesRef.current = onOpenGates;
  }, [onOpenGates]);

  useEffect(() => {
    onShowDashboardRef.current = onShowDashboard;
  }, [onShowDashboard]);

  // Initialize Tauri event listener for global shortcuts
  useEffect(() => {
    if (!isTauriApp()) return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      try {
        const mod = await import(
          /* webpackIgnore: true */ TAURI_EVENT_MODULE
        ) as TauriEventModule;
        if (cancelled) return;
        eventModuleRef.current = mod;

        const unsub = await mod.listen("global-shortcut", (event: { payload: string }) => {
          switch (event.payload) {
            case "open_gates":
              onOpenGatesRef.current?.();
              break;
            case "show_dashboard":
              onShowDashboardRef.current?.();
              break;
          }
        });
        if (cancelled) {
          unsub();
          return;
        }
        unlisten = unsub;
      } catch (err) {
        console.warn("Failed to init desktop integration:", err);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const updateServerStatus = useCallback((status: string) => {
    if (!isTauriApp()) return;
    const mod = eventModuleRef.current;
    if (mod) {
      mod.emit("tray-update-status", status).catch(() => {});
    } else {
      // Module not loaded yet, try loading it
      (import(/* webpackIgnore: true */ TAURI_EVENT_MODULE) as Promise<TauriEventModule>)
        .then((m) => {
          eventModuleRef.current = m;
          m.emit("tray-update-status", status).catch(() => {});
        })
        .catch(() => {});
    }
  }, []);

  const updatePendingGates = useCallback((count: number) => {
    if (!isTauriApp()) return;
    const mod = eventModuleRef.current;
    if (mod) {
      mod.emit("tray-update-gates", count).catch(() => {});
    } else {
      (import(/* webpackIgnore: true */ TAURI_EVENT_MODULE) as Promise<TauriEventModule>)
        .then((m) => {
          eventModuleRef.current = m;
          m.emit("tray-update-gates", count).catch(() => {});
        })
        .catch(() => {});
    }
  }, []);

  return { updateServerStatus, updatePendingGates };
}
