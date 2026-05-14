// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { type Locale } from "@ellul.ai/i18n-consts";
import { loadMessages } from "./loaders";

export interface OverlayResolver<TOverlay> {
  load(locale: Locale): Promise<Record<string, TOverlay>>;
  resolve(slug: string, locale: Locale): Promise<TOverlay | null>;
  listKeys(locale: Locale): Promise<string[]>;
  clearCache(): void;
}

export interface OverlayResolverOptions {
  /** Locale used as the EN-fallback source when a slug is missing. */
  defaultLocale?: Locale;
}

/**
 * Build a per-namespace overlay resolver for content surfaces (agents,
 * mcp, glossary, pillars, comparisons, use-cases, blog, authors).
 *
 * Caches the namespace tree per-locale and falls back to the default
 * locale when a slug is missing. Lookups are O(1) after the first call.
 */
export function createOverlayResolver<TOverlay>(
  namespaceKey: string,
  options: OverlayResolverOptions = {},
): OverlayResolver<TOverlay> {
  const defaultLocale = options.defaultLocale ?? ("en" as Locale);
  const cache = new Map<Locale, Record<string, TOverlay>>();

  async function load(locale: Locale): Promise<Record<string, TOverlay>> {
    const cached = cache.get(locale);
    if (cached) return cached;
    const messages = (await loadMessages(locale)) as Record<string, unknown>;
    const ns =
      (messages[namespaceKey] as Record<string, TOverlay> | undefined) ?? {};
    cache.set(locale, ns);
    return ns;
  }

  async function resolve(
    slug: string,
    locale: Locale,
  ): Promise<TOverlay | null> {
    const ns = await load(locale);
    const direct = ns[slug];
    if (direct) return direct;
    if (locale !== defaultLocale) {
      const fallback = await load(defaultLocale);
      return fallback[slug] ?? null;
    }
    return null;
  }

  async function listKeys(locale: Locale): Promise<string[]> {
    const ns = await load(locale);
    return Object.keys(ns);
  }

  function clearCache(): void {
    cache.clear();
  }

  return { load, resolve, listKeys, clearCache };
}
