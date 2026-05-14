import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import type { Locale } from "@ellul.ai/i18n-consts";
import { pageMetadata } from "@/lib/page-metadata";
import {
  allTagsFor,
  getAllBlogPosts,
  tagSlug,
} from "@/lib/blog";
import {
  blogSchema,
  blogItemListSchema,
  type BlogPostingRef,
} from "@/lib/structured-data";

export const dynamic = "force-static";

const SITE_URL = process.env.NEXT_PUBLIC_WEB_URL!;
const POSTS_PER_PAGE = 10;

interface BlogPageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({
  params,
}: BlogPageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "blog" });
  return pageMetadata({
    locale: locale as Locale,
    path: "/blog",
    title: t("index.title"),
    description: t("index.description"),
  });
}

export default async function BlogIndex({ params }: BlogPageProps) {
  const { locale } = await params;
  setRequestLocale(locale as Locale);
  const t = await getTranslations({ locale, namespace: "blog" });

  const allPosts = await getAllBlogPosts(locale as Locale);
  // First page only on the index. Older pages live at /blog/page/[n] (added
  // when the post count crosses POSTS_PER_PAGE so the static head stays
  // intact on /blog itself; Lighthouse SEO checks fire pre-hydration).
  const posts = allPosts.slice(0, POSTS_PER_PAGE);
  const hasMore = allPosts.length > POSTS_PER_PAGE;

  const allTags = new Map<string, string>();
  for (const p of allPosts) {
    for (const t of allTagsFor(p)) {
      allTags.set(tagSlug(t), t);
    }
  }

  const blogPostsForSchema: BlogPostingRef[] = posts.map((p) => ({
    "@type": "BlogPosting",
    headline: p.title,
    url: `${SITE_URL}/blog/${p.slug}`,
    datePublished: p.publishedAt,
    dateModified: p.updatedAt,
    description: p.summary,
  }));

  const blogJsonLd = blogSchema({
    locale,
    description: t("index.description"),
    posts: blogPostsForSchema,
  });

  const itemListJsonLd = blogItemListSchema(
    posts.map((p) => ({ slug: p.slug, title: p.title })),
  );

  return (
    <main className="flex flex-col items-center px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd) }}
      />

      <section className="relative z-10 flex flex-col items-center pt-12 pb-12 sm:pt-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sodium/80">
          {t("index.eyebrow")}
        </p>
        <h1 className="mt-4 text-[2.5rem] font-extralight leading-[1.05] tracking-[-0.03em] text-cream sm:text-[3rem] md:text-[3.5rem]">
          {t("index.headline")}
        </h1>
        <p className="mt-5 max-w-2xl text-center text-base leading-[1.7] text-cream/55 sm:text-lg">
          {t("index.subhead")}
        </p>
        <p className="mt-3">
          <a
            href="/blog/rss.xml"
            className="text-xs font-mono uppercase tracking-[0.22em] text-cream/45 transition hover:text-sodium"
          >
            RSS
          </a>
        </p>
      </section>

      {allTags.size > 0 && (
        <section className="relative z-10 w-full max-w-3xl pb-6">
          <div className="flex flex-wrap items-center gap-2">
            {[...allTags.entries()].map(([slug, label]) => (
              <Link
                key={slug}
                href={`/blog/tag/${slug}`}
                className="rounded-full border border-cream/[0.08] bg-cream/[0.02] px-3 py-1.5 text-xs text-cream/65 transition hover:border-cream/20 hover:text-cream"
              >
                {label}
              </Link>
            ))}
          </div>
        </section>
      )}

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
                <p className="mt-3 text-sm leading-[1.7] text-cream/55 sm:text-base">{p.summary}</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {hasMore && (
        <nav
          aria-label="Blog pagination"
          className="relative z-10 flex w-full max-w-3xl items-center justify-end pb-20"
        >
          <Link
            href={`/blog/page/2`}
            className="text-sm text-cream/65 hover:text-cream"
            rel="next"
          >
            {t("index.olderPosts")}
          </Link>
        </nav>
      )}
    </main>
  );
}
