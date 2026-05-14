import type { MetadataRoute } from "next";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { isIndexableLocale } from "@ellul.ai/i18n-consts/indexability";
import { getAllSlugs, getDocBySlug, getLocalesForSlug } from "@/lib/docs";

export const dynamic = "force-static";

const BASE_URL = process.env.NEXT_PUBLIC_DOCS_URL!;
const SURFACE = "docs" as const;

function urlFor(locale: Locale, pathname: string): string {
  const cleanPath = pathname === "/" ? "" : pathname;
  if (locale === "en") return `${BASE_URL}${cleanPath || "/"}`;
  return `${BASE_URL}/${locale}${cleanPath}`;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const indexableLocales = ALL_LOCALES.filter((l) => isIndexableLocale(SURFACE, l));
  const slugs = getAllSlugs();
  const now = new Date().toISOString();

  const entries: MetadataRoute.Sitemap = [
    {
      url: urlFor("en", "/"),
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1.0,
      alternates: {
        languages: Object.fromEntries(
          indexableLocales.map((l) => [l, urlFor(l, "/")]),
        ),
      },
    },
  ];

  for (const slug of slugs) {
    const pathname = `/${slug.join("/")}`;
    const doc = getDocBySlug(slug, "en");
    if (!doc) continue;

    const translatedLocales = new Set(getLocalesForSlug(slug));
    const localesForAlternates = indexableLocales.filter((l) =>
      translatedLocales.has(l),
    );

    entries.push({
      url: urlFor("en", pathname),
      lastModified: doc.updatedAt,
      changeFrequency: "weekly",
      priority: 0.8,
      alternates: {
        languages: Object.fromEntries(
          localesForAlternates.map((l) => [l, urlFor(l, pathname)]),
        ),
      },
    });
  }

  return entries;
}
