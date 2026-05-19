// SPDX-License-Identifier: MIT

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Detect if running inside Tauri native app
export function isTauriApp(): boolean {
  if (typeof window === "undefined") return false;
  if ("__TAURI_INTERNALS__" in window) return true;
  return !!(window as any).__IS_ELLUL_TAURI__;
}

// Detect if running on a mobile Tauri target (iOS/Android)
export function isMobileTauri(): boolean {
  if (!isTauriApp()) return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod|Android/.test(ua);
}
