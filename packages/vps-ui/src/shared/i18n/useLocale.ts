// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { useEffect, useState } from "react";
import { ALL_LOCALES, DEFAULT_LOCALE, isLocale, type Locale } from "@ellul.ai/i18n-consts";
import { isOriginTrusted } from "../security";

export interface LocaleResolution {
  locale: Locale;
  injectionMissing: boolean;
}

export function useLocaleResolution(): LocaleResolution {
  const [resolved, setResolved] = useState<LocaleResolution>(resolveInitialLocale);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isOriginTrusted(event.origin)) return;
      const data = event.data as { type?: string; locale?: string } | null;
      if (!data || data.type !== "set_locale") return;
      if (!isLocale(data.locale)) return;
      setResolved((prev) => ({ ...prev, locale: data.locale as Locale }));
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return resolved;
}

export function useLocale(): Locale {
  return useLocaleResolution().locale;
}

function resolveInitialLocale(): LocaleResolution {
  if (typeof window === "undefined") {
    return { locale: DEFAULT_LOCALE, injectionMissing: false };
  }

  const injected = window.__SHIELD_SETTINGS__?.locale;
  if (isLocale(injected)) {
    return { locale: injected, injectionMissing: false };
  }

  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn("[i18n] __SHIELD_SETTINGS__.locale missing in dev — using DEFAULT_LOCALE");
    return { locale: DEFAULT_LOCALE, injectionMissing: false };
  }

  // eslint-disable-next-line no-console
  console.error("[i18n] __SHIELD_SETTINGS__.locale missing in production");
  return { locale: DEFAULT_LOCALE, injectionMissing: true };
}

export const SUPPORTED_LOCALES: readonly Locale[] = ALL_LOCALES;
