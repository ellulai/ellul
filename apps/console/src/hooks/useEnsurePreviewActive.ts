// SPDX-License-Identifier: MIT
"use client";

import { useEffect, useRef } from "react";
import { useCodeToken } from "@/contexts/CodeTokenContext";
import { getCodeApiUrl } from "@/lib/domains";
import type { ApiApp, ApiPackage } from "@/contexts/AppsListContext";

// Until 2026-04-22 the GET `/api/app/:directory` handler kicked off
// `setPreviewApp()` whenever the observed health didn't match the
export function useEnsurePreviewActive(
  app: ApiApp | null,
  selectedPackage: ApiPackage | null,
  serverDomain: string,
): void {
  const { fetchWithCodeToken } = useCodeToken();
  const codeApiUrl = getCodeApiUrl(serverDomain);
  const lastPostedRef = useRef<string | null>(null);

  // Derive the preview target the same way the server used to, but
  const target: string | null = selectedPackage?.previewable
    ? selectedPackage.directory
    : app && !app.isMonorepo && app.previewable
      ? app.directory
      : null;

  useEffect(() => {
    if (!codeApiUrl || !target) return;
    if (lastPostedRef.current === target) return;
    lastPostedRef.current = target;

    fetchWithCodeToken(`${codeApiUrl}/api/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: target }),
      credentials: "include",
    }).catch((err) => {
      // Allow the next legitimate selection change (or re-navigation
      lastPostedRef.current = null;
      console.warn("[useEnsurePreviewActive] POST /api/preview failed:", err);
    });
  }, [target, codeApiUrl, fetchWithCodeToken]);
}
