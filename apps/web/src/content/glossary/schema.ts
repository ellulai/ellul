import { z } from "zod";

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Structural fields validated by Zod for the TS data file. All
// human-readable strings (term, definition, context, synonyms,
// seeAlso labels) live in `packages/i18n-messages/messages/{locale}/
// glossary.json` and are composed in by the loader at request time.
//
// `seeAlso` rows carry a stable `id` so the TS structural row aligns
// with the i18n-messages overlay by key, not by array index. Reordering
// rows is safe; missing/extra ids are caught by the composer.
export const GlossaryTermSchema = z.object({
  slug: z.string().regex(slugRegex, "slug must be lowercase, hyphenated"),
  related: z.array(z.string().regex(slugRegex)).default([]),
  seeAlso: z
    .array(
      z.object({
        id: z.string().regex(slugRegex, "seeAlso id must be lowercase, hyphenated"),
        href: z.string().min(1),
      }),
    )
    .default([]),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date YYYY-MM-DD"),
  lastUpdated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ISO date YYYY-MM-DD"),
  ogImage: z.string().startsWith("/").optional(),
});

export type GlossaryTermStructural = z.infer<typeof GlossaryTermSchema>;
export type GlossaryTermStructuralInput = z.input<typeof GlossaryTermSchema>;

// Composed runtime type the loader returns: structural fields plus the
// locale's translatable strings, with seeAlso[].label paired into the
// structural href by id.
export interface GlossaryTerm extends GlossaryTermStructural {
  term: string;
  definition: string;
  context?: string;
  // Synonyms are an unordered locale-specific list. EN and JA may have
  // different lengths and different content (e.g. JA includes the EN
  // brand names alongside JP phrasings for SEO). Treated as a plain
  // string array, not id-keyed.
  synonyms: string[];
  seeAlso: { id: string; href: string; label: string }[];
}

export function defineTerm(
  input: GlossaryTermStructuralInput,
): GlossaryTermStructural {
  return GlossaryTermSchema.parse(input);
}
