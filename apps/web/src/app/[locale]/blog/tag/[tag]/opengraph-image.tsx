import { ogImageResponse, OG_SIZE, OG_CONTENT_TYPE } from "@/components/og/template";
import { loadOgStrings } from "@/lib/og-strings";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { getAllBlogPosts, allTagsFor, tagSlug } from "@/lib/blog";

export const dynamic = "force-static";
export const alt = "ellul blog tag";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export async function generateStaticParams() {
  const posts = await getAllBlogPosts("en");
  const tags = new Map<string, string>();
  for (const p of posts) {
    for (const t of allTagsFor(p)) tags.set(tagSlug(t), t);
  }
  return ALL_LOCALES.flatMap((locale) =>
    [...tags.keys()].map((tag) => ({ locale, tag })),
  );
}

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ locale: string; tag: string }>;
}) {
  const { locale, tag } = await params;

  const posts = await getAllBlogPosts("en");
  let label = tag;
  for (const p of posts) {
    for (const t of allTagsFor(p)) {
      if (tagSlug(t) === tag) {
        label = t;
        break;
      }
    }
  }

  const og = await loadOgStrings(locale as Locale, "blogTag");
  const subtitle = og.subtitleTemplate
    ? og.subtitleTemplate.replace("{label}", label)
    : undefined;

  return ogImageResponse({
    title: label,
    eyebrow: og.eyebrow,
    subtitle,
    locale: locale as Locale,
  });
}
