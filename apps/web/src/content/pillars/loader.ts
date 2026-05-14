import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  ALL_LOCALES,
  DEFAULT_LOCALE,
  type Locale,
} from "@ellul.ai/i18n-consts";
import { createOverlayResolver } from "@/lib/content-overlay";
import {
  PillarMetaSchema,
  type PillarMeta,
  type PillarMetaStructural,
} from "./schema";

const PILLARS_ROOT = path.join(process.cwd(), "src", "content", "pillars");

export interface Pillar {
  meta: PillarMeta;
  content: string;
  loadedLocale: Locale;
  availableLocales: Locale[];
}

function dir(slug: string): string {
  return path.join(PILLARS_ROOT, slug);
}

function metaPath(slug: string): string {
  return path.join(dir(slug), "meta.ts");
}

function mdxPath(slug: string, locale: Locale): string {
  return path.join(dir(slug), `${locale}.mdx`);
}

export function listPillarSlugs(): string[] {
  if (!fs.existsSync(PILLARS_ROOT)) return [];
  return fs
    .readdirSync(PILLARS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(metaPath(e.name)))
    .map((e) => e.name);
}

export function getAvailableLocales(slug: string): Locale[] {
  return ALL_LOCALES.filter((locale) => fs.existsSync(mdxPath(slug, locale)));
}

const structuralCache = new Map<string, PillarMetaStructural>();

async function loadStructural(
  slug: string,
): Promise<PillarMetaStructural | null> {
  if (structuralCache.has(slug)) return structuralCache.get(slug)!;
  if (!fs.existsSync(metaPath(slug))) return null;
  const mod = await import(`./${slug}/meta.ts`);
  const raw = (mod.default ?? mod.meta) as unknown;
  const parsed = PillarMetaSchema.parse(raw);
  if (parsed.slug !== slug) {
    throw new Error(
      `Pillar slug mismatch: ${slug}/meta.ts declares "${parsed.slug}"`,
    );
  }
  structuralCache.set(slug, parsed);
  return parsed;
}

interface PillarOverlayEntry {
  title: string;
  description: string;
  hero: { eyebrow: string; headline: string; sub: string };
  cta: { label: string };
  keyword: string;
  faq: Record<string, { q: string; a: string }>;
}

const overlay = createOverlayResolver<PillarOverlayEntry>("pillars");

function compose(
  structural: PillarMetaStructural,
  entry: PillarOverlayEntry,
): PillarMeta {
  const faq = Object.entries(entry.faq).map(([id, f]) => ({
    id,
    q: f.q,
    a: f.a,
  }));
  return {
    ...structural,
    title: entry.title,
    description: entry.description,
    hero: entry.hero,
    cta: { label: entry.cta.label, href: structural.cta.href },
    keyword: entry.keyword,
    faq,
  };
}

export async function getPillarMeta(
  slug: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<PillarMeta | null> {
  const structural = await loadStructural(slug);
  if (!structural) return null;
  const entry = await overlay.resolve(slug, locale);
  if (!entry) {
    throw new Error(
      `Pillar slug "${slug}" has no entry in messages/${DEFAULT_LOCALE}/pillars.json`,
    );
  }
  return compose(structural, entry);
}

export async function getPillar(
  slug: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<Pillar | null> {
  const meta = await getPillarMeta(slug, locale);
  if (!meta) return null;

  const localized = mdxPath(slug, locale);
  const fallback = mdxPath(slug, DEFAULT_LOCALE);
  const filePath = fs.existsSync(localized) ? localized : fallback;
  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, "utf-8");
  const { content } = matter(raw);

  return {
    meta,
    content,
    loadedLocale: filePath === localized ? locale : DEFAULT_LOCALE,
    availableLocales: getAvailableLocales(slug),
  };
}

export async function getAllPillars(
  locale: Locale = DEFAULT_LOCALE,
): Promise<PillarMeta[]> {
  const slugs = listPillarSlugs();
  const out: PillarMeta[] = [];
  for (const slug of slugs) {
    const meta = await getPillarMeta(slug, locale);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.slug.localeCompare(b.slug);
  });
}

// Locales for which this pillar's meta is translated via the i18n-messages
// overlay. Sitemap intersects this with mdx-presence to gate hreflang
// alternates (both meta + body must exist for the locale to render).
export async function getMetaTranslatedLocales(
  slug: string,
): Promise<Locale[]> {
  const out: Locale[] = [DEFAULT_LOCALE];
  for (const candidate of ["ja"] as Locale[]) {
    const ns = await overlay.load(candidate);
    if (ns[slug]) out.push(candidate);
  }
  return out;
}
