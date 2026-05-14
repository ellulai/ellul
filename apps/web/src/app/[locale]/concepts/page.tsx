import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import type { Locale } from "@ellul.ai/i18n-consts";
import { pageMetadata } from "@/lib/page-metadata";
import { getAllPillars } from "@/content/pillars/loader";
import { breadcrumbSchema, itemListSchema } from "@/lib/structured-data";

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
    path: "/concepts",
    title: t("concepts.indexTitle"),
    description: t("concepts.indexDescription"),
  });
}

export default async function ConceptsIndex({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale as Locale);
  const t = await getTranslations({ locale, namespace: "pages" });

  const pillars = await getAllPillars(locale as Locale);
  const breadcrumbJsonLd = breadcrumbSchema([
    { name: t("common.home"), url: SITE_URL },
    { name: t("concepts.breadcrumb"), url: `${SITE_URL}/concepts` },
  ]);
  const itemListJsonLd = itemListSchema({
    name: "ellul concepts",
    items: pillars.map((p) => ({
      name: p.title,
      url: `${SITE_URL}/concepts/${p.slug}`,
      description: p.description,
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
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd) }}
      />

      <section className="relative z-10 flex flex-col items-center pt-12 pb-12 sm:pt-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sodium/80">
          {t("concepts.indexEyebrow")}
        </p>
        <h1 className="mt-4 max-w-3xl text-center text-[2.5rem] font-extralight leading-[1.05] tracking-[-0.03em] text-cream sm:text-[3rem] md:text-[3.5rem]">
          {t("concepts.indexHeadline")}
        </h1>
        <p className="mt-5 max-w-2xl text-center text-base leading-[1.7] text-cream/55 sm:text-lg">
          {t("concepts.indexDescription")}
        </p>
      </section>

      <section className="relative z-10 w-full max-w-3xl pb-20">
        <ul className="space-y-1">
          {pillars.map((p) => (
            <li key={p.slug}>
              <Link
                href={`/concepts/${p.slug}`}
                className="group block rounded-2xl border border-cream/[0.06] bg-cream/[0.015] p-6 transition hover:border-cream/[0.12] hover:bg-cream/[0.025] sm:p-8"
              >
                <div className="flex items-center justify-between gap-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-sodium/80 sm:text-[11px]">
                    {p.hero.eyebrow}
                  </p>
                  <span
                    className="text-cream/30 transition-transform group-hover:translate-x-0.5 group-hover:text-cream"
                    aria-hidden
                  >
                    →
                  </span>
                </div>
                <h2 className="mt-3 text-xl font-light leading-snug tracking-[-0.02em] text-cream sm:text-2xl">
                  {p.hero.headline}
                </h2>
                <p className="mt-3 text-sm leading-[1.7] text-cream/55 sm:text-base">
                  {p.description}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
