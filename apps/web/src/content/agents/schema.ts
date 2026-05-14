import { z } from "zod";

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Structural fields validated by Zod for the meta.ts file. Translatable
// strings (name, description, hero, supportedFeatures, pricingNote, faq)
// live in `packages/i18n-messages/messages/{locale}/agents.json` and are
// composed in by the loader at request time.
export const AgentMetaSchema = z.object({
  slug: z.string().regex(slugRegex, "slug must be lowercase, hyphenated"),
  vendor: z.string().min(1),
  url: z.string().url(),
  ogImage: z.string().startsWith("/").optional(),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lastUpdated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  structuredDataType: z.enum(["TechArticle", "HowTo"]).default("TechArticle"),
  tags: z.array(z.string().min(1)).default([]),
  relatedComparisons: z.array(z.string().regex(slugRegex)).default([]),
  relatedTerms: z.array(z.string().regex(slugRegex)).default([]),
});

export type AgentMetaStructural = z.infer<typeof AgentMetaSchema>;
export type AgentMetaStructuralInput = z.input<typeof AgentMetaSchema>;

export interface AgentMeta extends AgentMetaStructural {
  name: string;
  description: string;
  hero: { eyebrow: string; headline: string; sub: string };
  supportedFeatures: string[];
  pricingNote: string;
  faq: { id: string; q: string; a: string }[];
}

export function defineAgent(
  input: AgentMetaStructuralInput,
): AgentMetaStructural {
  return AgentMetaSchema.parse(input);
}
