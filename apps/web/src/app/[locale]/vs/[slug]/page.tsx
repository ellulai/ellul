import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { pageMetadata } from "@/lib/page-metadata";
import {
  articleSchema,
  breadcrumbSchema,
  faqPageSchema,
  reviewSchema,
} from "@/lib/structured-data";
import { deriveAdvantage } from "@/content/comparisons/schema";
import {
  getComparison,
  getAllComparisons,
  getComparisonAvailableLocales,
  listComparisonSlugs,
} from "@/content/comparisons/loader";
import { isIndexableLocale } from "@ellul.ai/i18n-consts/indexability";
import { FeatureMatrix } from "@/components/comparison/FeatureMatrix";
import { PricingMatrix } from "@/components/comparison/PricingMatrix";
import { Verdict } from "@/components/comparison/Verdict";
import { LastUpdated } from "@/components/comparison/LastUpdated";
import { FaqList } from "@/app/[locale]/components/faq-list";
import { ComparisonViewedReporter } from "@/components/analytics/content-events";
import { getUseCaseMeta } from "@/content/use-cases/loader";
import { Breadcrumb } from "@/components/seo/Breadcrumb";
import { RelatedContent } from "@/components/seo/RelatedContent";

const SITE_URL = "https://ellul.ai";
const CONSOLE_URL =
  process.env.NEXT_PUBLIC_CONSOLE_URL!;

export const dynamic = "force-static";

export function generateStaticParams() {
  const slugs = listComparisonSlugs();
  return ALL_LOCALES.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug })),
  );
}

interface PageProps {
  params: Promise<{ locale: string; slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, slug } = await params;
  const data = await getComparison(slug, locale as Locale);
  if (!data) return {};
  const base = pageMetadata({
    locale: locale as Locale,
    path: `/vs/${data.slug}`,
    title: data.meta.title,
    description: data.meta.description,
    ogType: "article",
    publishedTime: data.publishedAt,
  });

  // Gate hreflang alternates by translations[locale] presence — comparisons
  // have no MDX sibling, so the data file's translations map is the source
  // of truth for which locales actually have the page localized.
  const availableLocales = await getComparisonAvailableLocales(slug);
  const eligible = new Set(
    availableLocales.filter((l) => isIndexableLocale("web", l)),
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

export default async function ComparisonPage({ params }: PageProps) {
  const { locale, slug } = await params;
  setRequestLocale(locale as Locale);
  const t = await getTranslations({ locale, namespace: "pages" });
  const data = await getComparison(slug, locale as Locale);
  if (!data) notFound();

  const others = (await getAllComparisons(locale as Locale)).filter(
    (c) => c.slug !== data.slug,
  );
  const relatedUseCases = (
    await Promise.all(
      data.relatedUseCases.map((s) => getUseCaseMeta(s, locale as Locale)),
    )
  ).filter((u): u is NonNullable<typeof u> => Boolean(u));
  const url = `${SITE_URL}/vs/${data.slug}`;

  const faqJsonLd = faqPageSchema(data.faq);
  const articleJsonLd = articleSchema({
    headline: data.meta.title,
    description: data.meta.description,
    url,
    datePublished: data.publishedAt,
    dateModified: data.lastUpdated,
    locale,
    type: "Article",
    image: data.ogImage
      ? `${SITE_URL}${data.ogImage}`
      : `${SITE_URL}/vs/${data.slug}/opengraph-image`,
  });
  const breadcrumbJsonLd = breadcrumbSchema([
    { name: t("common.home"), url: SITE_URL },
    { name: t("comparisons.breadcrumb"), url: `${SITE_URL}/vs` },
    { name: `${data.competitor.name} vs ellul`, url },
  ]);

  // Derive review rating from the feature-matrix advantage tally so the
  // structured-data score is grounded in the data, not invented.
  const tally = data.features.reduce(
    (acc, row) => {
      const a = deriveAdvantage(row);
      if (a === "ellul") acc.ellul += 1;
      else if (a === "competitor") acc.competitor += 1;
      else acc.tie += 1;
      return acc;
    },
    { ellul: 0, competitor: 0, tie: 0 },
  );
  const total = data.features.length;
  // Map (ellul wins + 0.5 * ties) / total → 1..5 scale, where 100% ellul = 5.0,
  // 50% (pure tie) = 3.0, 0% ellul = 1.0.
  const ellulShare = (tally.ellul + 0.5 * tally.tie) / Math.max(1, total);
  const ratingValue = Math.max(
    1,
    Math.min(5, Math.round((1 + ellulShare * 4) * 10) / 10),
  );

  const reviewJsonLd = reviewSchema({
    itemName: data.competitor.name,
    itemUrl: data.competitor.url,
    itemDescription: data.competitor.tagline,
    reviewBody: `${data.verdict.headline} ${data.verdict.body}`,
    reviewName: `${data.competitor.name} vs ellul: head-to-head review`,
    reviewUrl: url,
    datePublished: data.publishedAt,
    dateModified: data.lastUpdated,
    ratingValue,
    positives: data.whenToUseCompetitor.map((i) => i.text),
    negatives: data.whenToUseEllul.map((i) => i.text),
  });

  return (
    <main className="flex flex-col items-center px-6">
      <ComparisonViewedReporter slug={data.slug} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(reviewJsonLd) }}
      />

      <div className="relative z-10 w-full max-w-5xl pt-8">
        <Breadcrumb
          items={[
            { name: "Home", href: "/" },
            { name: "Comparisons", href: "/vs" },
            { name: data.competitor.name, href: `/vs/${data.slug}` },
          ]}
        />
      </div>

      <section className="relative z-10 flex flex-col items-center pt-12 pb-10 sm:pt-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sodium/80">
          {data.hero.eyebrow}
        </p>
        <h1 className="mt-4 max-w-4xl text-center text-[2.25rem] font-extralight leading-[1.05] tracking-[-0.03em] text-cream sm:text-[2.75rem] md:text-[3.25rem]">
          {data.hero.headline}
        </h1>
        <p className="mt-5 max-w-2xl text-center text-base leading-[1.7] text-cream/55 sm:text-lg">
          {data.hero.sub}
        </p>
        <div className="mt-5">
          <LastUpdated date={data.lastUpdated} />
        </div>
      </section>

      <section className="relative z-10 w-full max-w-3xl pb-12">
        <div className="rounded-2xl border border-cream/[0.08] bg-cream/[0.02] p-6 sm:p-8">
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-sodium/80">
            {t("comparisons.fundamentalDifferenceLabel")}
          </p>
          <p className="mt-3 text-[15px] leading-[1.75] text-cream/80 sm:text-base">
            {data.fundamentalDifference}
          </p>
        </div>
      </section>

      <section className="relative z-10 w-full max-w-5xl pb-14">
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="rounded-2xl border border-cream/[0.06] bg-cream/[0.02] p-6">
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/45">
              {t("comparisons.whereStrong", { name: data.competitor.name })}
            </p>
            <p className="mt-3 text-sm leading-[1.7] text-cream/70">
              {data.competitorPitch}
            </p>
          </div>
          <div className="rounded-2xl border border-sodium/30 bg-sodium-soft p-6">
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-sodium">
              {t("comparisons.whereEllulStronger")}
            </p>
            <p className="mt-3 text-sm leading-[1.7] text-cream/85">
              {data.ellulPitch}
            </p>
          </div>
        </div>
      </section>

      <section className="relative z-10 w-full max-w-5xl pb-14">
        <h2 className="mb-6 text-center text-2xl font-light tracking-[-0.02em] text-cream sm:text-3xl">
          {t("comparisons.featureComparisonHeading")}
        </h2>
        <FeatureMatrix
          competitorName={data.competitor.name}
          rows={data.features}
        />
      </section>

      <section className="relative z-10 w-full max-w-5xl pb-14">
        <h2 className="mb-6 text-center text-2xl font-light tracking-[-0.02em] text-cream sm:text-3xl">
          {t("comparisons.pricingHeading")}
        </h2>
        <PricingMatrix
          competitorName={data.competitor.name}
          rows={data.pricing}
        />
      </section>

      <section className="relative z-10 w-full max-w-3xl pb-14">
        <Verdict {...data.verdict} />
      </section>

      <section className="relative z-10 w-full max-w-5xl pb-14">
        <h2 className="mb-6 text-center text-2xl font-light tracking-[-0.02em] text-cream sm:text-3xl">
          {t("comparisons.whenToUseHeading")}
        </h2>
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="rounded-2xl border border-cream/[0.06] bg-cream/[0.02] p-6">
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/45">
              {t("comparisons.useWhen", { name: data.competitor.name })}
            </p>
            <ul className="mt-4 space-y-3">
              {data.whenToUseCompetitor.map((item) => (
                <li
                  key={item.id}
                  className="flex gap-3 text-sm leading-[1.6] text-cream/70"
                >
                  <span className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-cream/40" />
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-sodium/30 bg-sodium-soft p-6">
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-sodium">
              {t("comparisons.useEllulWhen")}
            </p>
            <ul className="mt-4 space-y-3">
              {data.whenToUseEllul.map((item) => (
                <li
                  key={item.id}
                  className="flex gap-3 text-sm leading-[1.6] text-cream/85"
                >
                  <span className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-sodium" />
                  <span>{item.text}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="relative z-10 w-full max-w-3xl pb-14">
        <h2 className="mb-6 text-center text-2xl font-light tracking-[-0.02em] text-cream sm:text-3xl">
          {t("comparisons.commonQuestionsHeading")}
        </h2>
        <FaqList items={data.faq} />
      </section>

      {relatedUseCases.length > 0 && (
        <section className="relative z-10 w-full max-w-3xl pb-14">
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/35">
            {t("comparisons.relatedSolutions")}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {relatedUseCases.map((u) => (
              <Link
                key={u.slug}
                href={`/solutions/${u.slug}`}
                className="rounded-full border border-cream/[0.08] bg-cream/[0.02] px-3 py-1.5 text-xs text-cream/65 transition hover:border-cream/20 hover:text-cream"
              >
                {u.hero.eyebrow.replace(/^Solution · /, "")}
              </Link>
            ))}
          </div>
        </section>
      )}

      {data.tags.length > 0 && (
        <section className="relative z-10 w-full max-w-3xl pb-14">
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/35">
            {t("comparisons.topics")}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {data.tags.map((t) => (
              <span
                key={t}
                className="rounded-full border border-cream/[0.06] bg-cream/[0.02] px-3 py-1.5 text-xs text-cream/45"
              >
                {t}
              </span>
            ))}
          </div>
        </section>
      )}

      <RelatedContent slug={slug} contentType="comparison" locale={locale as Locale} />

      <section className="relative z-10 flex flex-col items-center pb-20 text-center">
        <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-sodium/80">
          {t("comparisons.tryItEyebrow")}
        </p>
        <h2 className="mt-3 text-2xl font-light tracking-[-0.02em] text-cream sm:text-3xl">
          {t("comparisons.tryItHeadline")}
        </h2>
        <p className="mt-3 max-w-md text-sm leading-[1.7] text-cream/55">
          {t("comparisons.tryItSub")}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <a
            href={`${CONSOLE_URL}/sign-up`}
            data-cta="comparison-signup"
            data-source-page={`/vs/${data.slug}`}
            className="rounded-md bg-sodium px-6 py-3 text-sm font-semibold text-ink transition hover:bg-sodium-strong"
          >
            {t("comparisons.getWorkstation")}
          </a>
          <Link
            href="/faq"
            className="rounded-md border border-cream/[0.12] px-6 py-3 text-sm font-medium text-cream/75 transition hover:border-cream/30 hover:text-cream"
          >
            {t("comparisons.readFaq")}
          </Link>
        </div>

        <div className="mt-12 w-full max-w-3xl">
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/35">
            {t("comparisons.compareAgainst")}
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            {others.map((c) => (
              <Link
                key={c.slug}
                href={`/vs/${c.slug}`}
                className="rounded-full border border-cream/[0.08] bg-cream/[0.02] px-3 py-1.5 text-xs text-cream/65 transition hover:border-cream/20 hover:text-cream"
              >
                {c.competitor.name}
              </Link>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
