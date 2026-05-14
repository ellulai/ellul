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
  AgentMetaSchema,
  type AgentMeta,
  type AgentMetaStructural,
} from "./schema";

const AGENTS_ROOT = path.join(process.cwd(), "src", "content", "agents");

export interface Agent {
  meta: AgentMeta;
  content: string;
  loadedLocale: Locale;
  availableLocales: Locale[];
}

function dir(slug: string): string {
  return path.join(AGENTS_ROOT, slug);
}

function metaPath(slug: string): string {
  return path.join(dir(slug), "meta.ts");
}

function mdxPath(slug: string, locale: Locale): string {
  return path.join(dir(slug), `${locale}.mdx`);
}

export function listAgentSlugs(): string[] {
  if (!fs.existsSync(AGENTS_ROOT)) return [];
  return fs
    .readdirSync(AGENTS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(metaPath(e.name)))
    .map((e) => e.name);
}

export function listAgentSlugsWithMdx(): string[] {
  return listAgentSlugs().filter((slug) =>
    fs.existsSync(mdxPath(slug, DEFAULT_LOCALE)),
  );
}

export function hasAgentMdx(slug: string, locale: Locale = DEFAULT_LOCALE): boolean {
  return fs.existsSync(mdxPath(slug, locale));
}

export function getAvailableLocales(slug: string): Locale[] {
  return ALL_LOCALES.filter((locale) => fs.existsSync(mdxPath(slug, locale)));
}

const structuralCache = new Map<string, AgentMetaStructural>();

async function loadStructural(
  slug: string,
): Promise<AgentMetaStructural | null> {
  if (structuralCache.has(slug)) return structuralCache.get(slug)!;
  if (!fs.existsSync(metaPath(slug))) return null;
  const mod = await import(`./${slug}/meta.ts`);
  const raw = (mod.default ?? mod.meta) as unknown;
  const parsed = AgentMetaSchema.parse(raw);
  if (parsed.slug !== slug) {
    throw new Error(
      `Agent slug mismatch: ${slug}/meta.ts declares "${parsed.slug}"`,
    );
  }
  structuralCache.set(slug, parsed);
  return parsed;
}

interface AgentOverlayEntry {
  name: string;
  description: string;
  hero: { eyebrow: string; headline: string; sub: string };
  supportedFeatures: string[];
  pricingNote: string;
  faq: Record<string, { q: string; a: string }>;
}

const overlay = createOverlayResolver<AgentOverlayEntry>("agents");

function compose(
  structural: AgentMetaStructural,
  overlay: AgentOverlayEntry,
): AgentMeta {
  const faq = Object.entries(overlay.faq).map(([id, f]) => ({
    id,
    q: f.q,
    a: f.a,
  }));
  return {
    ...structural,
    name: overlay.name,
    description: overlay.description,
    hero: overlay.hero,
    supportedFeatures: overlay.supportedFeatures,
    pricingNote: overlay.pricingNote,
    faq,
  };
}

export async function getAgentMeta(
  slug: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<AgentMeta | null> {
  const structural = await loadStructural(slug);
  if (!structural) return null;
  const entry = await overlay.resolve(slug, locale);
  if (!entry) {
    throw new Error(
      `Agent slug "${slug}" has no entry in messages/${DEFAULT_LOCALE}/agents.json`,
    );
  }
  return compose(structural, entry);
}

export async function getAgent(
  slug: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<Agent | null> {
  const meta = await getAgentMeta(slug, locale);
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

export async function getAllAgentMetas(
  locale: Locale = DEFAULT_LOCALE,
): Promise<AgentMeta[]> {
  const slugs = listAgentSlugs();
  const out: AgentMeta[] = [];
  for (const slug of slugs) {
    const meta = await getAgentMeta(slug, locale);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
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
