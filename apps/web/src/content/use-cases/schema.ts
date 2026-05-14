import { z } from "zod";

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Structural fields validated by Zod for the meta.ts file. Translatable
// strings (title, description, hero, cta.label, faq) live in
// `packages/i18n-messages/messages/{locale}/use-cases.json` and are composed
// in by the loader at request time.
export const UseCaseMetaSchema = z.object({
  slug: z.string().regex(slugRegex, "slug must be lowercase, hyphenated"),
  cta: z.object({ href: z.string().min(1) }),
  ogImage: z.string().startsWith("/").optional(),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lastUpdated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  structuredDataType: z.enum(["Article", "HowTo"]).default("Article"),
  tags: z.array(z.string().min(1)).default([]),
  relatedComparisons: z.array(z.string().regex(slugRegex)).default([]),
});

export type UseCaseMetaStructural = z.infer<typeof UseCaseMetaSchema>;
export type UseCaseMetaStructuralInput = z.input<typeof UseCaseMetaSchema>;

export interface UseCaseMeta extends UseCaseMetaStructural {
  title: string;
  description: string;
  hero: { eyebrow: string; headline: string; sub: string };
  cta: { label: string; href: string };
  faq: { id: string; q: string; a: string }[];
}

export function defineUseCase(
  input: UseCaseMetaStructuralInput,
): UseCaseMetaStructural {
  return UseCaseMetaSchema.parse(input);
}
