import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { isIndexableLocale } from "@ellul.ai/i18n-consts/indexability";
import { Link } from "@/i18n/routing";
import { pageMetadata } from "@/lib/page-metadata";
import {
  articleSchema,
  breadcrumbSchema,
  faqPageSchema,
  howToSchema,
} from "@/lib/structured-data";
import {
  getMcpDoc,
  getMcpMeta,
  hasMcpMdx,
  listMcpSlugs,
} from "@/content/mcp/loader";
import { buildSharedMdxComponents } from "@/components/mdx";
import { LastUpdated } from "@/components/comparison/LastUpdated";
import { McpViewedReporter } from "@/components/analytics/content-events";
import { Breadcrumb } from "@/components/seo/Breadcrumb";
import { RelatedContent } from "@/components/seo/RelatedContent";
import { extractHeadings } from "@/lib/extract-headings";
import { TableOfContents } from "@/components/seo/TableOfContents";

const SITE_URL = "https://ellul.ai";
const CONSOLE_URL =
  process.env.NEXT_PUBLIC_CONSOLE_URL!;

export const dynamic = "force-static";

interface PageProps {
  params: Promise<{ locale: string; slug: string }>;
}

export function generateStaticParams() {
  const slugs = listMcpSlugs();
  return ALL_LOCALES.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug })),
  );
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { locale: rawLocale, slug } = await params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : "en") as Locale;

  const meta = await getMcpMeta(slug, locale);
  if (!meta) return {};

  const ready = hasMcpMdx(slug);

  const base = pageMetadata({
    locale,
    path: `/mcp/${slug}`,
    title: `${meta.name}: MCP on Ellul`,
    description: meta.description,
    ogType: "article",
    publishedTime: meta.publishedAt,
  });

  if (!ready) {
    return { ...base, robots: { index: false, follow: true } };
  }
  return base;
}

export default async function McpPage({ params }: PageProps) {
  const { locale: rawLocale, slug } = await params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : "en") as Locale;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: "pages" });

  const meta = await getMcpMeta(slug, locale);
  if (!meta) notFound();

  const ready = hasMcpMdx(slug, locale) || hasMcpMdx(slug);
  const doc = ready ? await getMcpDoc(slug, locale) : null;

  const url = `${SITE_URL}/mcp/${slug}`;

  const articleJsonLd = ready
    ? articleSchema({
        headline: `${meta.name}: MCP on Ellul`,
        description: meta.description,
        url,
        datePublished: meta.publishedAt,
        dateModified: meta.lastUpdated,
        locale,
        type: meta.structuredDataType === "TechArticle" ? "TechArticle" : "Article",
        image: meta.ogImage
          ? `${SITE_URL}${meta.ogImage}`
          : `${SITE_URL}/mcp/${slug}/opengraph-image`,
      })
    : null;

  const howToJsonLd =
    meta.structuredDataType === "HowTo" && ready
      ? howToSchema({
          name: `${meta.name}: MCP on Ellul`,
          description: meta.description,
          url,
          datePublished: meta.publishedAt,
          dateModified: meta.lastUpdated,
        })
      : null;

  const breadcrumbJsonLd = breadcrumbSchema([
    { name: t("common.home"), url: SITE_URL },
    { name: t("mcpHub.breadcrumb"), url: `${SITE_URL}/mcp` },
    { name: meta.name, url },
  ]);

  const faqJsonLd = ready && meta.faq.length ? faqPageSchema(meta.faq) : null;

  const headings = ready && doc ? extractHeadings(doc.content) : [];
  const components = buildSharedMdxComponents({ faqItems: meta.faq });

  return (
    <main className="flex flex-col items-center px-6">
      <McpViewedReporter slug={slug} />
      {articleJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
        />
      )}
      {howToJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(howToJsonLd) }}
        />
      )}
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

      <div className="relative z-10 w-full max-w-3xl pt-8">
        <Breadcrumb
          items={[
            { name: "Home", href: "/" },
            { name: "MCP", href: "/mcp" },
            { name: meta.name, href: `/mcp/${slug}` },
          ]}
        />
      </div>

      <article className="relative z-10 w-full max-w-3xl pt-12 pb-16 sm:pt-16">
        <header className="mb-10">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sodium/80">
            {meta.hero.eyebrow}
          </p>
          <h1 className="mt-4 text-[2.25rem] font-extralight leading-[1.05] tracking-[-0.03em] text-cream sm:text-[2.75rem] md:text-[3.25rem]">
            {meta.hero.headline}
          </h1>
          <p className="mt-5 text-base leading-[1.7] text-cream/55 sm:text-lg">
            {meta.hero.sub}
          </p>
          <div className="mt-5">
            <LastUpdated date={meta.lastUpdated} />
          </div>
        </header>

        <section className="mb-10 rounded-2xl border border-cream/[0.06] bg-cream/[0.02] p-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-sodium/80">
            Capabilities on Ellul
          </p>
          <ul className="mt-4 space-y-2">
            {meta.capabilities.map((cap) => (
              <li
                key={cap}
                className="flex gap-3 text-sm leading-[1.6] text-cream/80"
              >
                <span className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-sodium" />
                <span>{cap}</span>
              </li>
            ))}
          </ul>
          {meta.vendor && (
            <p className="mt-4 text-xs text-cream/45">
              {meta.kind === "server" ? "Server" : meta.kind === "client" ? "Client" : meta.kind === "hub" ? "Hub" : "Guide"} · {meta.vendor}
            </p>
          )}
        </section>

        {ready && doc && headings.length >= 3 && (
          <div className="mb-8 rounded-2xl border border-cream/[0.06] bg-cream/[0.02] p-5">
            <TableOfContents headings={headings} />
          </div>
        )}

        {ready && doc && (
          <div className="space-y-6 text-[15px] leading-[1.8] text-cream/80 sm:text-base">
            <MDXRemote
              source={doc.content}
              components={components}
              options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
            />
          </div>
        )}

        {!ready && (
          <section className="rounded-2xl border border-cream/[0.06] bg-cream/[0.015] p-6 sm:p-8">
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/45">
              Deep guide
            </p>
            <p className="mt-3 text-sm leading-[1.7] text-cream/70 sm:text-base">
              Coming soon. The capabilities above describe what's already
              supported on Ellul today; the full setup walkthrough ships in a
              follow-up phase. Until then, the{" "}
              <Link href="/mcp" className="text-sodium underline-offset-4 hover:underline">
                MCP hub
              </Link>{" "}
              covers the common ground.
            </p>
            {meta.url && (
              <div className="mt-4 flex flex-wrap gap-2">
                <a
                  href={meta.url}
                  rel="noopener noreferrer"
                  className="rounded-full border border-cream/[0.08] bg-cream/[0.02] px-3 py-1.5 text-xs text-cream/65 transition hover:border-cream/20 hover:text-cream"
                >
                  {meta.name} reference →
                </a>
              </div>
            )}
          </section>
        )}

        <footer className="mt-12 flex flex-wrap items-center gap-3 border-t border-cream/[0.06] pt-8">
          <a
            href={`${CONSOLE_URL}/sign-up?ref=mcp-${slug}`}
            data-cta="mcp-primary"
            data-source-page={`/mcp/${slug}`}
            className="rounded-md bg-sodium px-5 py-2.5 text-sm font-semibold text-ink transition hover:bg-sodium-strong"
          >
            Set up MCP on a workstation
          </a>
          <Link
            href="/mcp"
            className="text-sm text-cream/65 transition hover:text-cream"
          >
            ← All MCP entries
          </Link>
        </footer>
      </article>

      <RelatedContent slug={slug} contentType="mcp" locale={locale} />
    </main>
  );
}
