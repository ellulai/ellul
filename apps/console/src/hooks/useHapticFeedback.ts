// SPDX-License-Identifier: MIT
"use client";

import { useCallback } from "react";
import { isAndroidApp } from "@/lib/utils";

export type HapticIntensity = "light" | "medium" | "heavy";

const HAPTIC_STORAGE_KEY = "ellul_haptic_enabled";

function isHapticEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const stored = localStorage.getItem(HAPTIC_STORAGE_KEY);
    if (stored === null) return true;
    return stored === "true";
  } catch {
    return true;
  }
}

export function setHapticEnabled(enabled: boolean): void {
  localStorage.setItem(HAPTIC_STORAGE_KEY, String(enabled));
}

export function useHapticFeedback() {
  const triggerHaptic = useCallback(async (intensity: HapticIntensity) => {
    if (!isAndroidApp()) return;
    if (!isHapticEnabled()) return;

    try {
      if ("vibrate" in navigator) {
        const duration = intensity === "heavy" ? 50 : intensity === "medium" ? 30 : 10;
        navigator.vibrate(duration);
      }
    } catch {
      // Haptic feedback is non-critical
    }
  }, []);

  return { triggerHaptic };
}
