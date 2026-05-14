import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LOCALE, type Locale } from "@ellul.ai/i18n-consts";
import { createOverlayResolver } from "@/lib/content-overlay";
import {
  GlossaryTermSchema,
  type GlossaryTerm,
  type GlossaryTermStructural,
} from "./schema";

const GLOSSARY_ROOT = path.join(
  process.cwd(),
  "src",
  "content",
  "glossary",
);

const RESERVED = new Set(["schema", "loader", "index"]);

export function listGlossarySlugs(): string[] {
  if (!fs.existsSync(GLOSSARY_ROOT)) return [];
  return fs
    .readdirSync(GLOSSARY_ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => e.name.replace(/\.ts$/, ""))
    .filter((slug) => !RESERVED.has(slug));
}

const structuralCache = new Map<string, GlossaryTermStructural>();

async function loadStructural(
  slug: string,
): Promise<GlossaryTermStructural | null> {
  if (structuralCache.has(slug)) return structuralCache.get(slug)!;
  if (RESERVED.has(slug)) return null;
  const filePath = path.join(GLOSSARY_ROOT, `${slug}.ts`);
  if (!fs.existsSync(filePath)) return null;
  const mod = await import(`./${slug}.ts`);
  const raw = (mod.default ?? mod.term) as unknown;
  const parsed = GlossaryTermSchema.parse(raw);
  if (parsed.slug !== slug) {
    throw new Error(
      `Glossary term slug mismatch: ${slug}.ts declares "${parsed.slug}"`,
    );
  }
  structuralCache.set(slug, parsed);
  return parsed;
}

interface GlossaryOverlayEntry {
  term: string;
  definition: string;
  context?: string;
  synonyms?: string[];
  seeAlso?: Record<string, string>;
}

const overlay = createOverlayResolver<GlossaryOverlayEntry>("glossary");

function compose(
  structural: GlossaryTermStructural,
  entry: GlossaryOverlayEntry,
): GlossaryTerm {
  const seeAlso = structural.seeAlso.map((sa) => {
    const label = entry.seeAlso?.[sa.id];
    if (label === undefined) {
      throw new Error(
        `Glossary "${structural.slug}" seeAlso["${sa.id}"] missing label in overlay. ` +
          `Add it under glossary.${structural.slug}.seeAlso["${sa.id}"] in messages/{locale}/glossary.json.`,
      );
    }
    return { id: sa.id, href: sa.href, label };
  });
  return {
    ...structural,
    term: entry.term,
    definition: entry.definition,
    context: entry.context,
    synonyms: entry.synonyms ?? [],
    seeAlso,
  };
}

export async function getGlossaryTerm(
  slug: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<GlossaryTerm | null> {
  const structural = await loadStructural(slug);
  if (!structural) return null;
  const entry = await overlay.resolve(slug, locale);
  if (!entry) {
    throw new Error(
      `Glossary slug "${slug}" has no entry in messages/${DEFAULT_LOCALE}/glossary.json — every glossary slug must have a translatable-strings entry.`,
    );
  }
  return compose(structural, entry);
}

export async function getAllGlossaryTerms(
  locale: Locale = DEFAULT_LOCALE,
): Promise<GlossaryTerm[]> {
  const slugs = listGlossarySlugs();
  const out: GlossaryTerm[] = [];
  for (const slug of slugs) {
    const term = await getGlossaryTerm(slug, locale);
    if (term) out.push(term);
  }
  return out.sort((a, b) => a.term.localeCompare(b.term));
}

export async function getGlossaryAvailableLocales(
  slug: string,
): Promise<Locale[]> {
  const out: Locale[] = [DEFAULT_LOCALE];
  for (const candidate of ["ja"] as Locale[]) {
    const ns = await overlay.load(candidate);
    if (ns[slug]) out.push(candidate);
  }
  return out;
}
