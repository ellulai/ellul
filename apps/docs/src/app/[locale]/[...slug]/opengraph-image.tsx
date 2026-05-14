import { ogImageResponse, OG_SIZE, OG_CONTENT_TYPE } from "@/components/og/template";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { getAllSlugs, getDocBySlug } from "@/lib/docs";

export const dynamic = "force-static";
export const alt = "ellul docs page";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export function generateStaticParams() {
  const slugs = getAllSlugs();
  return ALL_LOCALES.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug })),
  );
}

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ locale: string; slug: string[] }>;
}) {
  const { locale, slug } = await params;
  const loc = (ALL_LOCALES.includes(locale as Locale)
    ? (locale as Locale)
    : "en") as Locale;
  const doc = getDocBySlug(slug, loc);

  return ogImageResponse({
    title: doc?.title ?? "Documentation",
    eyebrow: `${doc?.section ?? "Docs"} · Ellul`,
    subtitle: doc?.description ?? "",
    locale: loc,
  });
}
