// SPDX-License-Identifier: MIT

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Detect if running inside Tauri native app
export function isTauriApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// Detect if running on a mobile Tauri target (iOS/Android)
export function isMobileTauri(): boolean {
  if (!isTauriApp()) return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod|Android/.test(ua);
}
