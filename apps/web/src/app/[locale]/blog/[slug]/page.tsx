import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { isIndexableLocale } from "@ellul.ai/i18n-consts/indexability";
import { Link } from "@/i18n/routing";
import { pageMetadata } from "@/lib/page-metadata";
import {
  allTagsFor,
  listBlogSlugs,
  getBlogPost,
  getAllBlogPosts,
  tagSlug,
  type BlogPostMeta,
} from "@/lib/blog";
import {
  articleSchema,
  breadcrumbSchema,
  faqPageSchema,
  personSchema,
} from "@/lib/structured-data";
import { buildBlogMdxComponents } from "@/components/blog/mdx-components";
import { AuthorCard } from "@/components/blog/AuthorCard";
import { BlogPostScrollReporter } from "@/components/analytics/content-events";
import { Breadcrumb } from "@/components/seo/Breadcrumb";
import { RelatedContent } from "@/components/seo/RelatedContent";
import { extractHeadings } from "@/lib/extract-headings";
import { TableOfContents } from "@/components/seo/TableOfContents";
import { getAuthor } from "@/content/authors/loader";
import type { Author } from "@/content/authors/schema";

const SITE_URL = process.env.NEXT_PUBLIC_WEB_URL!;

interface PageProps {
  params: Promise<{ locale: string; slug: string }>;
}

export const dynamic = "force-static";

export function generateStaticParams() {
  const slugs = listBlogSlugs();
  return ALL_LOCALES.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug })),
  );
}

async function resolveAuthors(
  meta: BlogPostMeta,
  locale: Locale,
): Promise<{ resolved: Author[]; nameOnly: Array<{ name: string }> }> {
  const resolved: Author[] = [];
  const nameOnly: Array<{ name: string }> = [];
  for (const a of meta.authors) {
    if ("handle" in a) {
      const found = await getAuthor(a.handle, locale);
      if (found) {
        resolved.push(found);
        nameOnly.push({ name: found.name });
      }
    } else {
      nameOnly.push({ name: a.name });
    }
  }
  return { resolved, nameOnly };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale: rawLocale, slug } = await params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : "en") as Locale;

  const post = await getBlogPost(slug, locale);
  if (!post) return {};

  const { nameOnly } = await resolveAuthors(post.meta, locale);

  const base = pageMetadata({
    locale,
    path: `/blog/${slug}`,
    title: post.meta.title,
    description: post.meta.summary,
    ogType: "article",
    publishedTime: post.meta.publishedAt,
    authors: nameOnly,
    keywords: post.meta.keywords,
  });

  const eligible = new Set(
    post.availableLocales.filter((l) => isIndexableLocale("web", l)),
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

function relatedPosts(
  current: BlogPostMeta,
  all: BlogPostMeta[],
  limit = 3,
): BlogPostMeta[] {
  const currentTags = new Set(allTagsFor(current).map((t) => tagSlug(t)));
  const scored = all
    .filter((p) => p.slug !== current.slug)
    .map((p) => {
      const overlap = allTagsFor(p).filter((t) =>
        currentTags.has(tagSlug(t)),
      ).length;
      return { post: p, overlap };
    })
    .filter((s) => s.overlap > 0)
    .sort((a, b) => {
      if (b.overlap !== a.overlap) return b.overlap - a.overlap;
      return (
        new Date(b.post.publishedAt).getTime() -
        new Date(a.post.publishedAt).getTime()
      );
    });
  return scored.slice(0, limit).map((s) => s.post);
}

export default async function BlogPostPage({ params }: PageProps) {
  const { locale: rawLocale, slug } = await params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : "en") as Locale;
  setRequestLocale(locale);

  const post = await getBlogPost(slug, locale);
  if (!post) notFound();

  const url = `${SITE_URL}/blog/${slug}`;
  const { resolved: resolvedAuthors, nameOnly } = await resolveAuthors(post.meta, locale);

  const articleJsonLd = articleSchema({
    headline: post.meta.title,
    description: post.meta.summary,
    url,
    datePublished: post.meta.publishedAt,
    dateModified: post.meta.updatedAt,
    section: post.meta.tag,
    keywords: post.meta.keywords?.join(", "),
    locale,
    type: "BlogPosting",
    image: post.meta.ogImage
      ? `${SITE_URL}${post.meta.ogImage}`
      : `${SITE_URL}/blog/${slug}/opengraph-image`,
  });

  const breadcrumbJsonLd = breadcrumbSchema([
    { name: "Home", url: SITE_URL },
    { name: "Blog", url: `${SITE_URL}/blog` },
    { name: post.meta.title, url },
  ]);

  const faqJsonLd = post.meta.faq?.length ? faqPageSchema(post.meta.faq) : null;

  const personJsonLds = resolvedAuthors.map((a) =>
    personSchema({
      name: a.name,
      description: a.bio,
      url: a.url,
      image: a.avatar,
      jobTitle: a.jobTitle,
      sameAs: [
        a.twitter
          ? `https://twitter.com/${a.twitter.replace(/^@/, "")}`
          : null,
        a.github ? `https://github.com/${a.github}` : null,
      ].filter((s): s is string => Boolean(s)),
    }),
  );

  const all = await getAllBlogPosts(locale);
  const related = relatedPosts(post.meta, all);

  const headings = extractHeadings(post.content);
  const components = buildBlogMdxComponents(post.meta.faq ?? []);

  return (
    <main className="flex flex-col items-center px-6">
      <BlogPostScrollReporter slug={slug} />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
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
      {personJsonLds.map((p, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(p) }}
        />
      ))}

      <article className="relative z-10 w-full max-w-3xl pt-12 pb-16 sm:pt-16">
        <header className="mb-10">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sodium/80">
            <Link
              href={`/blog/tag/${tagSlug(post.meta.tag)}`}
              className="hover:text-sodium"
            >
              {post.meta.tag}
            </Link>{" "}
            · {post.meta.publishedAt}
          </p>
          <h1 className="mt-4 text-[2.25rem] font-extralight leading-[1.05] tracking-[-0.03em] text-cream sm:text-[2.75rem] md:text-[3.25rem]">
            {post.meta.title}
          </h1>
          <p className="mt-5 text-base leading-[1.7] text-cream/55 sm:text-lg">
            {post.meta.summary}
          </p>
          {post.meta.authors.length > 0 && (
            <p className="mt-3 text-xs text-cream/45">
              By{" "}
              {post.meta.authors.map((a, i) => {
                if ("handle" in a) {
                  const resolved = resolvedAuthors.find((r) => r.handle === a.handle);
                  return (
                    <span key={i}>
                      {i > 0 && ", "}
                      <Link
                        href={`/authors/${a.handle}`}
                        className="underline decoration-cream/20 underline-offset-2 transition hover:text-cream hover:decoration-cream/50"
                      >
                        {resolved?.name ?? a.handle}
                      </Link>
                    </span>
                  );
                }
                return (
                  <span key={i}>
                    {i > 0 && ", "}
                    {a.name}
                  </span>
                );
              })}
            </p>
          )}
        </header>

        {headings.length >= 3 && (
          <div className="mb-8 rounded-2xl border border-cream/[0.06] bg-cream/[0.02] p-5">
            <TableOfContents headings={headings} />
          </div>
        )}

        <div className="space-y-6 text-[15px] leading-[1.8] text-cream/80 sm:text-base">
          <MDXRemote
            source={post.content}
            components={components}
            options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
          />
        </div>

        {resolvedAuthors[0] && <AuthorCard author={resolvedAuthors[0]} />}

        {allTagsFor(post.meta).length > 0 && (
          <div className="mt-10 flex flex-wrap gap-2">
            {allTagsFor(post.meta).map((t) => (
              <Link
                key={t}
                href={`/blog/tag/${tagSlug(t)}`}
                className="rounded-full border border-cream/[0.08] bg-cream/[0.02] px-3 py-1.5 text-xs text-cream/65 transition hover:border-cream/20 hover:text-cream"
              >
                {t}
              </Link>
            ))}
          </div>
        )}

        {related.length > 0 && (
          <section className="mt-16 border-t border-cream/[0.06] pt-10">
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/45">
              Related posts
            </p>
            <ul className="mt-4 space-y-1">
              {related.map((r) => (
                <li key={r.slug}>
                  <Link
                    href={`/blog/${r.slug}`}
                    className="group block rounded-2xl border border-cream/[0.06] bg-cream/[0.015] p-4 transition hover:border-cream/[0.12] hover:bg-cream/[0.025]"
                  >
                    <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-sodium/80">
                      {r.tag} · {r.publishedAt}
                    </p>
                    <p className="mt-2 text-base font-light leading-snug tracking-[-0.02em] text-cream">
                      {r.title}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </article>

      <RelatedContent slug={slug} contentType="blog" locale={locale} />
    </main>
  );
}
