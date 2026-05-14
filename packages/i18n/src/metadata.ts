// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { ALL_LOCALES, DEFAULT_LOCALE, type Locale } from "@ellul.ai/i18n-consts";

export interface HreflangAlternatesOptions {
  baseUrl: string;
  pathname: string;
  localePrefix?: "always" | "as-needed" | "never";
}

export function buildHreflangAlternates(
  opts: HreflangAlternatesOptions,
): { canonical: string; languages: Record<string, string> } {
  const { baseUrl, pathname, localePrefix = "as-needed" } = opts;
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const cleanPath = pathname.startsWith("/") ? pathname : `/${pathname}`;

  const localeUrl = (locale: Locale): string => {
    const isDefault = locale === DEFAULT_LOCALE;
    if (localePrefix === "always" || (localePrefix === "as-needed" && !isDefault)) {
      return `${trimmedBase}/${locale}${cleanPath === "/" ? "" : cleanPath}`;
    }
    return `${trimmedBase}${cleanPath}`;
  };

  const languages: Record<string, string> = {};
  for (const locale of ALL_LOCALES) languages[locale] = localeUrl(locale);
  languages["x-default"] = localeUrl(DEFAULT_LOCALE);

  return { canonical: localeUrl(DEFAULT_LOCALE), languages };
}
