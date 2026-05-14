import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { pageMetadata } from "@/lib/page-metadata";
import { getAllBlogPosts } from "@/lib/blog";

const POSTS_PER_PAGE = 10;

export const dynamic = "force-static";

interface PageProps {
  params: Promise<{ locale: string; n: string }>;
}

async function pageCount(): Promise<number> {
  const all = await getAllBlogPosts("en");
  return Math.max(1, Math.ceil(all.length / POSTS_PER_PAGE));
}

export async function generateStaticParams() {
  const total = await pageCount();
  // Page 1 is /blog itself; only generate /blog/page/2..N for older pages.
  const pages = Array.from({ length: Math.max(0, total - 1) }, (_, i) =>
    String(i + 2),
  );
  return ALL_LOCALES.flatMap((locale) =>
    pages.map((n) => ({ locale, n })),
  );
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, n } = await params;
  const t = await getTranslations({ locale, namespace: "blog" });
  return pageMetadata({
    locale: locale as Locale,
    path: `/blog/page/${n}`,
    title: t("pagination.title", { page: n }),
    description: t("pagination.description", { page: n }),
  });
}

export default async function BlogOlderPage({ params }: PageProps) {
  const { locale, n } = await params;
  setRequestLocale(locale as Locale);
  const t = await getTranslations({ locale, namespace: "blog" });

  const num = Number.parseInt(n, 10);
  if (!Number.isFinite(num) || num < 2) notFound();

  const all = await getAllBlogPosts(locale as Locale);
  const totalPages = Math.max(1, Math.ceil(all.length / POSTS_PER_PAGE));
  if (num > totalPages) notFound();

  const start = (num - 1) * POSTS_PER_PAGE;
  const posts = all.slice(start, start + POSTS_PER_PAGE);

  return (
    <main className="flex flex-col items-center px-6">
      <section className="relative z-10 flex flex-col items-center pt-12 pb-12 sm:pt-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sodium/80">
          {t("pagination.pageLabel", { page: num })}
        </p>
        <h1 className="mt-4 text-[2.5rem] font-extralight leading-[1.05] tracking-[-0.03em] text-cream sm:text-[3rem] md:text-[3.5rem]">
          {t("pagination.headline")}
        </h1>
        <p className="mt-3">
          <Link href="/blog" className="text-sm text-cream/45 underline-offset-4 hover:underline">
            {t("pagination.latestPosts")}
          </Link>
        </p>
      </section>

      <section className="relative z-10 w-full max-w-3xl pb-10">
        <ul className="space-y-1">
          {posts.map((p) => (
            <li key={p.slug}>
              <Link
                href={`/blog/${p.slug}`}
                className="group block rounded-2xl border border-cream/[0.06] bg-cream/[0.015] p-6 transition hover:border-cream/[0.12] hover:bg-cream/[0.025] sm:p-8"
              >
                <div className="flex items-center justify-between gap-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-sodium/80 sm:text-[11px]">
                    {p.tag} · {p.publishedAt}
                  </p>
                  <span
                    className="text-cream/30 transition-transform group-hover:translate-x-0.5 group-hover:text-cream"
                    aria-hidden
                  >
                    →
                  </span>
                </div>
                <h2 className="mt-3 text-xl font-light leading-snug tracking-[-0.02em] text-cream sm:text-2xl">
                  {p.title}
                </h2>
                <p className="mt-3 text-sm leading-[1.7] text-cream/55 sm:text-base">
                  {p.summary}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {totalPages > num && (
        <nav
          aria-label="Blog pagination"
          className="relative z-10 flex w-full max-w-3xl items-center justify-between pb-20"
        >
          <Link
            href={num === 2 ? "/blog" : `/blog/page/${num - 1}`}
            className="text-sm text-cream/65 hover:text-cream"
            rel="prev"
          >
            {t("pagination.newer")}
          </Link>
          <span className="text-xs font-mono text-cream/45">
            {t("pagination.pageOf", { current: num, total: totalPages })}
          </span>
          <Link
            href={`/blog/page/${num + 1}`}
            className="text-sm text-cream/65 hover:text-cream"
            rel="next"
          >
            {t("pagination.older")}
          </Link>
        </nav>
      )}
    </main>
  );
}
