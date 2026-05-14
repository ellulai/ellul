import { NextResponse } from "next/server";
import { ALL_LOCALES, DEFAULT_LOCALE, type Locale } from "@ellul.ai/i18n-consts";
import { loadMessages } from "@ellul.ai/i18n-messages/loaders";
import {
  getUseCase,
  listUseCaseSlugs,
} from "@/content/use-cases/loader";

export const dynamic = "force-static";

const SITE_URL = "https://ellul.ai";

async function loadLabels(locale: Locale): Promise<{
  labelLastUpdated: string;
  headingFaq: string;
}> {
  const messages = (await loadMessages(locale)) as {
    pages?: {
      rawMd?: { labelLastUpdated: string; headingFaq: string };
    };
  };
  const ns = messages.pages?.rawMd;
  if (!ns) throw new Error(`pages.rawMd missing for locale "${locale}"`);
  return { labelLastUpdated: ns.labelLastUpdated, headingFaq: ns.headingFaq };
}

export function generateStaticParams() {
  const slugs = listUseCaseSlugs();
  return ALL_LOCALES.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug })),
  );
}

// /solutions/{slug}/raw.md: markdown rendition of a use-case page.
export async function GET(
  _: Request,
  context: { params: Promise<{ locale: string; slug: string }> },
) {
  const { locale: rawLocale, slug } = await context.params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : DEFAULT_LOCALE) as Locale;
  const u = await getUseCase(slug, locale);
  if (!u) return new NextResponse("Not found", { status: 404 });
  const L = await loadLabels(locale);

  const lines: string[] = [];
  lines.push(`# ${u.meta.title}`);
  lines.push(`URL: ${SITE_URL}/solutions/${slug}`);
  lines.push(`${L.labelLastUpdated}: ${u.meta.lastUpdated}`);
  lines.push("");
  lines.push(u.meta.description);
  lines.push("");
  lines.push(u.content);

  if (u.meta.faq.length) {
    lines.push("");
    lines.push(`## ${L.headingFaq}`);
    lines.push("");
    for (const q of u.meta.faq) {
      lines.push(`**${q.q}**`);
      lines.push("");
      lines.push(q.a);
      lines.push("");
    }
  }

  return new NextResponse(lines.join("\n") + "\n", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
