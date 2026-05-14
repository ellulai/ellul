import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import type { Locale } from "@ellul.ai/i18n-consts";
import { pageMetadata } from "@/lib/page-metadata";
import { getAllAuthors } from "@/content/authors/loader";
import { breadcrumbSchema, itemListSchema, personSchema } from "@/lib/structured-data";

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
    path: "/authors",
    title: t("authors.indexTitle"),
    description: t("authors.indexDescription"),
  });
}

export default async function AuthorsIndex({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale as Locale);
  const t = await getTranslations({ locale, namespace: "pages" });

  const authors = await getAllAuthors(locale as Locale);

  const breadcrumbJsonLd = breadcrumbSchema([
    { name: t("common.home"), url: SITE_URL },
    { name: t("authors.breadcrumb"), url: `${SITE_URL}/authors` },
  ]);

  const itemListJsonLd = itemListSchema({
    name: "ellul authors",
    items: authors.map((a) => ({
      name: a.name,
      url: `${SITE_URL}/authors/${a.handle}`,
      description: a.bio,
    })),
  });

  const personJsonLds = authors.map((a) =>
    personSchema({
      name: a.name,
      description: a.bio,
      url: a.url ?? `${SITE_URL}/authors/${a.handle}`,
      image: a.avatar ? `${SITE_URL}${a.avatar}` : undefined,
      jobTitle: a.jobTitle,
      sameAs: [
        a.twitter ? `https://twitter.com/${a.twitter.replace(/^@/, "")}` : null,
        a.github ? `https://github.com/${a.github}` : null,
      ].filter((s): s is string => Boolean(s)),
    }),
  );

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
      {personJsonLds.map((p, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(p) }}
        />
      ))}

      <section className="relative z-10 flex flex-col items-center pt-12 pb-12 sm:pt-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sodium/80">
          {t("authors.indexEyebrow")}
        </p>
        <h1 className="mt-4 max-w-3xl text-center text-[2.5rem] font-extralight leading-[1.05] tracking-[-0.03em] text-cream sm:text-[3rem] md:text-[3.5rem]">
          {t("authors.indexHeadline")}
        </h1>
        <p className="mt-5 max-w-2xl text-center text-base leading-[1.7] text-cream/55 sm:text-lg">
          {t("authors.indexDescription")}
        </p>
      </section>

      <section className="relative z-10 w-full max-w-3xl pb-20">
        <ul className="space-y-1">
          {authors.map((a) => (
            <li key={a.handle}>
              <Link
                href={`/authors/${a.handle}`}
                className="group block rounded-2xl border border-cream/[0.06] bg-cream/[0.015] p-6 transition hover:border-cream/[0.12] hover:bg-cream/[0.025] sm:p-8"
              >
                <div className="flex items-center gap-4">
                  {a.avatar ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={a.avatar}
                      alt=""
                      className="h-12 w-12 shrink-0 rounded-full border border-cream/[0.1]"
                    />
                  ) : (
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-sodium/20 font-mono text-sm text-sodium">
                      {a.name.slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <h2 className="text-lg font-light tracking-[-0.02em] text-cream sm:text-xl">
                        {a.name}
                      </h2>
                      <span
                        className="text-cream/30 transition-transform group-hover:translate-x-0.5 group-hover:text-cream"
                        aria-hidden
                      >
                        &rarr;
                      </span>
                    </div>
                    {a.jobTitle && (
                      <p className="mt-0.5 text-xs text-cream/45">{a.jobTitle}</p>
                    )}
                    <p className="mt-2 text-sm leading-[1.7] text-cream/55">
                      {a.bio}
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
