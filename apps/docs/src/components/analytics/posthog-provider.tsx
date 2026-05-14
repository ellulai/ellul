"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import posthog from "posthog-js";
import { ALL_LOCALES, DEFAULT_LOCALE, type Locale } from "@ellul.ai/i18n-consts";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
// Docs ships as a static export so rewrites aren't available — we hit
// PostHog directly. Same-origin proxying lives in apps/web only. Override
// via NEXT_PUBLIC_POSTHOG_HOST if you front it with a CDN.
const POSTHOG_HOST = process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com";

interface Props {
  surface: "web" | "docs";
}

function localeFromPath(pathname: string): Locale {
  const seg = pathname.split("/")[1] ?? "";
  if ((ALL_LOCALES as readonly string[]).includes(seg)) return seg as Locale;
  return DEFAULT_LOCALE;
}

/**
 * Cookieless PostHog client for docs. Mirrors the web provider — see
 * apps/web/src/components/analytics/posthog-provider.tsx for design notes.
 */
export function PostHogProvider({ surface }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const lastLocale = useRef<Locale | null>(null);

  useEffect(() => {
    if (!POSTHOG_KEY) return;
    if (typeof window === "undefined") return;
    if (posthog.__loaded) return;

    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      persistence: "memory",
      disable_session_recording: true,
      disable_persistence: true,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: true,
      respect_dnt: true,
      person_profiles: "never",
      loaded: (instance) => {
        instance.register({ surface });
        if (process.env.NODE_ENV === "development") {
          instance.debug();
        }
      },
    });
  }, [surface]);

  useEffect(() => {
    if (!POSTHOG_KEY) return;
    if (typeof window === "undefined") return;
    if (!pathname) return;

    const locale = localeFromPath(pathname);
    const url = pathname + (searchParams?.toString() ? `?${searchParams}` : "");
    posthog.capture("$pageview", {
      $current_url: window.location.origin + url,
      surface,
      locale,
    });

    if (lastLocale.current && lastLocale.current !== locale) {
      posthog.capture("locale_changed", {
        from: lastLocale.current,
        to: locale,
        surface,
      });
    }
    lastLocale.current = locale;
  }, [pathname, searchParams, surface]);

  return null;
}
