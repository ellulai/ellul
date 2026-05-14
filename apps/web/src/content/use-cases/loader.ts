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
  UseCaseMetaSchema,
  type UseCaseMeta,
  type UseCaseMetaStructural,
} from "./schema";

const USE_CASES_ROOT = path.join(
  process.cwd(),
  "src",
  "content",
  "use-cases",
);

export interface UseCase {
  meta: UseCaseMeta;
  content: string;
  loadedLocale: Locale;
  availableLocales: Locale[];
}

function dir(slug: string): string {
  return path.join(USE_CASES_ROOT, slug);
}

function metaPath(slug: string): string {
  return path.join(dir(slug), "meta.ts");
}

function mdxPath(slug: string, locale: Locale): string {
  return path.join(dir(slug), `${locale}.mdx`);
}

export function listUseCaseSlugs(): string[] {
  if (!fs.existsSync(USE_CASES_ROOT)) return [];
  return fs
    .readdirSync(USE_CASES_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(metaPath(e.name)))
    .map((e) => e.name);
}

export function getAvailableLocales(slug: string): Locale[] {
  return ALL_LOCALES.filter((locale) => fs.existsSync(mdxPath(slug, locale)));
}

const structuralCache = new Map<string, UseCaseMetaStructural>();

async function loadStructural(
  slug: string,
): Promise<UseCaseMetaStructural | null> {
  if (structuralCache.has(slug)) return structuralCache.get(slug)!;
  if (!fs.existsSync(metaPath(slug))) return null;
  const mod = await import(`./${slug}/meta.ts`);
  const raw = (mod.default ?? mod.meta) as unknown;
  const parsed = UseCaseMetaSchema.parse(raw);
  if (parsed.slug !== slug) {
    throw new Error(
      `Use-case slug mismatch: ${slug}/meta.ts declares slug "${parsed.slug}"`,
    );
  }
  structuralCache.set(slug, parsed);
  return parsed;
}

interface UseCaseOverlayEntry {
  title: string;
  description: string;
  hero: { eyebrow: string; headline: string; sub: string };
  cta: { label: string };
  faq: Record<string, { q: string; a: string }>;
}

const overlay = createOverlayResolver<UseCaseOverlayEntry>("useCases");

function compose(
  structural: UseCaseMetaStructural,
  entry: UseCaseOverlayEntry,
): UseCaseMeta {
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
    faq,
  };
}

export async function getUseCaseMeta(
  slug: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<UseCaseMeta | null> {
  const structural = await loadStructural(slug);
  if (!structural) return null;
  const entry = await overlay.resolve(slug, locale);
  if (!entry) {
    throw new Error(
      `Use-case slug "${slug}" has no entry in messages/${DEFAULT_LOCALE}/use-cases.json`,
    );
  }
  return compose(structural, entry);
}

export async function getUseCase(
  slug: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<UseCase | null> {
  const meta = await getUseCaseMeta(slug, locale);
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

export async function getAllUseCases(
  locale: Locale = DEFAULT_LOCALE,
): Promise<UseCaseMeta[]> {
  const slugs = listUseCaseSlugs();
  const out: UseCaseMeta[] = [];
  for (const slug of slugs) {
    const meta = await getUseCaseMeta(slug, locale);
    if (meta) out.push(meta);
  }
  return out.sort(
    (a, b) =>
      new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
  );
}

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
