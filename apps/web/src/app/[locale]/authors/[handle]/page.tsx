import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { Link } from "@/i18n/routing";
import { pageMetadata } from "@/lib/page-metadata";
import { listAuthorHandles, getAuthor } from "@/content/authors/loader";
import { getAllBlogPosts, type BlogPostMeta } from "@/lib/blog";
import { breadcrumbSchema, personSchema } from "@/lib/structured-data";

const SITE_URL = "https://ellul.ai";

export const dynamic = "force-static";

interface PageProps {
  params: Promise<{ locale: string; handle: string }>;
}

export function generateStaticParams() {
  const handles = listAuthorHandles();
  return ALL_LOCALES.flatMap((locale) =>
    handles.map((handle) => ({ locale, handle })),
  );
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale: rawLocale, handle } = await params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : "en") as Locale;

  const author = await getAuthor(handle, locale);
  if (!author) return {};

  return pageMetadata({
    locale,
    path: `/authors/${handle}`,
    title: `${author.name} — ellul`,
    description: author.bio,
  });
}

async function getPostsByAuthor(
  handle: string,
  locale: Locale,
): Promise<BlogPostMeta[]> {
  const all = await getAllBlogPosts(locale);
  return all.filter((p) =>
    p.authors.some((a) => "handle" in a && a.handle === handle),
  );
}

export default async function AuthorPage({ params }: PageProps) {
  const { locale: rawLocale, handle } = await params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : "en") as Locale;
  setRequestLocale(locale);

  const author = await getAuthor(handle, locale);
  if (!author) notFound();

  const t = await getTranslations({ locale, namespace: "pages" });
  const posts = await getPostsByAuthor(handle, locale);

  const personJsonLd = personSchema({
    name: author.name,
    description: author.bio,
    url: author.url ?? `${SITE_URL}/authors/${handle}`,
    image: author.avatar ? `${SITE_URL}${author.avatar}` : undefined,
    jobTitle: author.jobTitle,
    sameAs: [
      author.twitter
        ? `https://twitter.com/${author.twitter.replace(/^@/, "")}`
        : null,
      author.github ? `https://github.com/${author.github}` : null,
    ].filter((s): s is string => Boolean(s)),
  });

  const breadcrumbJsonLd = breadcrumbSchema([
    { name: t("common.home"), url: SITE_URL },
    { name: t("authors.breadcrumb"), url: `${SITE_URL}/authors` },
    { name: author.name, url: `${SITE_URL}/authors/${handle}` },
  ]);

  return (
    <main className="flex flex-col items-center px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(personJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />

      <section className="relative z-10 w-full max-w-3xl pt-12 pb-16 sm:pt-16">
        <div className="flex items-center gap-5">
          {author.avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={author.avatar}
              alt=""
              className="h-16 w-16 shrink-0 rounded-full border border-cream/[0.1]"
            />
          ) : (
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-sodium/20 font-mono text-lg text-sodium">
              {author.name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div>
            <h1 className="text-[2rem] font-extralight leading-[1.1] tracking-[-0.03em] text-cream sm:text-[2.5rem]">
              {author.name}
            </h1>
            {author.jobTitle && (
              <p className="mt-1 text-sm text-cream/45">{author.jobTitle}</p>
            )}
          </div>
        </div>

        <p className="mt-6 text-base leading-[1.7] text-cream/65 sm:text-lg">
          {author.bio}
        </p>

        <div className="mt-4 flex items-center gap-4 text-xs text-cream/45">
          {author.twitter && (
            <a
              href={`https://twitter.com/${author.twitter.replace(/^@/, "")}`}
              className="hover:text-sodium"
              rel="noopener noreferrer"
            >
              @{author.twitter.replace(/^@/, "")}
            </a>
          )}
          {author.github && (
            <a
              href={`https://github.com/${author.github}`}
              className="hover:text-sodium"
              rel="noopener noreferrer"
            >
              github.com/{author.github}
            </a>
          )}
        </div>

        <section className="mt-12 border-t border-cream/[0.06] pt-10">
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/45">
            {t("authors.postsBy", { name: author.name })}
          </p>
          {posts.length > 0 ? (
            <ul className="mt-4 space-y-1">
              {posts.map((p) => (
                <li key={p.slug}>
                  <Link
                    href={`/blog/${p.slug}`}
                    className="group block rounded-2xl border border-cream/[0.06] bg-cream/[0.015] p-4 transition hover:border-cream/[0.12] hover:bg-cream/[0.025]"
                  >
                    <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-sodium/80">
                      {p.tag} &middot; {p.publishedAt}
                    </p>
                    <p className="mt-2 text-base font-light leading-snug tracking-[-0.02em] text-cream">
                      {p.title}
                    </p>
                    <p className="mt-1.5 text-sm leading-[1.6] text-cream/50">
                      {p.summary}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-cream/40">{t("authors.noPosts")}</p>
          )}
        </section>
      </section>
    </main>
  );
}
