"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import posthog from "posthog-js";
import { ALL_LOCALES, DEFAULT_LOCALE, type Locale } from "@ellul.ai/i18n-consts";

const POSTHOG_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
// All PostHog traffic is reverse-proxied through /ingest on the same origin so
// AdBlockers don't block it; see next.config.ts rewrites.
const POSTHOG_HOST = "/ingest";

interface Props {
  surface: "web" | "docs";
}

function localeFromPath(pathname: string): Locale {
  const seg = pathname.split("/")[1] ?? "";
  if ((ALL_LOCALES as readonly string[]).includes(seg)) return seg as Locale;
  return DEFAULT_LOCALE;
}

/**
 * Cookieless PostHog client. Uses memory persistence so anonymous IDs and
 * consent state never touch the device; every page reload is a new
 * anonymous session. Pageviews are auto-captured with `surface` and `locale`
 * properties; locale changes are emitted as a separate `locale_changed` event.
 */
export function PostHogProvider({ surface }: Props) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const lastLocale = useRef<Locale | null>(null);

  // Init once.
  useEffect(() => {
    if (!POSTHOG_KEY) return;
    if (typeof window === "undefined") return;
    if (posthog.__loaded) return;

    const diag = process.env.NEXT_PUBLIC_POSTHOG_DIAG === "1";
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      // Cookieless: never write a cookie or localStorage entry. Re-identifies
      // the user on every page reload (that's the trade-off).
      persistence: "memory",
      disable_session_recording: true,
      disable_persistence: true,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: true,
      // Diag mode (used by scripts/posthog-verify.mjs) bypasses the batch
      // queue, the remote-config override, and the WebExperiments bot check
      // so every capture leaves the page synchronously and the verifier can
      // assert end-to-end.
      ...(diag
        ? {
            request_batching: false,
            advanced_disable_decide: true,
            advanced_disable_feature_flags: true,
            disable_external_dependency_loading: true,
          }
        : {}),
      // Bot detection in posthog-js auto-disables on UAs containing
      // "HeadlessChrome" / "PhantomJS" / etc. The verifier spoofs a real UA;
      // in diag mode we also opt out of the additional respect_dnt gate.
      respect_dnt: !diag,
      person_profiles: "never",
      loaded: (instance) => {
        instance.register({ surface });
        if (process.env.NODE_ENV === "development" || diag) {
          instance.debug();
        }
      },
    });
  }, [surface]);

  // Capture pageviews on every navigation, attaching the URL locale.
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
