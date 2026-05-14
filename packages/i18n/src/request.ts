// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { getRequestConfig } from "next-intl/server";
import type { Locale } from "@ellul.ai/i18n-consts";
import { ALL_LOCALES, DEFAULT_LOCALE, isLocale } from "@ellul.ai/i18n-consts";

export type SurfaceMessages = Record<string, unknown>;

export interface CreateRequestConfigOptions {
  /**
   * Identifier for this surface ("web", "console", "vps-ui", "docs").
   * Used as the CDN path prefix and in error logs.
   */
  surface: string;
  /**
   * Loads the full messages tree for a locale. Each surface implements
   * this to import the centralized tree from
   * `@ellul.ai/i18n-messages/messages/<locale>`. Errors are caught and
   * the default locale is loaded as a fallback.
   */
  loadMessages: (locale: Locale) => Promise<SurfaceMessages>;
  /**
   * Optional CDN base URL override. Defaults to
   * `process.env.TRANSLATIONS_CDN_URL`. The full URL fetched is
   * `${cdnUrl}/${surface}/${locale}.json`.
   */
  cdnUrl?: string;
  /** Optional locale set; defaults to ALL_LOCALES. */
  locales?: readonly Locale[];
  /** Optional fallback locale; defaults to DEFAULT_LOCALE. */
  defaultLocale?: Locale;
  /**
   * Cache TTL (seconds) for CDN-fetched messages; defaults to 3600.
   * Pass 0 to disable revalidate caching for dev.
   */
  cdnRevalidate?: number;
}

interface CdnFetchInit extends RequestInit {
  next?: {
    revalidate?: number | false;
    tags?: string[];
  };
}

/**
 * Resolves the CDN base URL for a surface, checking per-surface env first
 * (`{SURFACE}_TRANSLATIONS_CDN_URL`, normalized to upper-case alphanumeric)
 * and falling back to the global `TRANSLATIONS_CDN_URL`. Lets one surface
 * switch to CDN delivery while others stay on bundled messages.
 */
export function resolveCdnUrl(surface: string): string | undefined {
  const surfaceKey = surface.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const perSurface = process.env[`${surfaceKey}_TRANSLATIONS_CDN_URL`];
  return perSurface ?? process.env.TRANSLATIONS_CDN_URL;
}

/**
 * Builds a next-intl getRequestConfig for a surface. Handles CDN-first
 * loading with graceful fallback to bundled messages.
 *
 * Fallback chain (top to bottom):
 *   1. CDN: `${TRANSLATIONS_CDN_URL}/${surface}/${locale}.json`
 *   2. Bundled: `loadMessages(locale)`
 *   3. Bundled fallback locale: `loadMessages(defaultLocale)`
 *   4. Empty messages object (last-resort)
 *
 * @example
 * import { createRequestConfig } from "@ellul.ai/i18n/request";
 *
 * const loaders = {
 *   en: async () => (await import("@ellul.ai/i18n-messages/messages/en")).default,
 *   ja: async () => (await import("@ellul.ai/i18n-messages/messages/ja")).default,
 *   // ... one per locale
 * };
 *
 * export default createRequestConfig({
 *   surface: "web",
 *   loadMessages: (locale) => loaders[locale](),
 * });
 */
export function createRequestConfig(opts: CreateRequestConfigOptions) {
  const cdnUrl = opts.cdnUrl ?? resolveCdnUrl(opts.surface);
  const locales = opts.locales ?? ALL_LOCALES;
  const defaultLocale = opts.defaultLocale ?? DEFAULT_LOCALE;
  const cdnRevalidate = opts.cdnRevalidate ?? 3600;

  return getRequestConfig(async ({ requestLocale }) => {
    const requested = await requestLocale;
    const locale: Locale =
      isLocale(requested) && (locales as readonly string[]).includes(requested)
        ? requested
        : defaultLocale;

    if (cdnUrl) {
      try {
        const init: CdnFetchInit = {
          next: {
            revalidate: cdnRevalidate,
            tags: [`translations-${opts.surface}-${locale}`],
          },
        };
        const response = await fetch(`${cdnUrl}/${opts.surface}/${locale}.json`, init);
        if (response.ok) {
          return { locale, messages: await response.json() };
        }
        console.error(
          `[i18n:${opts.surface}] CDN fetch failed for ${locale}: ${response.status}`,
        );
      } catch (error) {
        console.error(`[i18n:${opts.surface}] CDN error for ${locale}:`, error);
      }
    }

    try {
      return { locale, messages: await opts.loadMessages(locale) };
    } catch (e) {
      console.error(
        `[i18n:${opts.surface}] failed to load messages for ${locale}, falling back to ${defaultLocale}:`,
        e,
      );
    }

    try {
      return { locale, messages: await opts.loadMessages(defaultLocale) };
    } catch (e) {
      console.error(
        `[i18n:${opts.surface}] critical: failed to load fallback ${defaultLocale} messages`,
        e,
      );
      return { locale, messages: {} };
    }
  });
}
