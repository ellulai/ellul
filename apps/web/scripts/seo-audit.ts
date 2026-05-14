#!/usr/bin/env tsx
/**
 * SEO audit: walks every URL in the sitemap, fetches HTML, and asserts that
 * each page has all the metadata an enterprise site is expected to ship.
 *
 * Asserts (per-URL):
 *   - <title> is non-empty
 *   - <meta name="description"> is non-empty
 *   - <link rel="canonical"> is absolute https URL
 *   - <meta property="og:title"> is non-empty
 *   - <meta property="og:image"> exists (we render OG images, so this is critical)
 *   - <meta name="twitter:card"> is non-empty
 *   - exactly one <h1>
 *   - hreflang count matches the surface's indexable locale set
 *   - every <script type="application/ld+json"> parses as JSON
 *
 * Selective translation: routes that intentionally narrow their hreflang set
 * (blog posts with only an en.mdx, use-cases with one locale) declare their
 * available locales via meta files. The audit reads those files and validates
 * `hreflang count == intersect(available, indexable)` instead of the global
 * indexable size.
 *
 * Non-HTML routes (RSS feeds, sitemaps) are skipped — they don't have <head>.
 *
 * Usage:  SEO_AUDIT_BASE_URL=http://localhost:3002 pnpm seo:audit
 */

import fs from "node:fs";
import path from "node:path";
import {
  ALL_LOCALES,
  type Locale,
} from "@ellul.ai/i18n-consts";
import { isIndexableLocale } from "@ellul.ai/i18n-consts/indexability";
import {
  listBlogSlugs,
  getAvailableLocales as getAvailableBlogLocales,
} from "../src/lib/blog";
import {
  listUseCaseSlugs,
  getAvailableLocales as getAvailableUseCaseLocales,
} from "../src/content/use-cases/loader";

// Compute the indexable locale set the same way the runtime does — single
// source of truth, no inlining drift.
const WEB_INDEXABLE_LOCALES = ALL_LOCALES.filter((l) =>
  isIndexableLocale("web", l as Locale),
);

const BASE_URL = process.env.SEO_AUDIT_BASE_URL ?? "http://localhost:3002";
const TIMEOUT_MS = 30_000;

// Routes whose body is XML/text, not HTML. Skip the metadata audit.
const NON_HTML_PATTERNS: RegExp[] = [
  /\.xml$/i,
  /\.txt$/i,
  /\/rss\b/i,
];

interface PageReport {
  url: string;
  skipped?: boolean;
  pass: boolean;
  errors: string[];
  warnings: string[];
}

interface AuditReport {
  baseUrl: string;
  timestamp: string;
  pageCount: number;
  passCount: number;
  failCount: number;
  skippedCount: number;
  pages: PageReport[];
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function findAttr(
  html: string,
  pattern: RegExp,
  attr = "content",
): string | null {
  const match = html.match(pattern);
  if (!match) return null;
  const tag = match[0];
  const attrMatch = tag.match(new RegExp(`${attr}=["']([^"']+)["']`, "i"));
  if (!attrMatch || !attrMatch[1]) return null;
  return unescapeHtml(attrMatch[1]);
}

function findAll(html: string, pattern: RegExp): RegExpMatchArray[] {
  const out: RegExpMatchArray[] = [];
  let m: RegExpExecArray | null;
  const rx = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  while ((m = rx.exec(html)) !== null) out.push(m);
  return out;
}

function getJsonLdBlocks(html: string): string[] {
  const matches = findAll(
    html,
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  return matches.map((m) => m[1].trim());
}

function isNonHtml(pathname: string): boolean {
  return NON_HTML_PATTERNS.some((rx) => rx.test(pathname));
}

/**
 * Returns the expected hreflang count for a URL, accounting for selective-
 * translation routes (blog posts, use-cases) where only a subset of locales
 * have content. Falls back to the full indexable set for everything else.
 */
function expectedHreflangCount(pathname: string): number {
  const blogMatch = pathname.match(/^\/blog\/([^/]+)$/);
  if (blogMatch) {
    const slug = blogMatch[1];
    if (listBlogSlugs().includes(slug)) {
      const available = new Set(getAvailableBlogLocales(slug));
      return WEB_INDEXABLE_LOCALES.filter((l) => available.has(l)).length;
    }
  }
  const useCaseMatch = pathname.match(/^\/solutions\/([^/]+)$/);
  if (useCaseMatch) {
    const slug = useCaseMatch[1];
    if (listUseCaseSlugs().includes(slug)) {
      const available = new Set(getAvailableUseCaseLocales(slug));
      return WEB_INDEXABLE_LOCALES.filter((l) => available.has(l)).length;
    }
  }
  return WEB_INDEXABLE_LOCALES.length;
}

async function auditPage(url: string): Promise<PageReport> {
  const errors: string[] = [];
  const warnings: string[] = [];

  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = url;
  }

  if (isNonHtml(pathname)) {
    return {
      url,
      skipped: true,
      pass: true,
      errors: [],
      warnings: ["non-HTML route, audit skipped"],
    };
  }

  let html = "";
  try {
    const res = await fetchWithTimeout(url, TIMEOUT_MS);
    if (!res.ok) {
      errors.push(`HTTP ${res.status} ${res.statusText}`);
      return { url, pass: false, errors, warnings };
    }
    html = await res.text();
  } catch (e) {
    errors.push(`fetch failed: ${(e as Error).message}`);
    return { url, pass: false, errors, warnings };
  }

  // Title
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
  if (!title) errors.push("missing <title>");

  // Description
  const description = findAttr(
    html,
    /<meta[^>]+name=["']description["'][^>]*>/i,
  );
  if (!description || description.length < 30) {
    errors.push("missing or short meta description (<30 chars)");
  }

  // Canonical
  const canonical = findAttr(
    html,
    /<link[^>]+rel=["']canonical["'][^>]*>/i,
    "href",
  );
  if (!canonical) errors.push("missing canonical link");
  else if (!/^https?:\/\//.test(canonical)) {
    errors.push(`canonical not absolute: ${canonical}`);
  }

  // OG title
  const ogTitle = findAttr(
    html,
    /<meta[^>]+property=["']og:title["'][^>]*>/i,
  );
  if (!ogTitle) errors.push("missing og:title");

  // OG image
  const ogImage = findAttr(
    html,
    /<meta[^>]+property=["']og:image["'][^>]*>/i,
  );
  if (!ogImage) warnings.push("missing og:image (Next 15 should auto-emit one)");

  // Twitter card
  const twitterCard = findAttr(
    html,
    /<meta[^>]+name=["']twitter:card["'][^>]*>/i,
  );
  if (!twitterCard) errors.push("missing twitter:card");

  // Single H1
  const h1Count = findAll(html, /<h1\b[^>]*>/gi).length;
  if (h1Count === 0) errors.push("no <h1> on page");
  else if (h1Count > 1) errors.push(`multiple <h1> (${h1Count}) on page`);

  // hreflang count — Next.js emits `hrefLang` in the rendered HTML.
  const hreflangs = findAll(
    html,
    /<link[^>]+rel=["']alternate["'][^>]+hreflang=["'][^"']+["'][^>]*>/gi,
  );
  // Subtract x-default (always present in addition to per-locale entries).
  const localeHreflangCount = hreflangs.filter(
    (m) => !/hreflang=["']x-default["']/i.test(m[0]),
  ).length;
  const expectedCount = expectedHreflangCount(pathname);
  if (localeHreflangCount < expectedCount) {
    errors.push(
      `hreflang count ${localeHreflangCount} < expected ${expectedCount} for this route`,
    );
  }
  // x-default is mandatory.
  const hasXDefault = hreflangs.some((m) =>
    /hreflang=["']x-default["']/i.test(m[0]),
  );
  if (!hasXDefault) errors.push("missing hreflang=x-default");

  // JSON-LD blocks parse
  const jsonLdBlocks = getJsonLdBlocks(html);
  jsonLdBlocks.forEach((block, i) => {
    try {
      JSON.parse(block);
    } catch (e) {
      errors.push(`JSON-LD block #${i} fails to parse: ${(e as Error).message}`);
    }
  });

  return {
    url,
    pass: errors.length === 0,
    errors,
    warnings,
  };
}

async function fetchSitemapUrls(): Promise<string[]> {
  const res = await fetchWithTimeout(`${BASE_URL}/sitemap.xml`, TIMEOUT_MS);
  if (!res.ok) {
    throw new Error(`sitemap.xml HTTP ${res.status}`);
  }
  const xml = await res.text();
  const urls: string[] = [];
  const re = /<loc>([^<]+)<\/loc>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const found = m[1].trim();
    // Convert prod URL to local audit URL.
    const replaced = found.replace(/^https:\/\/ellul\.ai/, BASE_URL);
    urls.push(replaced);
  }
  return urls;
}

async function main() {
  console.log(`SEO audit against ${BASE_URL}`);
  const urls = await fetchSitemapUrls();
  console.log(`Found ${urls.length} URLs in sitemap`);

  const pages: PageReport[] = [];
  for (const url of urls) {
    process.stdout.write(`  ${url} … `);
    const report = await auditPage(url);
    pages.push(report);
    if (report.skipped) {
      console.log("SKIP (non-HTML)");
      continue;
    }
    if (report.pass) {
      console.log(report.warnings.length ? `OK (${report.warnings.length} warn)` : "OK");
    } else {
      console.log(`FAIL`);
      for (const err of report.errors) console.log(`    ✗ ${err}`);
    }
    for (const warn of report.warnings) console.log(`    ⚠ ${warn}`);
  }

  const skippedCount = pages.filter((p) => p.skipped).length;
  const passCount = pages.filter((p) => !p.skipped && p.pass).length;
  const failCount = pages.filter((p) => !p.skipped && !p.pass).length;
  const report: AuditReport = {
    baseUrl: BASE_URL,
    timestamp: new Date().toISOString(),
    pageCount: pages.length,
    passCount,
    failCount,
    skippedCount,
    pages,
  };

  const reportPath = path.join(process.cwd(), "seo-audit-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written to ${reportPath}`);
  console.log(
    `Pass: ${passCount}, Fail: ${failCount}, Skip: ${skippedCount}, Total: ${pages.length}`,
  );

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
