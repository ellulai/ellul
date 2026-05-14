import { NextResponse } from "next/server";
import { ALL_LOCALES, DEFAULT_LOCALE, type Locale } from "@ellul.ai/i18n-consts";
import { loadMessages } from "@ellul.ai/i18n-messages/loaders";
import {
  getBlogPost,
  listBlogSlugs,
} from "@/lib/blog";

export const dynamic = "force-static";

const SITE_URL = "https://ellul.ai";

async function loadLabels(locale: Locale): Promise<{
  labelPublished: string;
  labelUpdated: string;
  labelTag: string;
}> {
  const messages = (await loadMessages(locale)) as {
    pages?: { rawMd?: Record<string, string> };
  };
  const ns = messages.pages?.rawMd;
  if (!ns) throw new Error(`pages.rawMd missing for locale "${locale}"`);
  return {
    labelPublished: ns.labelPublished!,
    labelUpdated: ns.labelUpdated!,
    labelTag: ns.labelTag!,
  };
}

export function generateStaticParams() {
  const slugs = listBlogSlugs();
  return ALL_LOCALES.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug })),
  );
}

// /blog/{slug}/raw.md: markdown rendition of a blog post for LLM consumption
// without HTML/JS overhead. Returns text/plain.
export async function GET(
  _: Request,
  context: { params: Promise<{ locale: string; slug: string }> },
) {
  const { locale: rawLocale, slug } = await context.params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : DEFAULT_LOCALE) as Locale;
  const post = await getBlogPost(slug, locale);
  if (!post) return new NextResponse("Not found", { status: 404 });
  const L = await loadLabels(locale);

  const lines: string[] = [];
  lines.push(`# ${post.meta.title}`);
  lines.push(`URL: ${SITE_URL}/blog/${slug}`);
  lines.push(`${L.labelPublished}: ${post.meta.publishedAt}`);
  if (post.meta.updatedAt && post.meta.updatedAt !== post.meta.publishedAt) {
    lines.push(`${L.labelUpdated}: ${post.meta.updatedAt}`);
  }
  lines.push(`${L.labelTag}: ${post.meta.tag}`);
  lines.push("");
  lines.push(post.meta.summary);
  lines.push("");
  lines.push(post.content);

  return new NextResponse(lines.join("\n") + "\n", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
