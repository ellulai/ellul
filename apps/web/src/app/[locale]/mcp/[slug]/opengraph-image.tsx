import {
  ogImageResponse,
  OG_SIZE,
  OG_CONTENT_TYPE,
} from "@/components/og/template";
import { loadOgStrings } from "@/lib/og-strings";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import {
  getMcpMeta,
  listMcpSlugs,
} from "@/content/mcp/loader";

export const dynamic = "force-static";
export const alt = "ellul MCP entry";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export function generateStaticParams() {
  const slugs = listMcpSlugs();
  return ALL_LOCALES.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug })),
  );
}

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  const meta = await getMcpMeta(slug, locale as Locale);
  const og = await loadOgStrings(locale as Locale, "mcpDetail");
  return ogImageResponse({
    title: meta?.name ?? og.titleFallback ?? "",
    highlight: og.highlight,
    eyebrow: meta?.hero.eyebrow ?? og.eyebrowFallback,
    subtitle: meta?.description ?? og.subtitleFallback,
    locale: locale as Locale,
  });
}
