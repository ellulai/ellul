/**
 * Search Console / webmaster verification tokens, keyed per request locale.
 *
 * Search Console properties are added per-locale-prefix once that locale's
 * translations actually ship (`isIndexableLocale("web", locale)` is true).
 * Each property gets its own meta-tag verification token, so the runtime
 * needs to emit the token matching the current request's locale only —
 * mixing them across locales would cause Search Console to fail
 * verification on the wrong property.
 *
 * Env vars (all optional; per-locale tokens unset until that locale ships):
 *   NEXT_PUBLIC_SEARCH_CONSOLE_EN     : Google Search Console (en)
 *   NEXT_PUBLIC_SEARCH_CONSOLE_JA     : Google Search Console (ja)
 *   NEXT_PUBLIC_SEARCH_CONSOLE_KO     : Google Search Console (ko)
 *   NEXT_PUBLIC_SEARCH_CONSOLE_DE     : Google Search Console (de)
 *   NEXT_PUBLIC_SEARCH_CONSOLE_PT_BR  : Google Search Console (pt-BR)
 *   NEXT_PUBLIC_SEARCH_CONSOLE_FR     : Google Search Console (fr)
 *   NEXT_PUBLIC_BING_SITE_VERIFICATION  : Bing Webmaster Tools (locale-agnostic)
 *   NEXT_PUBLIC_NAVER_VERIFICATION      : Naver Webmaster (only emits on /ko/)
 *   NEXT_PUBLIC_YANDEX_SITE_VERIFICATION: Yandex Webmaster (locale-agnostic)
 *
 * Operator workflow per locale: see docs/seo/SEARCH-CONSOLE-PER-LOCALE.md.
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
  // Naver Search Advisor only cares about the Korean property — no point
  // emitting the meta tag on /en/ or /ja/ where it can never verify.
  if (naver && locale === "ko") other["naver-site-verification"] = naver;
  if (yandex) other["yandex-verification"] = yandex;

  return {
    ...(google ? { google } : {}),
    other,
  };
}
