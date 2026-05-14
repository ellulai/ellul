import type { Metadata } from "next";
import { getPathname } from "@/i18n/routing";
import { ALL_LOCALES, DEFAULT_LOCALE, type Locale } from "@ellul.ai/i18n-consts";
import {
  isIndexableLocale,
  isReferenceTranslationPath,
} from "@ellul.ai/i18n-consts/indexability";

// Override at build/run time via NEXT_PUBLIC_WEB_URL so Lighthouse and
// staging hosts can produce canonicals that match the host they're served
// from. Production builds use the literal default and ignore the env var.
const BASE_URL = process.env.NEXT_PUBLIC_WEB_URL!;
const SURFACE = "web" as const;

export type AuthorRef = { name: string } | { handle: string };

export interface PageMetadataInput {
  locale: Locale;
  path: string;
  title: string;
  description: string;
  ogType?: "website" | "article";
  publishedTime?: string;
  authors?: Array<AuthorRef>;
  keywords?: string[];
  twitterCard?: "summary" | "summary_large_image";
}

export function pageMetadata(input: PageMetadataInput): Metadata {
  const {
    locale,
    path,
    title,
    description,
    ogType = "website",
    publishedTime,
    authors,
    keywords,
    twitterCard = "summary_large_image",
  } = input;

  // Reference-translation paths (legal docs) treat EN as the single canonical
  // and noindex every translated locale. Translations exist for users to read
  // in their language but never compete with EN in search.
  const isReferencePath = isReferenceTranslationPath(path);

  const canonical = isReferencePath
    ? `${BASE_URL}${getPathname({ locale: DEFAULT_LOCALE, href: path })}`
    : `${BASE_URL}${getPathname({ locale, href: path })}`;

  // For reference paths we omit hreflang `languages` entirely — only canonical
  // is set. This signals to Google that EN is the sole indexable version and
  // prevents /ja/privacy from being surfaced in JP-locale search results.
  const languages: Record<string, string> = isReferencePath
    ? {}
    : Object.fromEntries(
        ALL_LOCALES.filter((l) => isIndexableLocale(SURFACE, l)).map((l) => [
          l,
          `${BASE_URL}${getPathname({ locale: l, href: path })}`,
        ]),
      );
  if (!isReferencePath) {
    languages["x-default"] = `${BASE_URL}${getPathname({ locale: "en", href: path })}`;
  }

  // Next.js Metadata.authors accepts { name, url? }. Coerce handles to names
  // so a post written by `{ handle: "ellul" }` still emits a usable byline.
  const metadataAuthors = authors?.map((a) =>
    "name" in a ? a : { name: a.handle },
  );

  return {
    title,
    description,
    keywords,
    authors: metadataAuthors,
    alternates: isReferencePath ? { canonical } : { canonical, languages },
    openGraph: {
      type: ogType,
      url: canonical,
      title,
      description,
      siteName: "ellul",
      ...(publishedTime ? { publishedTime } : {}),
    },
    twitter: {
      card: twitterCard,
      title,
      description,
    },
    robots:
      isReferencePath && locale !== DEFAULT_LOCALE
        ? { index: false, follow: true }
        : isIndexableLocale(SURFACE, locale)
          ? { index: true, follow: true }
          : { index: false, follow: true },
  };
}
