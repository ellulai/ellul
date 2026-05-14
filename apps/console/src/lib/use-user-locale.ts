// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale as useUrlLocale } from "next-intl";
import type { Locale } from "@ellul.ai/i18n-consts";
import { authClient, type Session } from "@/lib/auth-client";

const SESSION_QUERY_KEY = ["auth", "session"] as const;

/**
 * Returns the **user-identity** locale (api DB authoritative) for callers
 * that need to honor the user's preferred-locale rather than the URL-driven
 * console nav locale.
 *
 * Use this for:
 *   - VPS iframe `?locale=` query (so chat / code-browser render in the
 *     user's pref, not whatever URL space they happened to navigate to)
 *   - any component that needs "what language does this user want" rather
 *     than "what page is currently in view"
 *
 * Reads from the better-auth session cache that `usePreferredLocale` writes
 * to optimistically — so a locale toggle propagates here within the same
 * frame as the picker's mutation. Falls back to the URL locale only during
 * the initial render before `getSession()` resolves (rare and brief).
 */
export function useUserLocale(): Locale {
  const urlLocale = useUrlLocale() as Locale;

  const { data } = useQuery<Session | null>({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async () => {
      const result = await authClient.getSession();
      return result.data ?? null;
    },
    // better-auth's cookie cache holds for 5 minutes; mirror that here so
    // a stale-time refetch isn't triggered on every component mount.
    staleTime: 5 * 60_000,
  });

  const fromPref = (data?.user as { preferredLocale?: string | null } | undefined)
    ?.preferredLocale as Locale | undefined;
  return fromPref ?? urlLocale;
}
