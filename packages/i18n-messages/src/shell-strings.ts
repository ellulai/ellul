// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Shell-string builders (Phase 7a-NATIVE centralization)
 *
 * VPS provisioning emits bash + HTML strings (MOTD, /etc/environment LANG
 * mapping, the static unauthorized page) that need to be locale-aware.
 * Rather than duplicate per-locale text inside `motd.sh`, `directories.ts`,
 * and `locale.sh`, every translatable string lives in JSON
 * (`messages/<locale>/vpsShell.json`) and the bash/HTML scaffolding is
 * emitted from a single source.
 *
 * Adding a locale: drop in `messages/<locale>/vpsShell.json`, register it
 * in `messageLoaders` + `SHIPPED_LOCALES`, and the bash case statements
 * pick it up on the next build. No per-surface code changes.
 */

import { ALL_LOCALES, GLIBC_LOCALE, type Locale } from "@ellul.ai/i18n-consts";
import enShell from "../messages/en/vpsShell.json";
import jaShell from "../messages/ja/vpsShell.json";
import { SHIPPED_LOCALES } from "./loaders";

interface MotdStrings {
  tagline: string;
  deployedHeader: string;
  noAppsHint: string;
  aiHeader: string;
  toolsInstalling: string;
  cmdsHeader: string;
}

interface UnauthorizedPageStrings {
  body: string;
  cta: string;
}

interface VpsShell {
  motd: MotdStrings;
  unauthorizedPage: UnauthorizedPageStrings;
}

const NATIVE_TREES: Partial<Record<Locale, VpsShell>> = {
  en: enShell.vpsShell,
  ja: jaShell.vpsShell,
};

/** Resolve to the locale's native vpsShell tree, falling back to en. */
function vpsShellFor(locale: Locale): VpsShell {
  return NATIVE_TREES[locale] ?? NATIVE_TREES.en!;
}

/** Single-quote a bash string. Escapes embedded single quotes by closing
 *  + concatenating + reopening: `it's` → `'it'\''s'`. Newlines are
 *  preserved because bash single-quoted strings are literal — the
 *  surrounding script handles whitespace. NUL bytes would break bash
 *  argv though, so reject them.
 */
function bashSingleQuote(s: string): string {
  if (s.includes("\0")) {
    throw new Error(`shell-strings: NUL byte in translation: ${JSON.stringify(s)}`);
  }
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * HTML-escape translation content destined for the static unauthorized
 * page. Allows a small allowlist of inline tags (`<br>` only — the page
 * needs line breaks inside the body string) and escapes everything else.
 *
 * Defends against translator-side injection: a compromised or rogue
 * translation pipeline cannot inject `<script>`, `<iframe>`,
 * `</div><...>`, event handlers, or arbitrary URLs into the served
 * page. The page's CSP additionally prevents inline-event execution
 * even if a tag did slip through.
 *
 * Allowed: literal `<br>` and `<br/>` (with optional whitespace).
 * Everything else: escape to entities.
 */
function escapeHtmlAllowingBr(input: string): string {
  // Sentinel that can't appear in source content (control char) lets us
  // round-trip the allowed `<br>` past the entity-escape pass.
  const SENTINEL = "BR";
  const protectedSrc = input.replace(/<\s*br\s*\/?\s*>/gi, SENTINEL);
  const escaped = protectedSrc
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return escaped.split(SENTINEL).join("<br>");
}

/**
 * Emit a bash `case` body that sets MOTD layout variables per locale.
 * The motd.sh template wraps this with `case "$USER_LOCALE" in … esac`.
 *
 * Only locales whose translations have shipped get their own branch; the
 * rest fall through to the wildcard, which mirrors en. Same fallback
 * shape as `messageLoaders` in loaders.ts.
 */
export function buildMotdShellCase(): string {
  const lines: string[] = [`case "$USER_LOCALE" in`];
  for (const locale of ALL_LOCALES) {
    if (!SHIPPED_LOCALES.has(locale)) continue;
    const m = vpsShellFor(locale).motd;
    lines.push(
      `  ${locale})`,
      `    BANNER_TAGLINE=${bashSingleQuote(m.tagline)}`,
      `    DEPLOYED_HEADER=${bashSingleQuote(m.deployedHeader)}`,
      `    EMPTY_LINE=${bashSingleQuote(m.noAppsHint)}`,
      `    AI_HEADER=${bashSingleQuote(m.aiHeader)}`,
      `    TOOLS_INSTALLING=${bashSingleQuote(m.toolsInstalling)}`,
      `    CMDS_HEADER=${bashSingleQuote(m.cmdsHeader)}`,
      `    ;;`,
    );
  }
  // Default branch = en. Non-shipped locales fall here.
  const en = vpsShellFor("en").motd;
  lines.push(
    `  *)`,
    `    BANNER_TAGLINE=${bashSingleQuote(en.tagline)}`,
    `    DEPLOYED_HEADER=${bashSingleQuote(en.deployedHeader)}`,
    `    EMPTY_LINE=${bashSingleQuote(en.noAppsHint)}`,
    `    AI_HEADER=${bashSingleQuote(en.aiHeader)}`,
    `    TOOLS_INSTALLING=${bashSingleQuote(en.toolsInstalling)}`,
    `    CMDS_HEADER=${bashSingleQuote(en.cmdsHeader)}`,
    `    ;;`,
    `esac`,
  );
  return lines.join("\n");
}

/**
 * Locales that participate in the unauthorized-page HTML output: en
 * always, plus every shipped non-en locale. Other locales fall back to
 * en at render time via the client-side `navigator.language` matcher.
 */
function unauthorizedPageLocales(): Locale[] {
  const out: Locale[] = ["en"];
  for (const locale of ALL_LOCALES) {
    if (locale !== "en" && SHIPPED_LOCALES.has(locale)) out.push(locale);
  }
  return out;
}

/**
 * Emit `<div data-locale="...">` and `<a data-locale="...">` blocks for
 * the unauthorized page. Translation content is HTML-escaped (allowing
 * literal `<br>` only) to defend against translator-side injection.
 * The page's CSP locks down inline events as belt-and-braces.
 */
export function buildUnauthorizedPageHtml(): string {
  const blocks: string[] = [];
  for (const locale of unauthorizedPageLocales()) {
    const u = vpsShellFor(locale).unauthorizedPage;
    blocks.push(
      `<div class="s" data-locale="${locale}">${escapeHtmlAllowingBr(u.body)}</div>`,
    );
  }
  for (const locale of unauthorizedPageLocales()) {
    const u = vpsShellFor(locale).unauthorizedPage;
    // CTA renders inside an <a>, so we strip every tag (including <br>)
    // since "Get Started" / "はじめる" should never break a button label.
    const cta = escapeHtmlAllowingBr(u.cta).replace(/<br>/g, " ");
    blocks.push(`<a href="https://ellul.ai" data-locale="${locale}">${cta}</a>`);
  }
  return blocks.join("\n");
}

/**
 * JSON-array literal of shipped non-en locale codes for the
 * navigator.language matcher embedded in the unauthorized page's
 * inline script. Non-shipped locales (and en itself) fall through
 * to the en data-locale block at render time.
 *
 * Returns e.g. `["ja"]` today, `["ja","ko"]` once Korean ships.
 */
export function buildShippedNonEnLocalesJson(): string {
  const codes: Locale[] = [];
  for (const locale of ALL_LOCALES) {
    if (locale === "en" || !SHIPPED_LOCALES.has(locale)) continue;
    codes.push(locale);
  }
  return JSON.stringify(codes);
}

/**
 * Emit a bash function body that maps a locale code → glibc locale
 * string. `funcName` lets the caller pick the function name (default
 * `_locale_to_glibc`).
 *
 * Falls back to en's glibc value (`en_US.UTF-8`) for unknown codes —
 * mirrors the i18n-consts default and prevents `LANG=` going unset on
 * a corrupt /etc/ellul/user-locale.
 */
export function buildLocaleToGlibcCase(funcName: string = "_locale_to_glibc"): string {
  const lines: string[] = [`${funcName}() {`, `  case "$1" in`];
  for (const locale of ALL_LOCALES) {
    lines.push(`    ${locale}) echo "${GLIBC_LOCALE[locale]}" ;;`);
  }
  lines.push(
    `    *) echo "${GLIBC_LOCALE.en}" ;;`,
    `  esac`,
    `}`,
  );
  return lines.join("\n");
}

/**
 * The full set of glibc locale strings — useful when a caller needs to
 * generate `/etc/locale.gen` lines or pre-flight `apt install locales`.
 */
export function allGlibcLocales(): readonly string[] {
  return ALL_LOCALES.map((l) => GLIBC_LOCALE[l]);
}
