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
  getUseCase,
  listUseCaseSlugs,
} from "@/content/use-cases/loader";
import { getComparison } from "@/content/comparisons/loader";
import { buildSharedMdxComponents } from "@/components/mdx";
import { LastUpdated } from "@/components/comparison/LastUpdated";
import { UseCaseViewedReporter } from "@/components/analytics/content-events";
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
  const slugs = listUseCaseSlugs();
  return ALL_LOCALES.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug })),
  );
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale: rawLocale, slug } = await params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : "en") as Locale;

  const useCase = await getUseCase(slug, locale);
  if (!useCase) return {};

  const base = pageMetadata({
    locale,
    path: `/solutions/${slug}`,
    title: useCase.meta.title,
    description: useCase.meta.description,
    ogType: "article",
    publishedTime: useCase.meta.publishedAt,
  });

  // Narrow hreflang to locales whose MDX exists AND are surface-indexable.
  const eligible = new Set(
    useCase.availableLocales.filter((l) => isIndexableLocale("web", l)),
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

export default async function UseCasePage({ params }: PageProps) {
  const { locale: rawLocale, slug } = await params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : "en") as Locale;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "pages" });

  const useCase = await getUseCase(slug, locale);
  if (!useCase) notFound();

  const url = `${SITE_URL}/solutions/${slug}`;

  const articleJsonLd =
    useCase.meta.structuredDataType === "Article"
      ? articleSchema({
          headline: useCase.meta.title,
          description: useCase.meta.description,
          url,
          datePublished: useCase.meta.publishedAt,
          dateModified: useCase.meta.lastUpdated,
          locale,
          type: "Article",
          image: useCase.meta.ogImage
            ? `${SITE_URL}${useCase.meta.ogImage}`
            : `${SITE_URL}/solutions/${slug}/opengraph-image`,
        })
      : null;

  const howToJsonLd =
    useCase.meta.structuredDataType === "HowTo"
      ? howToSchema({
          name: useCase.meta.title,
          description: useCase.meta.description,
          url,
          datePublished: useCase.meta.publishedAt,
          dateModified: useCase.meta.lastUpdated,
        })
      : null;

  const breadcrumbJsonLd = breadcrumbSchema([
    { name: t("common.home"), url: SITE_URL },
    { name: t("solutions.breadcrumb"), url: `${SITE_URL}/solutions` },
    { name: useCase.meta.title, url },
  ]);

  const faqJsonLd = useCase.meta.faq.length
    ? faqPageSchema(useCase.meta.faq)
    : null;

  const headings = extractHeadings(useCase.content);
  const components = buildSharedMdxComponents({ faqItems: useCase.meta.faq });
  const relatedComparisons = (
    await Promise.all(
      useCase.meta.relatedComparisons.map((s) => getComparison(s)),
    )
  ).filter((c): c is NonNullable<typeof c> => Boolean(c));

  return (
    <main className="flex flex-col items-center px-6">
      <UseCaseViewedReporter slug={slug} />
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
            { name: "Solutions", href: "/solutions" },
            { name: useCase.meta.title, href: `/solutions/${slug}` },
          ]}
        />
      </div>

      <article className="relative z-10 w-full max-w-3xl pt-12 pb-16 sm:pt-16">
        <header className="mb-10">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sodium/80">
            {useCase.meta.hero.eyebrow}
          </p>
          <h1 className="mt-4 text-[2.25rem] font-extralight leading-[1.05] tracking-[-0.03em] text-cream sm:text-[2.75rem] md:text-[3.25rem]">
            {useCase.meta.hero.headline}
          </h1>
          <p className="mt-5 text-base leading-[1.7] text-cream/55 sm:text-lg">
            {useCase.meta.hero.sub}
          </p>
          <div className="mt-5">
            <LastUpdated date={useCase.meta.lastUpdated} />
          </div>
        </header>

        {headings.length >= 3 && (
          <div className="mb-8 rounded-2xl border border-cream/[0.06] bg-cream/[0.02] p-5">
            <TableOfContents headings={headings} />
          </div>
        )}

        <div className="space-y-6 text-[15px] leading-[1.8] text-cream/80 sm:text-base">
          <MDXRemote
            source={useCase.content}
            components={components}
            options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
          />
        </div>

        <footer className="mt-12 flex flex-wrap items-center gap-3 border-t border-cream/[0.06] pt-8">
          <a
            href={
              useCase.meta.cta.href.startsWith("http")
                ? useCase.meta.cta.href
                : `${CONSOLE_URL}${useCase.meta.cta.href}`
            }
            data-cta="use-case-primary"
            data-source-page={`/solutions/${slug}`}
            className="rounded-md bg-sodium px-5 py-2.5 text-sm font-semibold text-ink transition hover:bg-sodium-strong"
          >
            {useCase.meta.cta.label}
          </a>
          {relatedComparisons.length > 0 && (
            <div className="ml-2 flex flex-wrap gap-2">
              {relatedComparisons.map((c) => (
                <Link
                  key={c.slug}
                  href={`/vs/${c.slug}`}
                  className="text-sm text-cream/70 transition hover:text-cream"
                >
                  vs {c.competitor.name} →
                </Link>
              ))}
            </div>
          )}
        </footer>
      </article>

      <RelatedContent slug={slug} contentType="use-case" locale={locale} />
    </main>
  );
}
