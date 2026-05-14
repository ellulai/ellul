import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LOCALE, type Locale } from "@ellul.ai/i18n-consts";
import { createOverlayResolver } from "@/lib/content-overlay";
import {
  ComparisonDataSchema,
  type ComparisonData,
  type ComparisonDataStructural,
  type FeatureRow,
  type PricingRow,
  type FaqItem,
  type WhenToUseItem,
} from "./schema";

const COMPARISONS_ROOT = path.join(
  process.cwd(),
  "src",
  "content",
  "comparisons",
);

const RESERVED = new Set(["schema", "loader", "index"]);

export function listComparisonSlugs(): string[] {
  if (!fs.existsSync(COMPARISONS_ROOT)) return [];
  return fs
    .readdirSync(COMPARISONS_ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => e.name.replace(/\.ts$/, ""))
    .filter((slug) => !RESERVED.has(slug));
}

const structuralCache = new Map<string, ComparisonDataStructural>();

async function loadStructural(
  slug: string,
): Promise<ComparisonDataStructural | null> {
  if (structuralCache.has(slug)) return structuralCache.get(slug)!;
  if (RESERVED.has(slug)) return null;
  const filePath = path.join(COMPARISONS_ROOT, `${slug}.ts`);
  if (!fs.existsSync(filePath)) return null;
  const mod = await import(`./${slug}.ts`);
  const raw = (mod.default ?? mod.comparison) as unknown;
  const parsed = ComparisonDataSchema.parse(raw);
  if (parsed.slug !== slug) {
    throw new Error(
      `Comparison slug mismatch: file ${slug}.ts declares slug "${parsed.slug}"`,
    );
  }
  structuralCache.set(slug, parsed);
  return parsed;
}

interface FeatureCellOverlay {
  capability: string;
  ellul?: string;
  competitor?: string;
  note?: string;
}

interface PricingCellOverlay {
  tier: string;
  ellul: string;
  competitor: string;
  note?: string;
}

interface ComparisonOverlayEntry {
  competitor: { tagline: string };
  meta: { title: string; description: string };
  hero: { eyebrow: string; headline: string; sub: string };
  ellulPitch: string;
  competitorPitch: string;
  fundamentalDifference: string;
  features: Record<string, FeatureCellOverlay>;
  pricing: Record<string, PricingCellOverlay>;
  verdict: { headline: string; body: string };
  whenToUseCompetitor: Record<string, string>;
  whenToUseEllul: Record<string, string>;
  faq: Record<string, { q: string; a: string }>;
}

const overlay = createOverlayResolver<ComparisonOverlayEntry>("comparisons");

function compose(
  structural: ComparisonDataStructural,
  entry: ComparisonOverlayEntry,
): ComparisonData {
  const features: FeatureRow[] = structural.features.map((row) => {
    const cell = entry.features[row.id];
    if (!cell) {
      throw new Error(
        `Comparison "${structural.slug}" features["${row.id}"] missing in overlay. ` +
          `Add it to messages/{locale}/comparisons.json under comparisons.${structural.slug}.features.`,
      );
    }
    return {
      id: row.id,
      capability: cell.capability,
      ellul:
        typeof row.ellul === "boolean" ? row.ellul : (cell.ellul ?? ""),
      competitor:
        typeof row.competitor === "boolean"
          ? row.competitor
          : (cell.competitor ?? ""),
      note: cell.note,
      advantage: row.advantage,
    };
  });

  const pricing: PricingRow[] = Object.entries(entry.pricing).map(
    ([id, p]) => ({
      id,
      tier: p.tier,
      ellul: p.ellul,
      competitor: p.competitor,
      note: p.note,
    }),
  );

  const faq: FaqItem[] = Object.entries(entry.faq).map(([id, f]) => ({
    id,
    q: f.q,
    a: f.a,
  }));

  const whenToUseCompetitor: WhenToUseItem[] = Object.entries(
    entry.whenToUseCompetitor,
  ).map(([id, text]) => ({ id, text }));

  const whenToUseEllul: WhenToUseItem[] = Object.entries(
    entry.whenToUseEllul,
  ).map(([id, text]) => ({ id, text }));

  return {
    slug: structural.slug,
    competitor: {
      name: structural.competitor.name,
      domain: structural.competitor.domain,
      url: structural.competitor.url,
      tagline: entry.competitor.tagline,
    },
    meta: { title: entry.meta.title, description: entry.meta.description },
    hero: entry.hero,
    ellulPitch: entry.ellulPitch,
    competitorPitch: entry.competitorPitch,
    fundamentalDifference: entry.fundamentalDifference,
    features,
    pricing,
    verdict: entry.verdict,
    whenToUseCompetitor,
    whenToUseEllul,
    faq,
    tags: structural.tags,
    publishedAt: structural.publishedAt,
    lastUpdated: structural.lastUpdated,
    ogImage: structural.ogImage,
    relatedUseCases: structural.relatedUseCases,
    sources: structural.sources,
  };
}

export async function getComparison(
  slug: string,
  locale: Locale = DEFAULT_LOCALE,
): Promise<ComparisonData | null> {
  const structural = await loadStructural(slug);
  if (!structural) return null;
  const entry = await overlay.resolve(slug, locale);
  if (!entry) {
    throw new Error(
      `Comparison slug "${slug}" has no entry in messages/${DEFAULT_LOCALE}/comparisons.json`,
    );
  }
  return compose(structural, entry);
}

export async function getAllComparisons(
  locale: Locale = DEFAULT_LOCALE,
): Promise<ComparisonData[]> {
  const slugs = listComparisonSlugs();
  const out: ComparisonData[] = [];
  for (const slug of slugs) {
    const c = await getComparison(slug, locale);
    if (c) out.push(c);
  }
  return out.sort(
    (a, b) =>
      new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime(),
  );
}

export async function getComparisonAvailableLocales(
  slug: string,
): Promise<Locale[]> {
  const out: Locale[] = [DEFAULT_LOCALE];
  for (const candidate of ["ja"] as Locale[]) {
    const ns = await overlay.load(candidate);
    if (ns[slug]) out.push(candidate);
  }
  return out;
}
