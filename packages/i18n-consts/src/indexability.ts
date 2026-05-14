// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type { Locale } from "./locales";
import type { Surface } from "./surfaces";

/**
 * Per-surface indexability gate. A locale only enters its surface's set
 * once its translation has shipped AND any required native QA has passed.
 *
 * Effect when a locale is OUT of its surface's set:
 *  - pageMetadata helpers emit `robots: { index: false, follow: true }`
 *  - `<link rel="alternate" hreflang="<locale>">` drops out
 *  - sitemap excludes the locale's URL alternates
 *
 * The locale's route still resolves and renders that locale's translation;
 * we just don't invite Google to index unreviewed copy. To enable: ship
 * messages, run native QA where required, then add the locale here.
 *
 * For private surfaces (console, vps-ui), the set is empty — those surfaces
 * never index regardless of translation status.
 */
export const INDEXABLE_LOCALES_BY_SURFACE: Record<Surface, ReadonlySet<Locale>> = {
  web: new Set<Locale>([
    "en",
    // "ja"    — translation shipped 2026-04-30, awaiting native QA on / + /pricing
    // "ko"    — Phase 7-PRE infra ready; translation + native QA pending per LOCALE-LAUNCH-CHECKLIST
    // "de"    — Phase 7-PRE infra ready; translation + native QA pending per LOCALE-LAUNCH-CHECKLIST
    // "pt-BR" — Phase 7-PRE infra ready; translation + native QA pending per LOCALE-LAUNCH-CHECKLIST
    // "fr"    — Phase 7-PRE infra ready; translation + native QA pending per LOCALE-LAUNCH-CHECKLIST
  ]),
  docs: new Set<Locale>([
    "en",
    // Per-locale docs MDX content lands as it's translated. Add here once shipped + QA'd.
  ]),
  console: new Set<Locale>([]),
  "vps-ui": new Set<Locale>([]),
};

export function isIndexableLocale(surface: Surface, locale: Locale): boolean {
  const set = INDEXABLE_LOCALES_BY_SURFACE[surface];
  return set.has(locale);
}

/**
 * Path patterns that are noindex regardless of locale (e.g. signup flows,
 * API routes, internal-only paths). Use for the surface's `robots` metadata
 * helper alongside the locale gate.
 */
export const NOINDEX_PATH_PATTERNS = [
  /^\/signup/,
  /^\/api\//,
  /^\/_/,
  /^\/preview\//,
] as const;

export function isNoIndexPath(pathname: string): boolean {
  return NOINDEX_PATH_PATTERNS.some((rx) => rx.test(pathname));
}

/**
 * Paths whose legally-binding version is EN-only. Localized translations
 * exist (so JP/KR/DE users can read in their own language) but are
 * "reference translations" — not legally binding, not SEO-canonical.
 *
 * For these paths, `pageMetadata()`:
 *   - sets canonical to the EN URL on every locale
 *   - emits robots=noindex,follow on every non-EN locale
 *   - omits hreflang language alternates (so search engines don't surface
 *     /ja/privacy in JP-locale search results)
 *
 * This is the standard SaaS legal-localization pattern (Stripe, Notion,
 * Linear, Vercel): translated legal exists for user-facing readability, but
 * EN is the single source of legal truth. Combined with a prominent
 * "this is a reference translation" disclaimer above the fold, it gives
 * enterprise-grade legal posture without lawyers in every jurisdiction.
 *
 * Add new patterns here when introducing new legal documents (DPA, AUP,
 * cookie policy, etc.).
 */
export const REFERENCE_TRANSLATION_PATHS = [
  /^\/privacy$/,
  /^\/terms$/,
] as const;

export function isReferenceTranslationPath(pathname: string): boolean {
  return REFERENCE_TRANSLATION_PATHS.some((rx) => rx.test(pathname));
}
