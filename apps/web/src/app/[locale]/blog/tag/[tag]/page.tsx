import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { pageMetadata } from "@/lib/page-metadata";
import {
  allTagsFor,
  getAllBlogPosts,
  tagSlug,
  type BlogPostMeta,
} from "@/lib/blog";
import {
  blogItemListSchema,
  breadcrumbSchema,
} from "@/lib/structured-data";

const SITE_URL = "https://ellul.ai";

export const dynamic = "force-static";

interface PageProps {
  params: Promise<{ locale: string; tag: string }>;
}

async function getKnownTags(): Promise<Map<string, string>> {
  const posts = await getAllBlogPosts("en");
  const map = new Map<string, string>();
  for (const p of posts) {
    for (const t of allTagsFor(p)) {
      map.set(tagSlug(t), t);
    }
  }
  return map;
}

export async function generateStaticParams() {
  const map = await getKnownTags();
  const tags = [...map.keys()];
  return ALL_LOCALES.flatMap((locale) =>
    tags.map((tag) => ({ locale, tag })),
  );
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, tag: tagSlugParam } = await params;
  const map = await getKnownTags();
  const displayTag = map.get(tagSlugParam);
  if (!displayTag) return {};
  const t = await getTranslations({ locale, namespace: "blog" });
  return pageMetadata({
    locale: locale as Locale,
    path: `/blog/tag/${tagSlugParam}`,
    title: `${displayTag} · ellul blog`,
    description: t("tag.description", { tag: displayTag }),
  });
}

export default async function BlogTagPage({ params }: PageProps) {
  const { locale, tag: tagSlugParam } = await params;
  setRequestLocale(locale as Locale);
  const t = await getTranslations({ locale, namespace: "blog" });

  const map = await getKnownTags();
  const displayTag = map.get(tagSlugParam);
  if (!displayTag) notFound();

  const all = await getAllBlogPosts(locale as Locale);
  const posts: BlogPostMeta[] = all.filter((p) =>
    allTagsFor(p).some((t) => tagSlug(t) === tagSlugParam),
  );

  const itemListJsonLd = blogItemListSchema(
    posts.map((p) => ({ slug: p.slug, title: p.title })),
  );
  const breadcrumbJsonLd = breadcrumbSchema([
    { name: "Home", url: SITE_URL },
    { name: "Blog", url: `${SITE_URL}/blog` },
    { name: displayTag, url: `${SITE_URL}/blog/tag/${tagSlugParam}` },
  ]);

  return (
    <main className="flex flex-col items-center px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(itemListJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />

      <section className="relative z-10 flex flex-col items-center pt-12 pb-12 sm:pt-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sodium/80">
          Tag · {displayTag}
        </p>
        <h1 className="mt-4 text-[2.5rem] font-extralight leading-[1.05] tracking-[-0.03em] text-cream sm:text-[3rem] md:text-[3.5rem]">
          {displayTag}
        </h1>
        <p className="mt-5 max-w-2xl text-center text-base leading-[1.7] text-cream/55 sm:text-lg">
          {t("tag.postsTagged", { count: posts.length, tag: displayTag })}
        </p>
        <p className="mt-3">
          <Link
            href="/blog"
            className="text-sm text-cream/45 underline-offset-4 hover:underline"
          >
            {t("tag.backToAll")}
          </Link>
        </p>
      </section>

      <section className="relative z-10 w-full max-w-3xl pb-20">
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
    </main>
  );
}
