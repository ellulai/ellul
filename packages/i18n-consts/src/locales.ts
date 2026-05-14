// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

export const ALL_LOCALES = [
  "en",
  "ja",
  "ko",
  "de",
  "pt-BR",
  "fr",
] as const;

export type Locale = (typeof ALL_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALES_TO_TRANSLATE: readonly Locale[] = ALL_LOCALES.filter(
  (l) => l !== DEFAULT_LOCALE,
);

export const RTL_LOCALES: ReadonlySet<string> = new Set(["ar", "he"]);

export function isRtlLocale(locale: string): boolean {
  return RTL_LOCALES.has(locale);
}

export interface LocaleDisplayInfo {
  name: string;
  nativeName: string;
  flag: string;
}

export const LOCALE_DISPLAY: Record<Locale, LocaleDisplayInfo> = {
  en: { name: "English", nativeName: "English", flag: "🇺🇸" },
  ja: { name: "Japanese", nativeName: "日本語", flag: "🇯🇵" },
  ko: { name: "Korean", nativeName: "한국어", flag: "🇰🇷" },
  de: { name: "German", nativeName: "Deutsch", flag: "🇩🇪" },
  "pt-BR": { name: "Portuguese (Brazil)", nativeName: "Português", flag: "🇧🇷" },
  fr: { name: "French", nativeName: "Français", flag: "🇫🇷" },
};

export const OG_LOCALE: Record<Locale, string> = {
  en: "en_US",
  ja: "ja_JP",
  ko: "ko_KR",
  de: "de_DE",
  "pt-BR": "pt_BR",
  fr: "fr_FR",
};

/**
 * glibc locale names — the system-locale string apt's `locales` package
 * generates and `/etc/environment` consumes for `LANG` / `LC_ALL`.
 *
 * Single source of truth for both the provisioning shell (locale.sh) and
 * the runtime enforcer reconciler. The bash case statements that consume
 * these are emitted from this map by
 * `@ellul.ai/i18n-messages/shell-strings#buildLocaleToGlibcCase()`, so
 * adding a locale here propagates automatically.
 */
export const GLIBC_LOCALE: Record<Locale, string> = {
  en: "en_US.UTF-8",
  ja: "ja_JP.UTF-8",
  ko: "ko_KR.UTF-8",
  de: "de_DE.UTF-8",
  "pt-BR": "pt_BR.UTF-8",
  fr: "fr_FR.UTF-8",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (ALL_LOCALES as readonly string[]).includes(value);
}

export function coerceLocale(value: unknown, fallback: Locale = DEFAULT_LOCALE): Locale {
  return isLocale(value) ? value : fallback;
}
