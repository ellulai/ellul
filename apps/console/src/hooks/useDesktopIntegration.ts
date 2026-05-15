// SPDX-License-Identifier: MIT
"use client";

import { useEffect, useCallback, useRef } from "react";
import { isElectronApp } from "@/lib/utils";

interface DesktopIntegration {
  updateServerStatus: (status: string) => void;
  updatePendingGates: (count: number) => void;
}

export function useDesktopIntegration(
  onOpenGates?: () => void,
  onShowDashboard?: () => void,
): DesktopIntegration {
  const onOpenGatesRef = useRef(onOpenGates);
  const onShowDashboardRef = useRef(onShowDashboard);

  useEffect(() => {
    onOpenGatesRef.current = onOpenGates;
  }, [onOpenGates]);

  useEffect(() => {
    onShowDashboardRef.current = onShowDashboard;
  }, [onShowDashboard]);

  useEffect(() => {
    if (!isElectronApp()) return;

    const electronShield = (window as any).electronShield;
    if (!electronShield?.onGlobalShortcut) return;

    const unsubscribe = electronShield.onGlobalShortcut((action: string) => {
      switch (action) {
        case "open_gates":
          onOpenGatesRef.current?.();
          break;
        case "show_dashboard":
          onShowDashboardRef.current?.();
          break;
      }
    });

    return unsubscribe;
  }, []);

  const updateServerStatus = useCallback((status: string) => {
    if (!isElectronApp()) return;
    (window as any).electronShield?.updateTrayStatus?.(status);
  }, []);

  const updatePendingGates = useCallback((count: number) => {
    if (!isElectronApp()) return;
    (window as any).electronShield?.updateTrayGates?.(count);
  }, []);

  return { updateServerStatus, updatePendingGates };
}
