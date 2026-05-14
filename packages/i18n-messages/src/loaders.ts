// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type { Locale } from "@ellul.ai/i18n-consts";

export type MessageTree = Record<string, unknown>;
export type MessageLoader = () => Promise<MessageTree>;

/**
 * Locales whose translation files have shipped. Locales not in this set
 * fall back to the canonical English tree at runtime — the locale is
 * still tagged correctly via `<html lang>` and metadata, but the body
 * content reads English until a translation is added.
 *
 * To ship a new locale: drop `messages/<locale>/{*.json,index.ts}` into
 * place, add the locale loader to the map below, then add the locale
 * code to this set.
 */
export const SHIPPED_LOCALES: ReadonlySet<Locale> = new Set<Locale>([
  "en",
  "ja",
]);

/**
 * Per-locale loader map. Webpack reads the static imports inside each
 * factory and bundles only those locales — so unshipped locales reuse
 * the EN bundle (zero duplicate JSON in the build).
 *
 * Apps consume this via `@ellul.ai/i18n/request`'s `loadMessages` option
 * or by calling `loadMessages(locale)` directly. Apps do NOT redeclare
 * this map.
 */
export const messageLoaders: Record<Locale, MessageLoader> = {
  en: async () => (await import("../messages/en")).default,
  ja: async () => (await import("../messages/ja")).default,
  ko: async () => (await import("../messages/en")).default,
  de: async () => (await import("../messages/en")).default,
  "pt-BR": async () => (await import("../messages/en")).default,
  fr: async () => (await import("../messages/en")).default,
};

export function loadMessages(locale: Locale): Promise<MessageTree> {
  return messageLoaders[locale]();
}

export function isShippedLocale(locale: Locale): boolean {
  return SHIPPED_LOCALES.has(locale);
}
