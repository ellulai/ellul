import { z } from "zod";

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Structural fields validated by Zod for the TS meta.ts file. All
// human-readable strings (title, description, hero, cta.label, keyword,
// faq) live in `packages/i18n-messages/messages/{locale}/pillars.json`
// and are composed in by the loader at request time.
export const PillarMetaSchema = z.object({
  slug: z.string().regex(slugRegex, "slug must be lowercase, hyphenated"),
  // cta.label is translatable; cta.href is structural.
  cta: z.object({ href: z.string().min(1) }),
  ogImage: z.string().startsWith("/").optional(),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lastUpdated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // 1 = top-priority cornerstone (homepage internal-links here);
  // 2 = secondary cornerstone (linked from category pages, not homepage).
  priority: z.union([z.literal(1), z.literal(2)]).default(1),
  structuredDataType: z.enum(["Article", "HowTo"]).default("Article"),
  tags: z.array(z.string().min(1)).default([]),
  relatedComparisons: z.array(z.string().regex(slugRegex)).default([]),
  relatedUseCases: z.array(z.string().regex(slugRegex)).default([]),
  relatedTerms: z.array(z.string().regex(slugRegex)).default([]),
});

// What the meta.ts data file declares (structural-only).
export type PillarMetaStructural = z.infer<typeof PillarMetaSchema>;
export type PillarMetaStructuralInput = z.input<typeof PillarMetaSchema>;

// Composed runtime type the loader returns.
export interface PillarMeta extends PillarMetaStructural {
  title: string;
  description: string;
  hero: { eyebrow: string; headline: string; sub: string };
  cta: { label: string; href: string };
  keyword: string;
  faq: { id: string; q: string; a: string }[];
}

export function definePillar(
  input: PillarMetaStructuralInput,
): PillarMetaStructural {
  return PillarMetaSchema.parse(input);
}
