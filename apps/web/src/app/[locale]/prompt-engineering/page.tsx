import fs from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import matter from "gray-matter";
import { ALL_LOCALES, DEFAULT_LOCALE, type Locale } from "@ellul.ai/i18n-consts";
import { Link } from "@/i18n/routing";
import { pageMetadata } from "@/lib/page-metadata";
import {
  articleSchema,
  breadcrumbSchema,
  faqPageSchema,
} from "@/lib/structured-data";
import { buildSharedMdxComponents } from "@/components/mdx";
import { Breadcrumb } from "@/components/seo/Breadcrumb";
import { extractHeadings } from "@/lib/extract-headings";
import { TableOfContents } from "@/components/seo/TableOfContents";

const SITE_URL = "https://ellul.ai";
const CONSOLE_URL =
  process.env.NEXT_PUBLIC_CONSOLE_URL!;

const PUBLISHED_AT = "2026-04-30";
const LAST_UPDATED = "2026-04-30";

function readContent(locale: Locale): string {
  const dir = path.join(
    process.cwd(),
    "src",
    "content",
    "static",
    "prompt-engineering",
  );
  const localized = path.join(dir, `${locale}.mdx`);
  const fallback = path.join(dir, `${DEFAULT_LOCALE}.mdx`);
  const filePath = fs.existsSync(localized) ? localized : fallback;
  const raw = fs.readFileSync(filePath, "utf-8");
  return matter(raw).content;
}

export const dynamic = "force-static";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale: rawLocale } = await params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : DEFAULT_LOCALE) as Locale;
  const t = await getTranslations({ locale, namespace: "promptEngineering" });
  return pageMetadata({
    locale,
    path: "/prompt-engineering",
    title: t("page.title"),
    description: t("page.description"),
    ogType: "article",
    publishedTime: PUBLISHED_AT,
    keywords: [
      "prompt engineering",
      "agent prompts",
      "always-on agent prompts",
      "parallel agent prompts",
      "MCP prompting",
    ],
  });
}

export default async function PromptEngineeringPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : DEFAULT_LOCALE) as Locale;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: "promptEngineering" });
  const faqItems = await getFaqItems(locale);

  const url = `${SITE_URL}/prompt-engineering`;
  const content = readContent(locale);
  const headings = extractHeadings(content);
  const components = buildSharedMdxComponents({ faqItems });

  const articleJsonLd = articleSchema({
    headline: t("page.title"),
    description: t("page.description"),
    url,
    datePublished: PUBLISHED_AT,
    dateModified: LAST_UPDATED,
    locale,
    type: "Article",
    keywords: "prompt engineering, agent prompts, always-on agent",
    image: `${SITE_URL}/prompt-engineering/opengraph-image`,
  });
  const breadcrumbJsonLd = breadcrumbSchema([
    { name: t("page.breadcrumbHome"), url: SITE_URL },
    { name: t("page.breadcrumbSelf"), url },
  ]);
  const faqJsonLd = faqPageSchema(faqItems);

  return (
    <main className="flex flex-col items-center px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />

      <div className="relative z-10 w-full max-w-3xl pt-8">
        <Breadcrumb
          items={[
            { name: "Home", href: "/" },
            { name: "Prompt Engineering", href: "/prompt-engineering" },
          ]}
        />
      </div>

      <article className="relative z-10 w-full max-w-3xl pt-12 pb-16 sm:pt-16">
        <header className="mb-10">
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sodium/80">
            {t("page.eyebrow")}
          </p>
          <h1 className="mt-4 text-[2.25rem] font-extralight leading-[1.05] tracking-[-0.03em] text-cream sm:text-[2.75rem] md:text-[3.25rem]">
            {t("page.headline")}
          </h1>
          <p className="mt-5 text-base leading-[1.7] text-cream/55 sm:text-lg">
            {t("page.subhead")}
          </p>
        </header>

        {headings.length >= 3 && (
          <div className="mb-8 rounded-2xl border border-cream/[0.06] bg-cream/[0.02] p-5">
            <TableOfContents headings={headings} />
          </div>
        )}

        <div className="space-y-6 text-[15px] leading-[1.8] text-cream/80 sm:text-base">
          <MDXRemote
            source={content}
            components={components}
            options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
          />
        </div>

        <footer className="mt-12 flex flex-wrap items-center gap-3 border-t border-cream/[0.06] pt-8">
          <a
            href={`${CONSOLE_URL}/sign-up?ref=prompt-engineering`}
            data-cta="prompt-engineering-primary"
            data-source-page="/prompt-engineering"
            className="rounded-md bg-sodium px-5 py-2.5 text-sm font-semibold text-ink transition hover:bg-sodium-strong"
          >
            {t("page.cta")}
          </a>
          <Link
            href="/concepts"
            className="text-sm text-cream/65 transition hover:text-cream"
          >
            {t("page.back")}
          </Link>
        </footer>
      </article>
    </main>
  );
}

async function getFaqItems(
  locale: Locale,
): Promise<{ id: string; q: string; a: string }[]> {
  const { loadMessages } = await import("@ellul.ai/i18n-messages/loaders");
  const messages = (await loadMessages(locale)) as {
    promptEngineering?: { faq?: Record<string, { q: string; a: string }> };
  };
  const faq = messages.promptEngineering?.faq ?? {};
  return Object.entries(faq).map(([id, f]) => ({ id, q: f.q, a: f.a }));
}
