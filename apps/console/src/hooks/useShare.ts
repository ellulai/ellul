// SPDX-License-Identifier: MIT
"use client";

import { isTauriApp, isMobileTauri } from "@/lib/utils";
import { copyToClipboard } from "@/hooks/useClipboard";

type TauriCoreModule = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

// Module specifier extracted to bypass TypeScript's static import resolution.
const TAURI_CORE_MODULE = "@tauri-apps/api/core";

export interface ShareContentOptions {
  text?: string;
  title?: string;
  url?: string;
}

// Check whether sharing is available on this platform.
export function canShare(): boolean {
  if (typeof window === "undefined") return false;
  if (isMobileTauri()) return true;
  return typeof navigator.share === "function";
}

// Share content via the native share sheet or Web Share API.
export async function shareContent(
  options: ShareContentOptions
): Promise<boolean> {
  try {
    // Mobile Tauri: use native share sheet
    if (isMobileTauri()) {
      const { invoke } = await import(
        /* webpackIgnore: true */ TAURI_CORE_MODULE
      ) as TauriCoreModule;
      await invoke("plugin:native-auth|share", {
        text: options.text,
        title: options.title,
        url: options.url,
      });
      return true;
    }

    // Desktop Tauri: no share sheet available
    if (isTauriApp()) {
      return false;
    }

    // Web: try navigator.share, fall back to clipboard
    if (typeof navigator.share === "function") {
      await navigator.share({
        text: options.text,
        title: options.title,
        url: options.url,
      });
      return true;
    }

    // Fallback: copy to clipboard
    const fallbackText = [options.text, options.url]
      .filter(Boolean)
      .join("\n");
    if (fallbackText) {
      return copyToClipboard(fallbackText);
    }

    return false;
  } catch (err: any) {
    // navigator.share throws AbortError if user cancels -- not a failure
    if (err?.name === "AbortError") return false;
    console.warn("Share failed:", err);
    return false;
  }
}
