import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { isIndexableLocale } from "@ellul.ai/i18n-consts/indexability";
import { Link } from "@/i18n/routing";
import { pageMetadata } from "@/lib/page-metadata";
import {
  articleSchema,
  breadcrumbSchema,
  faqPageSchema,
  howToSchema,
} from "@/lib/structured-data";
import {
  getPillar,
  listPillarSlugs,
} from "@/content/pillars/loader";
import { getComparison } from "@/content/comparisons/loader";
import { getUseCaseMeta } from "@/content/use-cases/loader";
import { buildSharedMdxComponents } from "@/components/mdx";
import { LastUpdated } from "@/components/comparison/LastUpdated";
import { PillarViewedReporter } from "@/components/analytics/content-events";
import { Breadcrumb } from "@/components/seo/Breadcrumb";
import { RelatedContent } from "@/components/seo/RelatedContent";
import { extractHeadings } from "@/lib/extract-headings";
import { TableOfContents } from "@/components/seo/TableOfContents";

const SITE_URL = "https://ellul.ai";
const CONSOLE_URL =
  process.env.NEXT_PUBLIC_CONSOLE_URL!;

export const dynamic = "force-static";

interface PageProps {
  params: Promise<{ locale: string; slug: string }>;
}

export function generateStaticParams() {
  const slugs = listPillarSlugs();
  return ALL_LOCALES.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug })),
  );
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale: rawLocale, slug } = await params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : "en") as Locale;

  const pillar = await getPillar(slug, locale);
  if (!pillar) return {};

  const base = pageMetadata({
    locale,
    path: `/concepts/${slug}`,
    title: pillar.meta.title,
    description: pillar.meta.description,
    ogType: "article",
    publishedTime: pillar.meta.publishedAt,
    keywords: [pillar.meta.keyword, ...pillar.meta.tags],
  });

  const eligible = new Set(
    pillar.availableLocales.filter((l) => isIndexableLocale("web", l)),
  );
  if (base.alternates?.languages) {
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(base.alternates.languages)) {
      if (key === "x-default" || eligible.has(key as Locale)) {
        filtered[key] = value as string;
      }
    }
    base.alternates.languages = filtered;
  }

  return base;
}

export default async function PillarPage({ params }: PageProps) {
  const { locale: rawLocale, slug } = await params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : "en") as Locale;
  setRequestLocale(locale);
  const tPages = await getTranslations({ locale, namespace: "pages" });

  const pillar = await getPillar(slug, locale);
  if (!pillar) notFound();

  const url = `${SITE_URL}/concepts/${slug}`;

  const articleJsonLd =
    pillar.meta.structuredDataType === "Article"
      ? articleSchema({
          headline: pillar.meta.title,
          description: pillar.meta.description,
          url,
          datePublished: pillar.meta.publishedAt,
          dateModified: pillar.meta.lastUpdated,
          locale,
          type: "Article",
          keywords: pillar.meta.keyword,
          image: pillar.meta.ogImage
            ? `${SITE_URL}${pillar.meta.ogImage}`
            : `${SITE_URL}/concepts/${slug}/opengraph-image`,
        })
      : null;

  const howToJsonLd =
    pillar.meta.structuredDataType === "HowTo"
      ? howToSchema({
          name: pillar.meta.title,
          description: pillar.meta.description,
          url,
          datePublished: pillar.meta.publishedAt,
          dateModified: pillar.meta.lastUpdated,
        })
      : null;

  const breadcrumbJsonLd = breadcrumbSchema([
    { name: tPages("common.home"), url: SITE_URL },
    { name: tPages("concepts.breadcrumb"), url: `${SITE_URL}/concepts` },
    { name: pillar.meta.title, url },
  ]);

  const faqJsonLd = pillar.meta.faq.length
    ? faqPageSchema(pillar.meta.faq)
    : null;

  const headings = extractHeadings(pillar.content);
  const components = buildSharedMdxComponents({ faqItems: pillar.meta.faq });
  const relatedComparisons = (
    await Promise.all(
      pillar.meta.relatedComparisons.map((s) => getComparison(s, locale)),
    )
  ).filter((c): c is NonNullable<typeof c> => Boolean(c));
  const relatedUseCases = (
    await Promise.all(
      pillar.meta.relatedUseCases.map((s) => getUseCaseMeta(s, locale)),
    )
  ).filter((u): u is NonNullable<typeof u> => Boolean(u));

  return (
    <main className="flex flex-col items-center px-6">
      <PillarViewedReporter slug={slug} />
      {articleJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
        />
      )}
      {howToJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(howToJsonLd) }}
        />
      )}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      {faqJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
        />
      )}

      <div className="relative z-10 w-full max-w-3xl pt-8">
        <Breadcrumb
          items={[
            { name: "Home", href: "/" },
            { name: "Concepts", href: "/concepts" },
            { name: pillar.meta.title, href: `/concepts/${slug}` },
          ]}
        />
      </div>

      <article className="relative z-10 w-full max-w-3xl pt-12 pb-16 sm:pt-16">
        <header className="mb-10">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sodium/80">
            {pillar.meta.hero.eyebrow}
          </p>
          <h1 className="mt-4 text-[2.25rem] font-extralight leading-[1.05] tracking-[-0.03em] text-cream sm:text-[2.75rem] md:text-[3.25rem]">
            {pillar.meta.hero.headline}
          </h1>
          <p className="mt-5 text-base leading-[1.7] text-cream/55 sm:text-lg">
            {pillar.meta.hero.sub}
          </p>
          <div className="mt-5">
            <LastUpdated date={pillar.meta.lastUpdated} />
          </div>
        </header>

        {headings.length >= 3 && (
          <div className="mb-8 rounded-2xl border border-cream/[0.06] bg-cream/[0.02] p-5">
            <TableOfContents headings={headings} />
          </div>
        )}

        <div className="space-y-6 text-[15px] leading-[1.8] text-cream/80 sm:text-base">
          <MDXRemote
            source={pillar.content}
            components={components}
            options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
          />
        </div>

        <footer className="mt-12 flex flex-wrap items-center gap-3 border-t border-cream/[0.06] pt-8">
          <a
            href={
              pillar.meta.cta.href.startsWith("http")
                ? pillar.meta.cta.href
                : `${CONSOLE_URL}${pillar.meta.cta.href}`
            }
            data-cta="pillar-primary"
            data-source-page={`/concepts/${slug}`}
            className="rounded-md bg-sodium px-5 py-2.5 text-sm font-semibold text-ink transition hover:bg-sodium-strong"
          >
            {pillar.meta.cta.label}
          </a>
          {(relatedComparisons.length > 0 || relatedUseCases.length > 0) && (
            <div className="ml-2 flex flex-wrap gap-x-3 gap-y-1">
              {relatedComparisons.map((c) => (
                <Link
                  key={c.slug}
                  href={`/vs/${c.slug}`}
                  className="text-sm text-cream/70 transition hover:text-cream"
                >
                  vs {c.competitor.name} →
                </Link>
              ))}
              {relatedUseCases.map((u) => (
                <Link
                  key={u.slug}
                  href={`/solutions/${u.slug}`}
                  className="text-sm text-cream/70 transition hover:text-cream"
                >
                  {u.hero.eyebrow.replace(/^Solution · /, "")} →
                </Link>
              ))}
            </div>
          )}
        </footer>
      </article>

      <RelatedContent slug={slug} contentType="pillar" locale={locale} />
    </main>
  );
}
