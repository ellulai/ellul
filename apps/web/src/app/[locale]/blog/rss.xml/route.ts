import { NextResponse } from "next/server";
import {
  ALL_LOCALES,
  DEFAULT_LOCALE,
  type Locale,
} from "@ellul.ai/i18n-consts";
import { getTranslations } from "next-intl/server";
import { getAllBlogPosts, getAvailableLocales } from "@/lib/blog";

export const dynamic = "force-static";

const SITE_URL = "https://ellul.ai";

function localeUrl(locale: Locale, path: string): string {
  if (locale === DEFAULT_LOCALE) return `${SITE_URL}${path}`;
  return `${SITE_URL}/${locale}${path}`;
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function generateStaticParams() {
  return ALL_LOCALES.map((locale) => ({ locale }));
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ locale: string }> },
) {
  const { locale: rawLocale } = await params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : DEFAULT_LOCALE) as Locale;

  const all = await getAllBlogPosts(locale);
  const posts = all.filter((p) =>
    getAvailableLocales(p.slug).includes(locale),
  );

  const t = await getTranslations({ locale, namespace: "blog" });

  const feedUrl = localeUrl(locale, "/blog/rss.xml");
  const blogUrl = localeUrl(locale, "/blog");
  const lastBuild = posts[0]?.updatedAt ?? posts[0]?.publishedAt ?? "";

  const items = posts
    .map((p) => {
      const url = localeUrl(locale, `/blog/${p.slug}`);
      const pubDate = new Date(
        `${p.publishedAt}T00:00:00Z`,
      ).toUTCString();
      return [
        `    <item>`,
        `      <title>${escapeXml(p.title)}</title>`,
        `      <link>${url}</link>`,
        `      <guid isPermaLink="true">${url}</guid>`,
        `      <description>${escapeXml(p.summary)}</description>`,
        `      <pubDate>${pubDate}</pubDate>`,
        `      <category>${escapeXml(p.tag)}</category>`,
        `    </item>`,
      ].join("\n");
    })
    .join("\n");

  const lastBuildDate = lastBuild
    ? new Date(`${lastBuild}T00:00:00Z`).toUTCString()
    : new Date().toUTCString();

  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">`,
    `  <channel>`,
    `    <title>${escapeXml(t("rss.title", { locale }))}</title>`,
    `    <link>${blogUrl}</link>`,
    `    <description>${escapeXml(t("rss.description"))}</description>`,
    `    <language>${locale}</language>`,
    `    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml" />`,
    `    <lastBuildDate>${lastBuildDate}</lastBuildDate>`,
    items,
    `  </channel>`,
    `</rss>`,
  ].join("\n");

  return new NextResponse(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
