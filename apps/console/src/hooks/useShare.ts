// SPDX-License-Identifier: MIT
"use client";

import { copyToClipboard } from "@/hooks/useClipboard";

export interface ShareContentOptions {
  text?: string;
  title?: string;
  url?: string;
}

export function canShare(): boolean {
  if (typeof window === "undefined") return false;
  return typeof navigator.share === "function";
}

export async function shareContent(
  options: ShareContentOptions
): Promise<boolean> {
  try {
    if (typeof navigator.share === "function") {
      await navigator.share({
        text: options.text,
        title: options.title,
        url: options.url,
      });
      return true;
    }

    const fallbackText = [options.text, options.url]
      .filter(Boolean)
      .join("\n");
    if (fallbackText) {
      return copyToClipboard(fallbackText);
    }

    return false;
  } catch (err: any) {
    if (err?.name === "AbortError") return false;
    console.warn("Share failed:", err);
    return false;
  }
}
