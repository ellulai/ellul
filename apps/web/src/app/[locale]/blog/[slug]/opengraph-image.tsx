import { ogImageResponse, OG_SIZE, OG_CONTENT_TYPE } from "@/components/og/template";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { getBlogPostMeta, listBlogSlugs } from "@/lib/blog";

export const dynamic = "force-static";
export const alt = "ellul blog post";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export function generateStaticParams() {
  const slugs = listBlogSlugs();
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
  const loc = (ALL_LOCALES.includes(locale as Locale)
    ? (locale as Locale)
    : "en") as Locale;
  const meta = await getBlogPostMeta(slug, loc);

  return ogImageResponse({
    title: meta?.title ?? "ellul blog",
    eyebrow: `${meta?.tag ?? "Engineering"} · ${meta?.publishedAt ?? ""}`,
    subtitle: meta?.summary ?? "",
    locale: loc,
  });
}
