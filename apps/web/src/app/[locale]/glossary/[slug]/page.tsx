import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { pageMetadata } from "@/lib/page-metadata";
import {
  breadcrumbSchema,
  definedTermSchema,
} from "@/lib/structured-data";
import {
  getGlossaryTerm,
  getAllGlossaryTerms,
  getGlossaryAvailableLocales,
  listGlossarySlugs,
} from "@/content/glossary/loader";
import { isIndexableLocale } from "@ellul.ai/i18n-consts/indexability";
import { GlossaryTermViewedReporter } from "@/components/analytics/content-events";
import { Breadcrumb } from "@/components/seo/Breadcrumb";
import { RelatedContent } from "@/components/seo/RelatedContent";

const SITE_URL = "https://ellul.ai";

export const dynamic = "force-static";

export function generateStaticParams() {
  const slugs = listGlossarySlugs();
  return ALL_LOCALES.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug })),
  );
}

interface PageProps {
  params: Promise<{ locale: string; slug: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale, slug } = await params;
  const term = await getGlossaryTerm(slug, locale as Locale);
  if (!term) return {};
  const base = pageMetadata({
    locale: locale as Locale,
    path: `/glossary/${slug}`,
    title: `${term.term} · ellul glossary`,
    description: term.definition,
    ogType: "article",
    publishedTime: term.publishedAt,
  });

  // Gate hreflang alternates by translations[locale] presence on the term.
  const availableLocales = await getGlossaryAvailableLocales(slug);
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

export default async function GlossaryDetail({ params }: PageProps) {
  const { locale, slug } = await params;
  setRequestLocale(locale as Locale);
  const t = await getTranslations({ locale, namespace: "pages" });

  const term = await getGlossaryTerm(slug, locale as Locale);
  if (!term) notFound();

  const url = `${SITE_URL}/glossary/${slug}`;
  const all = await getAllGlossaryTerms(locale as Locale);
  const related = (term.related ?? [])
    .map((s) => all.find((x) => x.slug === s))
    .filter((x): x is NonNullable<typeof x> => Boolean(x));

  const definedTermJsonLd = definedTermSchema({
    slug: term.slug,
    name: term.term,
    description: term.definition,
    url,
    setUrl: `${SITE_URL}/glossary`,
    setName: "ellul glossary",
    alternateName: term.synonyms,
    dateModified: term.lastUpdated,
  });

  const breadcrumbJsonLd = breadcrumbSchema([
    { name: t("common.home"), url: SITE_URL },
    { name: t("glossary.breadcrumb"), url: `${SITE_URL}/glossary` },
    { name: term.term, url },
  ]);

  return (
    <main className="flex flex-col items-center px-6">
      <GlossaryTermViewedReporter slug={slug} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(definedTermJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />

      <div className="relative z-10 w-full max-w-3xl pt-8">
        <Breadcrumb
          items={[
            { name: "Home", href: "/" },
            { name: "Glossary", href: "/glossary" },
            { name: term.term, href: `/glossary/${slug}` },
          ]}
        />
      </div>

      <article className="relative z-10 w-full max-w-3xl pt-12 pb-16 sm:pt-16">
        <header className="mb-8">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sodium/80">
            {t("glossary.breadcrumbCategory")} · {term.slug}
          </p>
          <h1 className="mt-4 text-[2.25rem] font-extralight leading-[1.05] tracking-[-0.03em] text-cream sm:text-[2.75rem] md:text-[3.25rem]">
            {term.term}
          </h1>
        </header>

        <section className="rounded-2xl border border-sodium/30 bg-sodium-soft p-6 sm:p-8">
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-sodium">
            {t("glossary.definition")}
          </p>
          <p className="mt-3 text-[15px] leading-[1.8] text-cream/85 sm:text-base">
            {term.definition}
          </p>
        </section>

        {term.context && (
          <section className="mt-10">
            <h2 className="text-2xl font-light tracking-[-0.02em] text-cream sm:text-3xl">
              {t("glossary.context")}
            </h2>
            <p className="mt-4 text-[15px] leading-[1.8] text-cream/80 sm:text-base">
              {term.context}
            </p>
          </section>
        )}

        {term.synonyms.length > 0 && (
          <section className="mt-10">
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/45">
              {t("glossary.alsoKnownAs")}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {term.synonyms.map((s) => (
                <span
                  key={s}
                  className="rounded-full border border-cream/[0.06] bg-cream/[0.02] px-3 py-1.5 text-xs text-cream/60"
                >
                  {s}
                </span>
              ))}
            </div>
          </section>
        )}

        {related.length > 0 && (
          <section className="mt-10">
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/45">
              {t("glossary.relatedTerms")}
            </p>
            <ul className="mt-3 flex flex-wrap gap-2">
              {related.map((r) => (
                <li key={r.slug}>
                  <Link
                    href={`/glossary/${r.slug}`}
                    className="rounded-full border border-cream/[0.08] bg-cream/[0.02] px-3 py-1.5 text-xs text-cream/65 transition hover:border-cream/20 hover:text-cream"
                  >
                    {r.term} →
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {term.seeAlso && term.seeAlso.length > 0 && (
          <section className="mt-10 border-t border-cream/[0.06] pt-8">
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/45">
              {t("glossary.seeAlso")}
            </p>
            <ul className="mt-3 space-y-2">
              {term.seeAlso.map((link) =>
                link.href.startsWith("/") ? (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-sodium underline-offset-4 hover:underline"
                    >
                      {link.label}
                    </Link>
                  </li>
                ) : (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      className="text-sm text-sodium underline-offset-4 hover:underline"
                      rel="noopener noreferrer"
                    >
                      {link.label}
                    </a>
                  </li>
                ),
              )}
            </ul>
          </section>
        )}

        <footer className="mt-12 flex flex-wrap items-center gap-3 border-t border-cream/[0.06] pt-8">
          <Link
            href="/glossary"
            className="text-sm text-cream/65 transition hover:text-cream"
          >
            {t("glossary.allTerms")}
          </Link>
          <span className="text-cream/30">·</span>
          <span className="text-xs text-cream/35">
            {t("common.lastUpdated")} {term.lastUpdated}
          </span>
        </footer>
      </article>

      <RelatedContent slug={slug} contentType="glossary" locale={locale as Locale} />
    </main>
  );
}
