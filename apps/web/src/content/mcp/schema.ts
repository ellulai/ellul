import { z } from "zod";

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Structural fields validated by Zod for the meta.ts file. Translatable
// strings (name, description, hero, capabilities, faq) live in
// `packages/i18n-messages/messages/{locale}/mcp.json` and are composed in
// by the loader at request time.
export const McpEntrySchema = z.object({
  slug: z.string().regex(slugRegex, "slug must be lowercase, hyphenated"),
  kind: z.enum(["hub", "server", "client", "guide"]),
  vendor: z.string().optional(),
  url: z.string().url().optional(),
  ogImage: z.string().startsWith("/").optional(),
  publishedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lastUpdated: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  structuredDataType: z.enum(["TechArticle", "HowTo"]).default("TechArticle"),
  tags: z.array(z.string().min(1)).default([]),
  relatedComparisons: z.array(z.string().regex(slugRegex)).default([]),
  relatedAgents: z.array(z.string().regex(slugRegex)).default([]),
  relatedTerms: z.array(z.string().regex(slugRegex)).default([]),
});

export type McpEntryStructural = z.infer<typeof McpEntrySchema>;
export type McpEntryStructuralInput = z.input<typeof McpEntrySchema>;

export interface McpEntry extends McpEntryStructural {
  name: string;
  description: string;
  hero: { eyebrow: string; headline: string; sub: string };
  capabilities: string[];
  faq: { id: string; q: string; a: string }[];
}

export function defineMcp(input: McpEntryStructuralInput): McpEntryStructural {
  return McpEntrySchema.parse(input);
}
