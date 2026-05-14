import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import { setRequestLocale } from "next-intl/server";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { getAllSlugs, getDocBySlug, getLocalesForSlug } from "@/lib/docs";
import { mdxComponents } from "@/components/mdx-components";
import {
  Callout,
  CodeTabs,
  CodeTab,
  Image as MdxImage,
  PricingTable,
  FAQ,
  LockCard,
  FaqItem,
  FaqSection,
  ComparisonTable,
  Step,
  Steps,
} from "@/components/mdx";
import { docsPageMetadata, DOCS_BASE_URL } from "@/lib/page-metadata";
import { techArticleSchema } from "@/lib/structured-data";
import type { Metadata } from "next";

const components = {
  ...mdxComponents,
  Callout,
  CodeTabs,
  CodeTab,
  Image: MdxImage,
  PricingTable,
  FAQ,
  LockCard,
  FaqItem,
  FaqSection,
  ComparisonTable,
  Step,
  Steps,
};

interface PageProps {
  params: Promise<{ locale: string; slug: string[] }>;
}

export function generateStaticParams() {
  const slugs = getAllSlugs();
  return ALL_LOCALES.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug })),
  );
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale: rawLocale, slug } = await params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : "en") as Locale;
  const doc = getDocBySlug(slug, locale);
  if (!doc) return {};

  const pathname = `/${slug.join("/")}`;
  const base = docsPageMetadata({
    locale,
    path: pathname,
    title: doc.title,
    description: doc.description,
    ogType: "article",
    publishedTime: doc.publishedAt,
    modifiedTime: doc.updatedAt,
    authors: [{ name: "ellul" }],
  });

  // Narrow hreflang to locales that actually have this page translated.
  const translated = new Set(getLocalesForSlug(slug));
  if (base.alternates?.languages) {
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(base.alternates.languages)) {
      if (key === "x-default" || translated.has(key as Locale)) {
        filtered[key] = value as string;
      }
    }
    base.alternates.languages = filtered;
  }

  return base;
}

export default async function DocPage({ params }: PageProps) {
  const { locale: rawLocale, slug } = await params;
  if (!ALL_LOCALES.includes(rawLocale as Locale)) notFound();
  const locale = rawLocale as Locale;
  setRequestLocale(locale);

  const doc = getDocBySlug(slug, locale);
  if (!doc) notFound();

  const pathname = `/${slug.join("/")}`;
  const articleSchema = techArticleSchema({
    headline: doc.title,
    description: doc.description,
    url: `${DOCS_BASE_URL}${pathname}`,
    datePublished: doc.publishedAt,
    dateModified: doc.updatedAt,
    section: doc.section,
  });

  return (
    <div className="m-4 panel-ascente lg:m-0">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleSchema) }}
      />
      <article className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-16">
        <header className="mb-8 sm:mb-10">
          <p className="text-xs font-semibold tracking-tight text-sodium">
            {doc.section}
          </p>
          <h1 className="mt-2 text-2xl font-light tracking-[-0.02em] text-cream sm:text-3xl lg:text-4xl">
            {doc.title}
          </h1>
          {doc.description && (
            <p className="mt-3 text-sm leading-[1.7] text-cream/60 sm:text-base lg:text-lg">{doc.description}</p>
          )}
        </header>

        <div className="prose prose-ascente max-w-none">
          <MDXRemote
            source={doc.content}
            components={components}
            options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
          />
        </div>
      </article>
    </div>
  );
}
