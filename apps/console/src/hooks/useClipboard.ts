// SPDX-License-Identifier: MIT
"use client";

export async function copyToClipboard(
  text: string,
  _label?: string
): Promise<boolean> {
  try {
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
