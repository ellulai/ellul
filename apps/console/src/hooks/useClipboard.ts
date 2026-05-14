// SPDX-License-Identifier: MIT
"use client";

import { isTauriApp } from "@/lib/utils";

type TauriCoreModule = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

// Module specifier extracted to bypass TypeScript's static import resolution.
const TAURI_CORE_MODULE = "@tauri-apps/api/core";

// Copy text to the clipboard.
export async function copyToClipboard(
  text: string,
  label?: string
): Promise<boolean> {
  try {
    if (isTauriApp()) {
      const { invoke } = await import(
        /* webpackIgnore: true */ TAURI_CORE_MODULE
      ) as TauriCoreModule;
      await invoke("plugin:native-auth|copy_to_clipboard", { text, label });
      return true;
    }

    // Web fallback
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }

    return false;
  } catch (err) {
    console.warn("Clipboard copy failed:", err);
    return false;
  }
}
