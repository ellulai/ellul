/**
 * Search Console / webmaster verification tokens for the docs surface,
 * keyed per request locale.
 *
 * Mirrors apps/web/src/lib/search-console-verification.ts. Both surfaces
 * read the same env-var slots so a single Google domain-property
 * verification per locale covers ellul.ai + docs.ellul.ai. See that file
 * (and docs/seo/SEARCH-CONSOLE-PER-LOCALE.md) for env-var documentation.
 */

import type { Locale } from "@ellul.ai/i18n-consts";

export interface SearchConsoleVerification {
  google?: string;
  other: Record<string, string>;
}

const PER_LOCALE_ENV_KEY: Record<Locale, string> = {
  en: "NEXT_PUBLIC_SEARCH_CONSOLE_EN",
  ja: "NEXT_PUBLIC_SEARCH_CONSOLE_JA",
  ko: "NEXT_PUBLIC_SEARCH_CONSOLE_KO",
  de: "NEXT_PUBLIC_SEARCH_CONSOLE_DE",
  "pt-BR": "NEXT_PUBLIC_SEARCH_CONSOLE_PT_BR",
  fr: "NEXT_PUBLIC_SEARCH_CONSOLE_FR",
};

export function searchConsoleVerification(
  locale: Locale,
): SearchConsoleVerification {
  const google = process.env[PER_LOCALE_ENV_KEY[locale]];
  const bing = process.env.NEXT_PUBLIC_BING_SITE_VERIFICATION;
  const naver = process.env.NEXT_PUBLIC_NAVER_VERIFICATION;
  const yandex = process.env.NEXT_PUBLIC_YANDEX_SITE_VERIFICATION;

  const other: Record<string, string> = {};
  if (bing) other["msvalidate.01"] = bing;
  if (naver && locale === "ko") other["naver-site-verification"] = naver;
  if (yandex) other["yandex-verification"] = yandex;

  return {
    ...(google ? { google } : {}),
    other,
  };
}
