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
  McpEntrySchema,
  type McpEntry,
  type McpEntryStructural,
} from "./schema";

const MCP_ROOT = path.join(process.cwd(), "src", "content", "mcp");

export interface McpDoc {
  meta: McpEntry;
  content: string;
  loadedLocale: Locale;
  availableLocales: Locale[];
}

function dir(slug: string): string {
  return path.join(MCP_ROOT, slug);
}

function metaPath(slug: string): string {
  return path.join(dir(slug), "meta.ts");
}

function mdxPath(slug: string, locale: Locale): string {
  return path.join(dir(slug), `${locale}.mdx`);
}

export function listMcpSlugs(): string[] {
  if (!fs.existsSync(MCP_ROOT)) return [];
  return fs
    .readdirSync(MCP_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(metaPath(e.name)))
    .map((e) => e.name);
}

export function listMcpSlugsWithMdx(): string[] {
  return listMcpSlugs().filter((slug) =>
    fs.existsSync(mdxPath(slug, DEFAULT_LOCALE)),
  );
}

export function hasMcpMdx(slug: string, locale: Locale = DEFAULT_LOCALE): boolean {
  return fs.existsSync(mdxPath(slug, locale));
}

export function getAvailableLocales(slug: string): Locale[] {
  return ALL_LOCALES.filter((locale) => fs.existsSync(mdxPath(slug, locale)));
}

const structuralCache = new Map<string, McpEntryStructural>();

async function loadStructural(
  slug: string,
): Promise<McpEntryStructural | null> {
  if (structuralCache.has(slug)) return structuralCache.get(slug)!;
  if (!fs.existsSync(metaPath(slug))) return null;
  const mod = await import(`./${slug}/meta.ts`);
  const raw = (mod.default ?? mod.meta) as unknown;
  const parsed = McpEntrySchema.parse(raw);
  if (parsed.slug !== slug) {
    throw new Error(
      `MCP slug mismatch: ${slug}/meta.ts declares "${parsed.slug}"`,
    );
  }
  structuralCache.set(slug, parsed);
  return parsed;
}

interface McpOverlayEntry {
  name: string;
  description: string;
  hero: { eyebrow: string; headline: string; sub: string };
  capabilities: string[];
  faq: Record<string, { q: string; a: string }>;
}

const overlay = createOverlayResolver<McpOverlayEntry>("mcp");

function compose(
  structural: McpEntryStructural,
  entry: McpOverlayEntry,
): McpEntry {
  const faq = Object.entries(entry.faq).map(([id, f]) => ({
    id,
    q: f.q,
    a: f.a,
  }));
  return {
    ...structural,
    name: entry.name,
    description: entry.description,
    hero: entry.hero,
    capabilities: entry.capabilities,
    faq,
  };
}

export async function getMcpMeta(
  slug: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<McpEntry | null> {
  const structural = await loadStructural(slug);
  if (!structural) return null;
  const entry = await overlay.resolve(slug, locale);
  if (!entry) {
    throw new Error(
      `MCP slug "${slug}" has no entry in messages/${DEFAULT_LOCALE}/mcp.json`,
    );
  }
  return compose(structural, entry);
}

export async function getMcpDoc(
  slug: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<McpDoc | null> {
  const meta = await getMcpMeta(slug, locale);
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

export async function getAllMcpMetas(
  locale: Locale = DEFAULT_LOCALE,
): Promise<McpEntry[]> {
  const slugs = listMcpSlugs();
  const out: McpEntry[] = [];
  for (const slug of slugs) {
    const meta = await getMcpMeta(slug, locale);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => {
    if (a.kind === "hub" && b.kind !== "hub") return -1;
    if (b.kind === "hub" && a.kind !== "hub") return 1;
    return a.name.localeCompare(b.name);
  });
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
