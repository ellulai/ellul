// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

"use client";

import { useCallback } from "react";
import { useLocale } from "next-intl";
import { writeLocaleCookie } from "@ellul.ai/i18n/cookie";
import { isLocale, type Locale } from "@ellul.ai/i18n-consts";
import { useRouter } from "@/i18n/routing";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

type Router = ReturnType<typeof useRouter>;
type SessionUser = { preferredLocale?: string | null } | null | undefined;

export type RedirectDecision =
  | { kind: "url"; locale: Locale; persist: boolean }
  | { kind: "db"; locale: Locale }
  | { kind: "default" };

/**
 * Pure decision function — exposed so it can be unit-tested without
 * mocking React, next-intl, or fetch. The hook below wires it up.
 *
 * Rules:
 *   1. URL has an EXPLICIT locale prefix (e.g. `/ja/sign-up`) → URL wins.
 *      Persist to DB when it differs (user is making an explicit choice).
 *   2. URL has NO explicit prefix (default route, e.g. `/sign-up`) →
 *      saved DB preference wins. Do NOT persist (it would silently overwrite
 *      a preference the user set on a prior visit).
 *   3. No URL locale, no DB preference → middleware default routing.
 */
export function decideLocaleRedirect(args: {
  urlLocale: string;
  hasExplicitLocaleInPath: boolean;
  user: SessionUser;
}): RedirectDecision {
  const { urlLocale, hasExplicitLocaleInPath, user } = args;
  const dbPref = user?.preferredLocale;
  const dbPrefValid = typeof dbPref === "string" && isLocale(dbPref);

  if (hasExplicitLocaleInPath && isLocale(urlLocale)) {
    return {
      kind: "url",
      locale: urlLocale,
      persist: !dbPrefValid || dbPref !== urlLocale,
    };
  }

  if (dbPrefValid) {
    return { kind: "db", locale: dbPref as Locale };
  }

  return { kind: "default" };
}

/**
 * Server-side enforcement (apps/api/src/routes/me.ts):
 *   - auth required (401 on unauthenticated PATCH)
 *   - input validated against ALL_LOCALES whitelist
 *   - audit-logged with userId / previous / next / IP / user-agent
 *   - rate-limited via /api/me/* limiter
 */
async function persistPreferredLocale(locale: Locale): Promise<void> {
  await fetch(`${API_URL}/api/me/preferences`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preferredLocale: locale }),
  });
}

function pathHasExplicitLocale(locale: string): boolean {
  if (typeof window === "undefined") return false;
  const path = window.location.pathname;
  return path === `/${locale}` || path.startsWith(`/${locale}/`);
}

/**
 * Stable post-auth redirect callback. URL locale is authoritative when the
 * pathname carries an explicit prefix; otherwise the saved preference wins.
 * Cookie is kept in sync with whichever locale we route to.
 */
export function useLocaleAwareRedirect(): (path: string, user: SessionUser) => void {
  const router: Router = useRouter();
  const urlLocale = useLocale();

  return useCallback(
    (path: string, user: SessionUser) => {
      const decision = decideLocaleRedirect({
        urlLocale,
        hasExplicitLocaleInPath: pathHasExplicitLocale(urlLocale),
        user,
      });

      if (decision.kind === "url") {
        writeLocaleCookie(decision.locale);
        if (decision.persist) {
          // Fire-and-forget: a transient API failure must not block the
          // user. The next auth flow naturally retries the persist.
          persistPreferredLocale(decision.locale).catch(() => {});
        }
        router.replace(path, { locale: decision.locale as never });
        return;
      }

      if (decision.kind === "db") {
        writeLocaleCookie(decision.locale);
        router.replace(path, { locale: decision.locale as never });
        return;
      }

      router.replace(path);
    },
    [router, urlLocale],
  );
}
