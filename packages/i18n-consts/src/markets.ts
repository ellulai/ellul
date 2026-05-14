// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type { Locale } from "./locales";

/**
 * Locales receiving full marketing investment per Playbook §39.
 * "Priority" here means: dedicated SEO/GEO content, native QA where required,
 * and per-locale Search Console properties. All current locales are
 * priority — the term is preserved as a forward-compatible distinction
 * for when ghost locales (hreflang-only, no translation) are added.
 */
export const PRIORITY_LOCALES = [
  "en",
  "ja",
  "ko",
  "de",
  "pt-BR",
  "fr",
] as const;

export type PriorityLocale = (typeof PRIORITY_LOCALES)[number];

/**
 * Locales we signal to search engines via hreflang but do NOT translate
 * (e.g. en-IN, en-GB, en-AU regional variants per Playbook §40). Empty
 * today; adding members here exposes them to hreflang without shipping
 * translation files.
 */
export const GHOST_LOCALES = [] as const;
export type GhostLocale = (typeof GHOST_LOCALES)[number];

export function isPriorityLocale(locale: Locale): locale is PriorityLocale {
  return (PRIORITY_LOCALES as readonly string[]).includes(locale);
}

export function isGhostLocale(locale: Locale): locale is GhostLocale {
  return (GHOST_LOCALES as readonly string[]).includes(locale);
}

export interface FooterLink {
  href: string;
  anchorText: string;
}

/**
 * Per-locale localized anchor text for footer market links. These point at
 * canonical comparison/vs pages and surface in the footer's "Featured"
 * section on every priority-locale page. Anchor text is hand-tuned per
 * locale, not auto-translated, because anchor text is SEO-load-bearing.
 *
 * See Playbook §43 for the per-locale page-priority list these anchor
 * into.
 */
export const FOOTER_MARKET_LINKS: Record<PriorityLocale, FooterLink[]> = {
  en: [
    { href: "/blog/claude-code-vs-cursor", anchorText: "Claude Code vs Cursor" },
    { href: "/vs/cursor", anchorText: "vs Cursor" },
    { href: "/vs/claude-code", anchorText: "vs Claude Code" },
  ],
  ja: [
    { href: "/blog/claude-code-vs-cursor", anchorText: "Claude Code 対 Cursor" },
    { href: "/vs/cursor", anchorText: "Cursor 比較" },
    { href: "/vs/claude-code", anchorText: "Claude Code 比較" },
  ],
  ko: [
    { href: "/blog/claude-code-vs-cursor", anchorText: "Claude Code vs Cursor" },
    { href: "/vs/cursor", anchorText: "Cursor 비교" },
    { href: "/vs/claude-code", anchorText: "Claude Code 비교" },
  ],
  de: [
    { href: "/blog/claude-code-vs-cursor", anchorText: "Claude Code vs Cursor" },
    { href: "/vs/cursor", anchorText: "Cursor Vergleich" },
    { href: "/vs/claude-code", anchorText: "Claude Code Vergleich" },
  ],
  "pt-BR": [
    { href: "/blog/claude-code-vs-cursor", anchorText: "Claude Code vs Cursor" },
    { href: "/vs/cursor", anchorText: "Comparação Cursor" },
    { href: "/vs/claude-code", anchorText: "Comparação Claude Code" },
  ],
  fr: [
    { href: "/blog/claude-code-vs-cursor", anchorText: "Claude Code vs Cursor" },
    { href: "/vs/cursor", anchorText: "Comparaison Cursor" },
    { href: "/vs/claude-code", anchorText: "Comparaison Claude Code" },
  ],
};
