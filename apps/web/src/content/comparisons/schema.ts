import { z } from "zod";

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Each feature row carries a stable `id` so the TS structural rows align
// with the i18n-messages overlay even after re-ordering. The id makes the
// row's context visible at a glance: `{ id: "where-agent-runs", advantage: "ellul" }`
// reads as a self-describing fact about the comparison rather than a bare
// advantage marker.
export const FeatureRowSchema = z.object({
  id: z.string().regex(slugRegex, "id must be lowercase, hyphenated"),
  // Boolean cells are structural (yes/no markers like "Survives lid close").
  // Rows whose cells are sentences-of-text omit these and supply the strings
  // through the i18n-messages overlay keyed by the same id.
  ellul: z.boolean().optional(),
  competitor: z.boolean().optional(),
  advantage: z.enum(["ellul", "competitor", "tie"]).optional(),
});

export const ComparisonDataSchema = z.object({
  slug: z.string().regex(slugRegex, "slug must be lowercase, hyphenated"),
  competitor: z.object({
    name: z.string().min(1),
    domain: z.string().min(1),
    url: z.string().url(),
  }),
  features: z.array(FeatureRowSchema).min(5),
  tags: z.array(z.string().min(1)).default([]),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date YYYY-MM-DD"),
  lastUpdated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date YYYY-MM-DD"),
  ogImage: z.string().startsWith("/").optional(),
  relatedUseCases: z.array(z.string().regex(slugRegex)).default([]),
  // Editorial-only research citations. Never rendered to the page; kept in
  // the data file so a reviewer can verify any factual claim against its
  // source. EN-only (sources are editorial provenance, not user-facing).
  sources: z
    .array(
      z.object({
        url: z.string().url(),
        claim: z.string().min(1).optional(),
      }),
    )
    .default([]),
});

export type ComparisonDataStructural = z.infer<typeof ComparisonDataSchema>;
export type ComparisonDataStructuralInput = z.input<typeof ComparisonDataSchema>;
export type FeatureRowStructural = z.infer<typeof FeatureRowSchema>;

// Composed runtime types: structural fields plus the locale's translatable
// strings. `id` flows through every row so consumers can reference rows
// stably (React keys, analytics, anchor links).
export interface FeatureRow {
  id: string;
  capability: string;
  ellul: boolean | string;
  competitor: boolean | string;
  note?: string;
  advantage?: "ellul" | "competitor" | "tie";
}

export interface PricingRow {
  id: string;
  tier: string;
  ellul: string;
  competitor: string;
  note?: string;
}

export interface FaqItem {
  id: string;
  q: string;
  a: string;
}

export interface WhenToUseItem {
  id: string;
  text: string;
}

export interface Verdict {
  headline: string;
  body: string;
}

export interface ComparisonData {
  slug: string;
  competitor: {
    name: string;
    domain: string;
    url: string;
    tagline: string;
  };
  meta: { title: string; description: string };
  hero: { eyebrow: string; headline: string; sub: string };
  ellulPitch: string;
  competitorPitch: string;
  fundamentalDifference: string;
  features: FeatureRow[];
  pricing: PricingRow[];
  verdict: Verdict;
  whenToUseCompetitor: WhenToUseItem[];
  whenToUseEllul: WhenToUseItem[];
  faq: FaqItem[];
  tags: string[];
  publishedAt: string;
  lastUpdated: string;
  ogImage?: string;
  relatedUseCases: string[];
  sources: { url: string; claim?: string }[];
}

export function defineComparison(
  input: ComparisonDataStructuralInput,
): ComparisonDataStructural {
  return ComparisonDataSchema.parse(input);
}

export function deriveAdvantage(
  row: FeatureRow,
): "ellul" | "competitor" | "tie" {
  if (row.advantage) return row.advantage;
  if (typeof row.ellul === "boolean" && typeof row.competitor === "boolean") {
    if (row.ellul && !row.competitor) return "ellul";
    if (row.competitor && !row.ellul) return "competitor";
    return "tie";
  }
  return "tie";
}
