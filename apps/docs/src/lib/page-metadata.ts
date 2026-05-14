import type { Metadata } from "next";
import { getPathname } from "@/i18n/routing";
import {
  ALL_LOCALES,
  type Locale,
  OG_LOCALE,
} from "@ellul.ai/i18n-consts";
import { isIndexableLocale } from "@ellul.ai/i18n-consts/indexability";

const BASE_URL = process.env.NEXT_PUBLIC_DOCS_URL!;
const SURFACE = "docs" as const;

export interface DocsPageMetadataInput {
  locale: Locale;
  path: string;
  title: string;
  description: string;
  ogType?: "website" | "article";
  publishedTime?: string;
  modifiedTime?: string;
  authors?: Array<{ name: string }>;
  keywords?: string[];
}

export function docsPageMetadata(input: DocsPageMetadataInput): Metadata {
  const {
    locale,
    path,
    title,
    description,
    ogType = "article",
    publishedTime,
    modifiedTime,
    authors,
    keywords,
  } = input;

  const canonical = `${BASE_URL}${getPathname({ locale: "en", href: path })}`;

  const languages: Record<string, string> = Object.fromEntries(
    ALL_LOCALES.filter((l) => isIndexableLocale(SURFACE, l)).map((l) => [
      l,
      `${BASE_URL}${getPathname({ locale: l, href: path })}`,
    ]),
  );
  languages["x-default"] = `${BASE_URL}${getPathname({ locale: "en", href: path })}`;

  return {
    title,
    description,
    keywords,
    authors,
    alternates: { canonical, languages },
    openGraph: {
      type: ogType,
      url: canonical,
      title,
      description,
      siteName: "ellul docs",
      locale: OG_LOCALE[locale],
      ...(publishedTime ? { publishedTime } : {}),
      ...(modifiedTime ? { modifiedTime } : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
    robots: isIndexableLocale(SURFACE, locale)
      ? { index: true, follow: true }
      : { index: false, follow: true },
  };
}

export const DOCS_BASE_URL = BASE_URL;
