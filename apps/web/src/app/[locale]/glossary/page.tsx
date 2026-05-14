import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import type { Locale } from "@ellul.ai/i18n-consts";
import { pageMetadata } from "@/lib/page-metadata";
import { getAllGlossaryTerms } from "@/content/glossary/loader";
import {
  breadcrumbSchema,
  definedTermSetSchema,
} from "@/lib/structured-data";

const SITE_URL = "https://ellul.ai";

export const dynamic = "force-static";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "pages" });
  return pageMetadata({
    locale: locale as Locale,
    path: "/glossary",
    title: t("glossary.indexTitle"),
    description: t("glossary.indexDescription"),
  });
}

export default async function GlossaryIndex({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale as Locale);
  const t = await getTranslations({ locale, namespace: "pages" });

  const terms = await getAllGlossaryTerms(locale as Locale);
  const breadcrumbJsonLd = breadcrumbSchema([
    { name: t("common.home"), url: SITE_URL },
    { name: t("glossary.breadcrumb"), url: `${SITE_URL}/glossary` },
  ]);
  const setJsonLd = definedTermSetSchema({
    url: `${SITE_URL}/glossary`,
    name: "ellul glossary",
    description: t("glossary.indexDescription"),
    terms: terms.map((term) => ({
      slug: term.slug,
      term: term.term,
      href: `${SITE_URL}/glossary/${term.slug}`,
    })),
  });

  return (
    <main className="flex flex-col items-center px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(setJsonLd) }}
      />

      <section className="relative z-10 flex flex-col items-center pt-12 pb-12 sm:pt-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sodium/80">
          {t("glossary.indexEyebrow")}
        </p>
        <h1 className="mt-4 max-w-3xl text-center text-[2.5rem] font-extralight leading-[1.05] tracking-[-0.03em] text-cream sm:text-[3rem] md:text-[3.5rem]">
          {t("glossary.indexHeadline")}
        </h1>
        <p className="mt-5 max-w-2xl text-center text-base leading-[1.7] text-cream/55 sm:text-lg">
          {t("glossary.indexDescription")}
        </p>
      </section>

      <section className="relative z-10 w-full max-w-3xl pb-20">
        <ul className="space-y-1">
          {terms.map((term) => (
            <li key={term.slug}>
              <Link
                href={`/glossary/${term.slug}`}
                className="group block rounded-2xl border border-cream/[0.06] bg-cream/[0.015] p-6 transition hover:border-cream/[0.12] hover:bg-cream/[0.025] sm:p-8"
              >
                <div className="flex items-center justify-between gap-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-sodium/80 sm:text-[11px]">
                    {term.slug}
                  </p>
                  <span
                    className="text-cream/30 transition-transform group-hover:translate-x-0.5 group-hover:text-cream"
                    aria-hidden
                  >
                    →
                  </span>
                </div>
                <h2 className="mt-3 text-xl font-light leading-snug tracking-[-0.02em] text-cream sm:text-2xl">
                  {term.term}
                </h2>
                <p className="mt-3 text-sm leading-[1.7] text-cream/55 sm:text-base">
                  {term.definition}
                </p>
                {term.synonyms.length > 0 && (
                  <p className="mt-3 text-xs text-cream/40">
                    {t("glossary.alsoCalled")} {term.synonyms.join(", ")}
                  </p>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
