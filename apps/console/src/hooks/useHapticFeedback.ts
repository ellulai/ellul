// SPDX-License-Identifier: MIT
"use client";

import { useCallback } from "react";
import { isTauriApp } from "@/lib/utils";

type TauriCoreModule = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

// Module specifier extracted to bypass TypeScript's static import resolution.
const TAURI_CORE_MODULE = "@tauri-apps/api/core";

export type HapticIntensity = "light" | "medium" | "heavy";

const HAPTIC_STORAGE_KEY = "ellul_haptic_enabled";

function isHapticEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const stored = localStorage.getItem(HAPTIC_STORAGE_KEY);
    if (stored === null) return true; // default: enabled
    return stored === "true";
  } catch {
    return true;
  }
}

export function setHapticEnabled(enabled: boolean): void {
  localStorage.setItem(HAPTIC_STORAGE_KEY, String(enabled));
}

function isMobilePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

let cachedInvoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;

// Hook that provides haptic feedback on mobile devices.
export function useHapticFeedback() {
  const triggerHaptic = useCallback(async (intensity: HapticIntensity) => {
    // Only fire on Tauri mobile
    if (!isTauriApp() || !isMobilePlatform()) return;

    // Respect user preference
    if (!isHapticEnabled()) return;

    try {
      if (!cachedInvoke) {
        const { invoke } = await import(
          /* webpackIgnore: true */ TAURI_CORE_MODULE
        ) as TauriCoreModule;
        cachedInvoke = invoke;
      }
      await cachedInvoke!("plugin:native-auth|haptic_feedback", { intensity });
    } catch (err) {
      // Silently fail — haptic feedback is non-critical
      console.debug("Haptic feedback unavailable:", err);
    }
  }, []);

  return { triggerHaptic };
}
