import {
  ogImageResponse,
  OG_SIZE,
  OG_CONTENT_TYPE,
} from "@/components/og/template";
import { loadOgStrings } from "@/lib/og-strings";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import {
  getComparison,
  listComparisonSlugs,
} from "@/content/comparisons/loader";

export const dynamic = "force-static";
export const alt = "ellul comparison";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export function generateStaticParams() {
  const slugs = listComparisonSlugs();
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
  const data = await getComparison(slug, locale as Locale);
  const og = await loadOgStrings(locale as Locale, "vsDetail");
  const fallbackTitle = (await loadOgStrings(locale as Locale, "vs")).title ?? "";
  const title = data ? `${data.competitor.name} vs` : fallbackTitle;

  return ogImageResponse({
    title,
    highlight: og.highlight,
    eyebrow: og.eyebrow,
    subtitle: data?.fundamentalDifference ?? og.subtitleFallback,
    locale: locale as Locale,
  });
}
