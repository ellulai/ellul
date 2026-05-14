#!/usr/bin/env tsx
/**
 * Content audit: walks every comparison, use-case, blog post, and author
 * meta file. Validates them through their Zod schemas, checks freshness,
 * verifies referenced images exist, and confirms internal links resolve.
 *
 * Failures here block the apps/web build (wired as a turbo build dep).
 *
 * Usage:  pnpm --filter @ellul.ai/web content:audit
 *
 * ──────────────────────────────────────────────────────────────────────
 * Locale-completeness assertion (Phase 7-PRE)
 * ──────────────────────────────────────────────────────────────────────
 * Invariant: if a locale has no shipped content (no per-content
 * translations, no foundation messages tree), no <link rel="alternate"
 * hreflang="<locale>"> for that locale should appear in any rendered
 * <head>.
 *
 * Where the invariant is enforced at runtime:
 *  - Per-content URLs (blog, pillars, comparisons, use-cases, glossary,
 *    agents, mcp): apps/web/src/app/sitemap.ts filters each URL's
 *    `alternates.languages` to locales whose translation actually exists
 *    (per the loader's `getAvailableLocales` family). A locale with zero
 *    translated content sees zero hreflang lines.
 *  - Static URLs (/, /pricing, /faq, /privacy, /terms): sitemap.ts uses
 *    the global `indexableLocales` set unconditionally. A locale that
 *    sits in `INDEXABLE_LOCALES_BY_SURFACE.web` but has no foundation
 *    messages tree (messages/<locale>/{home,pricing,faq}.json) will
 *    therefore emit hreflang for static routes that render in fallback
 *    English — a duplicate-content signal Google penalizes.
 *
 * The check below surfaces that mismatch as a warning during the audit
 * (per Phase 7-PRE policy: warn, don't fail, until each locale launches).
 * Operator should either ship the foundation translations or remove the
 * locale from INDEXABLE_LOCALES_BY_SURFACE.web.
 */

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const APP_ROOT = path.resolve(__dirname, "..");
const PUBLIC_ROOT = path.join(APP_ROOT, "public");
const SRC_ROOT = path.join(APP_ROOT, "src");
const I18N_MESSAGES_ROOT = path.resolve(
  APP_ROOT,
  "..",
  "..",
  "packages",
  "i18n-messages",
  "messages",
);

const STALE_WARN_MONTHS = 12;
const STALE_FAIL_MONTHS = 18;

// Locales we track for translation-progress reporting. EN is the base; not
// included here because it always exists. Add more as locales come online.
const TRACKED_TRANSLATION_LOCALES = ["ja"] as const;
type TrackedLocale = (typeof TRACKED_TRANSLATION_LOCALES)[number];

// Translation overlays now live in packages/i18n-messages/messages/{locale}/
// {namespace}.json (centralized i18n surface). The audit reads them at boot
// to report per-surface progress without needing to hit the runtime loader.
function readOverlayKeys(
  locale: TrackedLocale,
  namespace: string,
): Set<string> {
  const file = path.join(I18N_MESSAGES_ROOT, locale, `${namespace}.json`);
  if (!fs.existsSync(file)) return new Set();
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf-8"));
    const ns = json[namespace] as Record<string, unknown> | undefined;
    return new Set(ns ? Object.keys(ns) : []);
  } catch {
    return new Set();
  }
}

const overlayKeys: Record<string, Record<TrackedLocale, Set<string>>> = {
  glossary: { ja: readOverlayKeys("ja", "glossary") },
  pillars: { ja: readOverlayKeys("ja", "pillars") },
  comparisons: { ja: readOverlayKeys("ja", "comparisons") },
};

interface TranslationProgress {
  total: number;
  byLocale: Record<TrackedLocale, number>;
}

const translationProgress: Record<string, TranslationProgress> = {
  glossary: {
    total: 0,
    byLocale: { ja: 0 },
  },
  pillars: {
    total: 0,
    byLocale: { ja: 0 },
  },
  pillarsMdx: {
    total: 0,
    byLocale: { ja: 0 },
  },
  comparisons: {
    total: 0,
    byLocale: { ja: 0 },
  },
  useCases: {
    total: 0,
    byLocale: { ja: 0 },
  },
  agents: {
    total: 0,
    byLocale: { ja: 0 },
  },
  mcp: {
    total: 0,
    byLocale: { ja: 0 },
  },
  blog: {
    total: 0,
    byLocale: { ja: 0 },
  },
  blogMdx: {
    total: 0,
    byLocale: { ja: 0 },
  },
};

interface AuditResult {
  errors: string[];
  warnings: string[];
}

const result: AuditResult = { errors: [], warnings: [] };

function logErr(file: string, msg: string) {
  result.errors.push(`[ERR] ${path.relative(APP_ROOT, file)}: ${msg}`);
}
function logWarn(file: string, msg: string) {
  result.warnings.push(`[WARN] ${path.relative(APP_ROOT, file)}: ${msg}`);
}

function monthsBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return ms / (1000 * 60 * 60 * 24 * 30.44);
}

function checkFreshness(file: string, isoDate: string) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    logErr(file, `lastUpdated/updatedAt not a valid YYYY-MM-DD: ${isoDate}`);
    return;
  }
  const months = monthsBetween(d, new Date());
  if (months >= STALE_FAIL_MONTHS) {
    logErr(
      file,
      `content is ${months.toFixed(1)} months stale (>= ${STALE_FAIL_MONTHS}); refresh lastUpdated`,
    );
  } else if (months >= STALE_WARN_MONTHS) {
    logWarn(
      file,
      `content is ${months.toFixed(1)} months old (warn at ${STALE_WARN_MONTHS}); consider refreshing`,
    );
  }
}

function checkOgImage(file: string, ogPath: string | undefined) {
  if (!ogPath) return;
  const fsPath = path.join(PUBLIC_ROOT, ogPath.replace(/^\//, ""));
  if (!fs.existsSync(fsPath)) {
    logWarn(
      file,
      `referenced ogImage "${ogPath}" not found at ${path.relative(APP_ROOT, fsPath)} (dynamic OG route will be used as fallback)`,
    );
  }
}

const knownInternalRoutes = new Set<string>();
const internalRefs: Array<{ file: string; href: string }> = [];

function recordInternalRef(file: string, href: string) {
  if (!href || !href.startsWith("/") || href.startsWith("//")) return;
  // Strip query / hash for resolution check.
  const clean = href.split("#")[0]?.split("?")[0] ?? href;
  internalRefs.push({ file, href: clean });
}

// ---------------------------------------------------------------------------
// 1. Comparisons
// ---------------------------------------------------------------------------

async function auditComparisons() {
  const dir = path.join(SRC_ROOT, "content", "comparisons");
  if (!fs.existsSync(dir)) return;
  const RESERVED = new Set(["schema", "loader", "index"]);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !RESERVED.has(f.replace(/\.ts$/, "")));

  const { ComparisonDataSchema } = await import(
    path.join(dir, "schema.ts")
  );

  for (const f of files) {
    const file = path.join(dir, f);
    const slug = f.replace(/\.ts$/, "");
    try {
      const mod = await import(file);
      const raw = mod.default ?? mod.comparison;
      const parsed = ComparisonDataSchema.parse(raw);
      if (parsed.slug !== slug) {
        logErr(file, `slug mismatch: file is "${slug}.ts", data declares "${parsed.slug}"`);
      }
      knownInternalRoutes.add(`/vs/${parsed.slug}`);
      checkFreshness(file, parsed.lastUpdated);
      checkOgImage(file, parsed.ogImage);
      for (const u of parsed.relatedUseCases) {
        recordInternalRef(file, `/solutions/${u}`);
      }
      translationProgress.comparisons.total += 1;
      for (const loc of TRACKED_TRANSLATION_LOCALES) {
        if (overlayKeys.comparisons[loc].has(parsed.slug)) {
          translationProgress.comparisons.byLocale[loc] += 1;
        }
      }
    } catch (e) {
      const msg = e instanceof z.ZodError ? e.message : String(e);
      logErr(file, `failed to parse: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Use-cases
// ---------------------------------------------------------------------------

async function auditUseCases() {
  const dir = path.join(SRC_ROOT, "content", "use-cases");
  if (!fs.existsSync(dir)) return;
  const slugs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const { UseCaseMetaSchema } = await import(path.join(dir, "schema.ts"));

  for (const slug of slugs) {
    const metaFile = path.join(dir, slug, "meta.ts");
    if (!fs.existsSync(metaFile)) {
      logErr(metaFile, `missing meta.ts`);
      continue;
    }
    try {
      const mod = await import(metaFile);
      const raw = mod.default ?? mod.meta;
      const parsed = UseCaseMetaSchema.parse(raw);
      if (parsed.slug !== slug) {
        logErr(metaFile, `slug mismatch: directory "${slug}", meta declares "${parsed.slug}"`);
      }
      const enMdx = path.join(dir, slug, "en.mdx");
      if (!fs.existsSync(enMdx)) {
        logErr(metaFile, `missing en.mdx for use-case "${slug}"`);
      }
      knownInternalRoutes.add(`/solutions/${parsed.slug}`);
      checkFreshness(metaFile, parsed.lastUpdated);
      checkOgImage(metaFile, parsed.ogImage);
      for (const c of parsed.relatedComparisons) {
        recordInternalRef(metaFile, `/vs/${c}`);
      }
      if (parsed.cta.href.startsWith("/")) {
        recordInternalRef(metaFile, parsed.cta.href);
      }

      translationProgress.useCases.total += 1;
      for (const loc of TRACKED_TRANSLATION_LOCALES) {
        if (readOverlayKeys(loc, "useCases").has(slug)) {
          translationProgress.useCases.byLocale[loc] += 1;
        }
      }
    } catch (e) {
      const msg = e instanceof z.ZodError ? e.message : String(e);
      logErr(metaFile, `failed to parse: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Blog posts
// ---------------------------------------------------------------------------

async function auditBlog() {
  const dir = path.join(SRC_ROOT, "content", "blog");
  if (!fs.existsSync(dir)) return;
  const slugs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  for (const slug of slugs) {
    const metaFile = path.join(dir, slug, "meta.ts");
    if (!fs.existsSync(metaFile)) {
      logErr(metaFile, `missing meta.ts`);
      continue;
    }
    try {
      const mod = await import(metaFile);
      const meta = mod.default ?? mod.meta;
      if (meta.slug !== slug) {
        logErr(metaFile, `slug mismatch: directory "${slug}", meta declares "${meta.slug}"`);
      }
      if (typeof meta.publishedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(meta.publishedAt)) {
        logErr(metaFile, `publishedAt missing or not YYYY-MM-DD`);
      }
      const enMdx = path.join(dir, slug, "en.mdx");
      if (!fs.existsSync(enMdx)) {
        // Warning, not error: tolerant of in-flight content authoring. The
        // blog loader filters these out at runtime so missing-mdx slugs don't
        // ship as 404s; the post just isn't listed until the body lands.
        logWarn(metaFile, `missing en.mdx for blog post "${slug}" — skipped from listings until body lands`);
        continue;
      }
      knownInternalRoutes.add(`/blog/${slug}`);
      const lastUpdated = meta.updatedAt ?? meta.publishedAt;
      checkFreshness(metaFile, lastUpdated);
      checkOgImage(metaFile, meta.ogImage);

      // Translation progress: count blog overlay coverage (title/summary in
      // ja/blog.json) and ja.mdx body presence separately.
      translationProgress.blog.total += 1;
      translationProgress.blogMdx.total += 1;
      for (const loc of TRACKED_TRANSLATION_LOCALES) {
        if (readOverlayKeys(loc, "blog").has(slug)) {
          translationProgress.blog.byLocale[loc] += 1;
        }
        if (fs.existsSync(path.join(dir, slug, `${loc}.mdx`))) {
          translationProgress.blogMdx.byLocale[loc] += 1;
        }
      }
    } catch (e) {
      logErr(metaFile, `failed to load: ${String(e)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Pillars
// ---------------------------------------------------------------------------

async function auditPillars() {
  const dir = path.join(SRC_ROOT, "content", "pillars");
  if (!fs.existsSync(dir)) return;
  const slugs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const { PillarMetaSchema } = await import(path.join(dir, "schema.ts"));

  for (const slug of slugs) {
    const metaFile = path.join(dir, slug, "meta.ts");
    if (!fs.existsSync(metaFile)) {
      logErr(metaFile, `missing meta.ts`);
      continue;
    }
    try {
      const mod = await import(metaFile);
      const raw = mod.default ?? mod.meta;
      const parsed = PillarMetaSchema.parse(raw);
      if (parsed.slug !== slug) {
        logErr(metaFile, `slug mismatch: directory "${slug}", meta declares "${parsed.slug}"`);
      }
      const enMdx = path.join(dir, slug, "en.mdx");
      if (!fs.existsSync(enMdx)) {
        logErr(metaFile, `missing en.mdx for pillar "${slug}"`);
      }
      knownInternalRoutes.add(`/concepts/${parsed.slug}`);
      checkFreshness(metaFile, parsed.lastUpdated);
      checkOgImage(metaFile, parsed.ogImage);
      for (const c of parsed.relatedComparisons) recordInternalRef(metaFile, `/vs/${c}`);
      for (const u of parsed.relatedUseCases) recordInternalRef(metaFile, `/solutions/${u}`);
      for (const t of parsed.relatedTerms) recordInternalRef(metaFile, `/glossary/${t}`);
      if (parsed.cta.href.startsWith("/")) recordInternalRef(metaFile, parsed.cta.href);
      translationProgress.pillars.total += 1;
      translationProgress.pillarsMdx.total += 1;
      for (const loc of TRACKED_TRANSLATION_LOCALES) {
        // Pillar is "translated" for a locale only if BOTH the i18n-messages
        // overlay namespace has a slug entry AND a sibling <loc>.mdx file
        // exists. Either alone is a partial state and warns.
        const hasOverlay = overlayKeys.pillars[loc].has(slug);
        const hasMdx = fs.existsSync(path.join(dir, slug, `${loc}.mdx`));
        if (hasOverlay && hasMdx) {
          translationProgress.pillars.byLocale[loc] += 1;
        } else if (hasOverlay !== hasMdx) {
          logWarn(
            metaFile,
            `pillar "${slug}" has partial ${loc} translation: i18n overlay=${hasOverlay}, ${loc}.mdx=${hasMdx}. Both must exist for the locale to ship.`,
          );
        }
        if (hasMdx) translationProgress.pillarsMdx.byLocale[loc] += 1;
      }
    } catch (e) {
      const msg = e instanceof z.ZodError ? e.message : String(e);
      logErr(metaFile, `failed to parse: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Glossary
// ---------------------------------------------------------------------------

async function auditGlossary() {
  const dir = path.join(SRC_ROOT, "content", "glossary");
  if (!fs.existsSync(dir)) return;
  const RESERVED = new Set(["schema", "loader", "index"]);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !RESERVED.has(f.replace(/\.ts$/, "")));

  const { GlossaryTermSchema } = await import(path.join(dir, "schema.ts"));

  const allSlugs = new Set(
    files.map((f) => f.replace(/\.ts$/, "")),
  );

  for (const f of files) {
    const file = path.join(dir, f);
    const slug = f.replace(/\.ts$/, "");
    try {
      const mod = await import(file);
      const raw = mod.default ?? mod.term;
      const parsed = GlossaryTermSchema.parse(raw);
      if (parsed.slug !== slug) {
        logErr(file, `slug mismatch: file "${slug}.ts", data declares "${parsed.slug}"`);
      }
      knownInternalRoutes.add(`/glossary/${parsed.slug}`);
      checkFreshness(file, parsed.lastUpdated);
      checkOgImage(file, parsed.ogImage);
      // Every term should cross-link to at least one related term so the
      // glossary forms a connected graph (no orphan entries).
      if (!parsed.related?.length) {
        logWarn(file, `glossary term "${slug}" has no related[] cross-links`);
      }
      // Verify every related slug actually exists in the glossary.
      for (const r of parsed.related ?? []) {
        if (!allSlugs.has(r)) {
          logErr(
            file,
            `related slug "${r}" does not match any glossary entry`,
          );
        }
      }
      // Record seeAlso internal refs for resolver pass.
      for (const link of parsed.seeAlso ?? []) {
        if (link.href.startsWith("/")) recordInternalRef(file, link.href);
      }
      translationProgress.glossary.total += 1;
      for (const loc of TRACKED_TRANSLATION_LOCALES) {
        if (overlayKeys.glossary[loc].has(parsed.slug)) {
          translationProgress.glossary.byLocale[loc] += 1;
        }
      }
    } catch (e) {
      const msg = e instanceof z.ZodError ? e.message : String(e);
      logErr(file, `failed to parse: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Agents
// ---------------------------------------------------------------------------

async function auditAgents() {
  const dir = path.join(SRC_ROOT, "content", "agents");
  if (!fs.existsSync(dir)) return;
  const slugs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const { AgentMetaSchema } = await import(path.join(dir, "schema.ts"));

  for (const slug of slugs) {
    const metaFile = path.join(dir, slug, "meta.ts");
    if (!fs.existsSync(metaFile)) {
      logErr(metaFile, `missing meta.ts`);
      continue;
    }
    try {
      const mod = await import(metaFile);
      const raw = mod.default ?? mod.meta;
      const parsed = AgentMetaSchema.parse(raw);
      if (parsed.slug !== slug) {
        logErr(metaFile, `slug mismatch: directory "${slug}", meta declares "${parsed.slug}"`);
      }
      // Agents may ship MDX later (Phase 6b) — meta-only stubs are valid.
      // The /agents/{slug} sitemap entry is gated on MDX existence in
      // sitemap.ts; the audit is just structural.
      knownInternalRoutes.add(`/agents/${parsed.slug}`);
      checkFreshness(metaFile, parsed.lastUpdated);
      checkOgImage(metaFile, parsed.ogImage);
      for (const c of parsed.relatedComparisons) recordInternalRef(metaFile, `/vs/${c}`);
      for (const t of parsed.relatedTerms) recordInternalRef(metaFile, `/glossary/${t}`);

      translationProgress.agents.total += 1;
      for (const loc of TRACKED_TRANSLATION_LOCALES) {
        if (readOverlayKeys(loc, "agents").has(slug)) {
          translationProgress.agents.byLocale[loc] += 1;
        }
      }
    } catch (e) {
      const msg = e instanceof z.ZodError ? e.message : String(e);
      logErr(metaFile, `failed to parse: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 7. MCP
// ---------------------------------------------------------------------------

async function auditMcp() {
  const dir = path.join(SRC_ROOT, "content", "mcp");
  if (!fs.existsSync(dir)) return;
  const slugs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const { McpEntrySchema } = await import(path.join(dir, "schema.ts"));

  for (const slug of slugs) {
    const metaFile = path.join(dir, slug, "meta.ts");
    if (!fs.existsSync(metaFile)) {
      logErr(metaFile, `missing meta.ts`);
      continue;
    }
    try {
      const mod = await import(metaFile);
      const raw = mod.default ?? mod.meta;
      const parsed = McpEntrySchema.parse(raw);
      if (parsed.slug !== slug) {
        logErr(metaFile, `slug mismatch: directory "${slug}", meta declares "${parsed.slug}"`);
      }
      knownInternalRoutes.add(`/mcp/${parsed.slug}`);
      checkFreshness(metaFile, parsed.lastUpdated);
      checkOgImage(metaFile, parsed.ogImage);
      for (const c of parsed.relatedComparisons) recordInternalRef(metaFile, `/vs/${c}`);
      for (const a of parsed.relatedAgents) recordInternalRef(metaFile, `/agents/${a}`);
      for (const t of parsed.relatedTerms) recordInternalRef(metaFile, `/glossary/${t}`);

      translationProgress.mcp.total += 1;
      for (const loc of TRACKED_TRANSLATION_LOCALES) {
        if (readOverlayKeys(loc, "mcp").has(slug)) {
          translationProgress.mcp.byLocale[loc] += 1;
        }
      }
    } catch (e) {
      const msg = e instanceof z.ZodError ? e.message : String(e);
      logErr(metaFile, `failed to parse: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 8. MDX safety — no bare <lowercase-tag> in prose
// ---------------------------------------------------------------------------

// MDX 3 parses `<branch>` in a paragraph as an opening JSX tag and fails the
// build with "Expected a closing tag". Standard HTML tags are accepted; custom
// lowercase tags (e.g., placeholders like <branch>, <slug>, <user>) break.
// Catch them at audit time so we never ship the failure mode again.
const SAFE_HTML_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "br",
  "code",
  "del",
  "details",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
  "var",
  "wbr",
]);

function checkMdxJsxSafety(file: string, raw: string) {
  // Strip fenced code blocks first (```...```), then inline code spans (`...`).
  // Only what remains is "prose" the MDX parser would interpret as JSX.
  let stripped = raw.replace(/```[\s\S]*?```/g, "");
  stripped = stripped.replace(/`[^`\n]+`/g, "");
  // Strip autolinks (<https://...>, <name@example.com>) — MDX accepts these.
  stripped = stripped.replace(/<[a-z]+:\/\/[^>]+>/gi, "");
  stripped = stripped.replace(/<[^@\s<>]+@[^@\s<>]+>/g, "");

  // 1. <lowercase-tag> openers MDX would try to parse as unknown JSX.
  const tagRe = /<([a-z][a-z0-9-]*)\b[^>]*\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(stripped)) !== null) {
    const tag = match[1];
    if (SAFE_HTML_TAGS.has(tag)) continue;
    const lineNumber =
      stripped.slice(0, match.index).split("\n").length;
    logErr(
      file,
      `line ${lineNumber}: <${tag}> in MDX prose will be parsed as JSX and break the build. Wrap in backticks or use HTML entities (e.g., \`<${tag}>\` or &lt;${tag}&gt;).`,
    );
  }

  // 2. JSX attribute values with nested unescaped double quotes:
  //   <Component title="say "hi" to him"> — the inner pair terminates the
  //   attribute and MDX errors on the following identifier. The tell is a
  //   closing quote followed immediately by a letter (no space) inside the
  //   attribute chunk: `"to "test` rather than `"to " test`. Excluding `=`
  //   from the content prevents false positives on adjacent attribute pairs
  //   (`"info" title="A` — that's two separate attrs, not nesting).
  const jsxOpenRe = /<[A-Z][A-Za-z0-9]*((?:\s+[^>]*?)?)\/?>/g;
  const nestedQuoteRe = /"[^"\n=]*"[A-Za-z]/;
  while ((match = jsxOpenRe.exec(stripped)) !== null) {
    // Strip `{...}` JSX expressions before scanning — strings inside an
    // expression (`rows={[{ tier: "Hobby" }]}`) are JS, not JSX attributes,
    // and would otherwise create false positives.
    const attrChunk = stripBraceExpressions(match[1] ?? "");
    if (nestedQuoteRe.test(attrChunk)) {
      const lineNumber =
        stripped.slice(0, match.index).split("\n").length;
      logErr(
        file,
        `line ${lineNumber}: JSX tag has nested unescaped double-quotes inside an attribute (closing \`"\` followed by a letter). Use single quotes inside, &quot;, or rephrase. (Tag: ${match[0].slice(0, 80)}...)`,
      );
    }
  }
}

// Drop {...} JSX expression bodies (and their nested braces) so quote-pair
// scanning only sees actual string-attribute content. Naive non-nested-aware
// regexes would mis-handle `rows={[{ a: "b" }]}`.
function stripBraceExpressions(input: string): string {
  let out = "";
  let depth = 0;
  for (const ch of input) {
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) out += ch;
  }
  return out;
}

function walkMdxFiles(root: string, out: string[]) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkMdxFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
      out.push(full);
    }
  }
}

async function auditMdx() {
  const contentRoot = path.join(SRC_ROOT, "content");
  const files: string[] = [];
  walkMdxFiles(contentRoot, files);
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf-8");
    checkMdxJsxSafety(file, raw);
  }
}

// ---------------------------------------------------------------------------
// 9. Authors
// ---------------------------------------------------------------------------

async function auditAuthors() {
  const dir = path.join(SRC_ROOT, "content", "authors");
  if (!fs.existsSync(dir)) return;
  const RESERVED = new Set(["schema", "loader", "index"]);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !RESERVED.has(f.replace(/\.ts$/, "")));

  const { AuthorSchema } = await import(path.join(dir, "schema.ts"));

  for (const f of files) {
    const file = path.join(dir, f);
    const handle = f.replace(/\.ts$/, "");
    try {
      const mod = await import(file);
      const raw = mod.default ?? mod.author;
      const parsed = AuthorSchema.parse(raw);
      if (parsed.handle !== handle) {
        logErr(file, `handle mismatch: file is "${handle}.ts", data declares "${parsed.handle}"`);
      }
      if (parsed.avatar) {
        const fsPath = path.join(PUBLIC_ROOT, parsed.avatar.replace(/^\//, ""));
        if (!fs.existsSync(fsPath)) {
          logWarn(file, `avatar "${parsed.avatar}" not found at ${path.relative(APP_ROOT, fsPath)}`);
        }
      }
    } catch (e) {
      const msg = e instanceof z.ZodError ? e.message : String(e);
      logErr(file, `failed to parse: ${msg}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Internal-link resolution
// ---------------------------------------------------------------------------

async function auditInternalLinks() {
  const STATIC_PREFIXES = [
    "/",
    "/pricing",
    "/faq",
    "/blog",
    "/vs",
    "/solutions",
    "/concepts",
    "/glossary",
    "/agents",
    "/mcp",
    "/prompt-engineering",
    "/privacy",
    "/terms",
    "/signup",
    "/sign-up",
    "/sign-in",
  ];

  for (const ref of internalRefs) {
    if (knownInternalRoutes.has(ref.href)) continue;
    if (STATIC_PREFIXES.includes(ref.href)) continue;
    if (
      ref.href.startsWith("/blog/tag/") ||
      ref.href.startsWith("/sign-up") ||
      ref.href.startsWith("/sign-in")
    ) {
      continue;
    }
    // Slug-based links must resolve to a known route.
    if (
      ref.href.startsWith("/vs/") ||
      ref.href.startsWith("/solutions/") ||
      ref.href.startsWith("/concepts/") ||
      ref.href.startsWith("/glossary/") ||
      ref.href.startsWith("/agents/") ||
      ref.href.startsWith("/mcp/")
    ) {
      logErr(
        ref.file,
        `internal link "${ref.href}" does not resolve to a known route`,
      );
      continue;
    }
    // Anything else falls back to a static prefix or warn.
    logWarn(
      ref.file,
      `internal link "${ref.href}" not in known set — verify route exists`,
    );
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 10. Indexable-locale completeness — see locale-completeness invariant at
//     the top of this file. Warns when a locale is in
//     INDEXABLE_LOCALES_BY_SURFACE.web but lacks the foundation messages
//     tree, which would let static-route hreflang point at fallback-EN
//     pages.
// ---------------------------------------------------------------------------

async function auditIndexableLocaleCompleteness() {
  // Late dynamic import keeps the rest of the audit working if the
  // workspace topology changes; the audit itself doesn't depend on i18n.
  const { INDEXABLE_LOCALES_BY_SURFACE } = await import(
    "@ellul.ai/i18n-consts/indexability"
  );
  const FOUNDATION_NAMESPACES = ["home", "pricing", "faq"] as const;

  for (const locale of INDEXABLE_LOCALES_BY_SURFACE.web) {
    if (locale === "en") continue;
    const localeDir = path.join(I18N_MESSAGES_ROOT, locale);
    if (!fs.existsSync(localeDir)) {
      logWarn(
        path.join(I18N_MESSAGES_ROOT, locale),
        `locale "${locale}" is indexable but messages/${locale}/ does not exist — static-route hreflang will point at /${locale}/* URLs that render in fallback English. Either ship translations or remove ${locale} from INDEXABLE_LOCALES_BY_SURFACE.web.`,
      );
      continue;
    }
    const missing = FOUNDATION_NAMESPACES.filter(
      (ns) => !fs.existsSync(path.join(localeDir, `${ns}.json`)),
    );
    if (missing.length) {
      logWarn(
        localeDir,
        `locale "${locale}" is indexable but missing foundation namespaces: ${missing.join(", ")}. Static-route hreflang will emit anyway; ship translations before launch or revert the indexability flip.`,
      );
    }
  }
}

async function main() {
  await auditComparisons();
  await auditUseCases();
  await auditBlog();
  await auditPillars();
  await auditGlossary();
  await auditAgents();
  await auditMcp();
  await auditMdx();
  await auditAuthors();
  await auditInternalLinks();
  await auditIndexableLocaleCompleteness();

  if (result.warnings.length) {
    console.warn("\nWarnings:");
    for (const w of result.warnings) console.warn(`  ${w}`);
  }
  if (result.errors.length) {
    console.error("\nErrors:");
    for (const e of result.errors) console.error(`  ${e}`);
    console.error(
      `\nContent audit FAILED: ${result.errors.length} error(s), ${result.warnings.length} warning(s).`,
    );
    process.exit(1);
  }
  console.log(
    `\nContent audit OK. ${result.warnings.length} warning(s).`,
  );
  const count = (prefix: string) =>
    [...knownInternalRoutes].filter((r) => r.startsWith(prefix)).length;
  console.log(`  Comparisons: ${count("/vs/")}`);
  console.log(`  Use-cases:   ${count("/solutions/")}`);
  console.log(`  Pillars:     ${count("/concepts/")}`);
  console.log(`  Glossary:    ${count("/glossary/")}`);
  console.log(`  Agents:      ${count("/agents/")}`);
  console.log(`  MCP:         ${count("/mcp/")}`);
  console.log(`  Blog posts:  ${count("/blog/")}`);

  // Translation progress (warns only — partial coverage is a normal in-flight
  // state during a locale rollout). The locale doesn't go live in indexability
  // until parity hits 100% and native QA passes.
  console.log("\nTranslation progress:");
  const surfaces = [
    "glossary",
    "pillars",
    "pillarsMdx",
    "comparisons",
    "useCases",
    "agents",
    "mcp",
    "blog",
    "blogMdx",
  ] as const;
  for (const surface of surfaces) {
    const p = translationProgress[surface];
    if (!p || p.total === 0) continue;
    const parts: string[] = [];
    for (const loc of TRACKED_TRANSLATION_LOCALES) {
      const n = p.byLocale[loc];
      const pct = Math.round((n / p.total) * 100);
      parts.push(`${loc}: ${n}/${p.total} (${pct}%)`);
    }
    console.log(`  ${surface.padEnd(13)} ${parts.join("  ·  ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
