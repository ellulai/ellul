// Locale-aware OG image strings.
//
// Note on the `alt` static-export limitation: each opengraph-image.tsx
// route exports `alt` as a top-level `const` consumed by Next.js's
// Metadata API at build time, so it can't branch on locale without
// duplicating every OG file per locale. Visible OG image content IS
// fully localized through `ogImageResponse(...)`; alt is a brand-anchored
// screen-reader fallback.
//
// `*Detail` namespaces (vsDetail, solutionsDetail, agentsDetail, mcpDetail)
// hold subtitle/title/eyebrow fallbacks that fire only when a meta lookup
// returns null. The content loaders throw on missing slugs today, so the
// fallbacks are defensive coverage — kept localized so a future graceful-
// fallback policy doesn't silently leak EN strings onto JP pages.
import { loadMessages } from "@ellul.ai/i18n-messages/loaders";
import type { Locale } from "@ellul.ai/i18n-consts";

export interface OgStrings {
  title?: string;
  highlight?: string;
  eyebrow?: string;
  subtitle?: string;
  alt?: string;
}

interface OgNamespaceEntry extends OgStrings {
  subtitleTemplate?: string;
  subtitleFallback?: string;
  titleFallback?: string;
  eyebrowFallback?: string;
}

type OgKey =
  | "agents"
  | "agentsDetail"
  | "blog"
  | "blogTag"
  | "concepts"
  | "docs"
  | "faq"
  | "glossary"
  | "mcp"
  | "mcpDetail"
  | "pricing"
  | "privacy"
  | "promptEngineering"
  | "solutions"
  | "solutionsDetail"
  | "terms"
  | "vs"
  | "vsDetail";

export async function loadOgStrings(
  locale: Locale,
  key: OgKey,
): Promise<OgNamespaceEntry> {
  const messages = (await loadMessages(locale)) as {
    og?: Partial<Record<OgKey, OgNamespaceEntry>>;
  };
  return messages.og?.[key] ?? {};
}
