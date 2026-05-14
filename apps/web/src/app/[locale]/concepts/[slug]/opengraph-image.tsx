import {
  ogImageResponse,
  OG_SIZE,
  OG_CONTENT_TYPE,
} from "@/components/og/template";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import {
  getPillarMeta,
  listPillarSlugs,
} from "@/content/pillars/loader";

export const dynamic = "force-static";
export const alt = "ellul concept";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export function generateStaticParams() {
  const slugs = listPillarSlugs();
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
  const meta = await getPillarMeta(slug, locale as Locale);
  return ogImageResponse({
    title: meta?.title ?? "Concept",
    eyebrow: meta?.hero.eyebrow ?? "Concept · ellul",
    subtitle: meta?.description ?? "Cornerstone concept on Ellul.",
    locale: locale as Locale,
  });
}
