// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

"use client";

import { useEffect, useRef } from "react";
import { useLocale } from "next-intl";
import type { Locale } from "@ellul.ai/i18n-consts";
import { isLocale } from "@ellul.ai/i18n-consts";
import type { Session } from "@/lib/auth-client";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

/**
 * Syncs the URL locale to the user's DB preference when they differ.
 *
 * Without this, a user browsing at `/ja/dashboard` (via browser detection
 * or bookmark) can have `preferredLocale: "en"` in the DB. Provisioning,
 * VPS iframe embedding, and agent-context scaffolding all read the DB
 * value — so the VPS ends up English even though the console looks Japanese.
 *
 * Fire-and-forget PATCH on first mismatch per session load. No UI side
 * effects — the console is already rendering the correct locale.
 */
export function useLocaleSync(session: Session | null): void {
  const urlLocale = useLocale() as Locale;
  const syncedRef = useRef(false);

  useEffect(() => {
    if (!session || syncedRef.current) return;

    const dbLocale = (session.user as { preferredLocale?: string } | undefined)
      ?.preferredLocale as Locale | undefined;

    if (!dbLocale || dbLocale === urlLocale || !isLocale(urlLocale)) return;

    syncedRef.current = true;

    fetch(`${API_URL}/api/me/preferences`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferredLocale: urlLocale }),
    }).catch(() => {});
  }, [session, urlLocale]);
}
