import { NextResponse } from "next/server";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { loadMessages } from "@ellul.ai/i18n-messages/loaders";
import {
  getGlossaryTerm,
  listGlossarySlugs,
} from "@/content/glossary/loader";

export const dynamic = "force-static";

const SITE_URL = "https://ellul.ai";

async function loadLabels(locale: Locale): Promise<{
  labelLastUpdated: string;
  labelSynonyms: string;
  headingContext: string;
  headingRelated: string;
  headingSeeAlso: string;
}> {
  const messages = (await loadMessages(locale)) as {
    pages?: { rawMd?: Record<string, string> };
  };
  const ns = messages.pages?.rawMd;
  if (!ns) throw new Error(`pages.rawMd missing for locale "${locale}"`);
  return {
    labelLastUpdated: ns.labelLastUpdated!,
    labelSynonyms: ns.labelSynonyms!,
    headingContext: ns.headingContext!,
    headingRelated: ns.headingRelated!,
    headingSeeAlso: ns.headingSeeAlso!,
  };
}

export function generateStaticParams() {
  const slugs = listGlossarySlugs();
  return ALL_LOCALES.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug })),
  );
}

// /glossary/{slug}/raw.md: markdown rendition of a glossary term, including
// the definition, context, synonyms, and related terms.
export async function GET(
  _: Request,
  context: { params: Promise<{ locale: string; slug: string }> },
) {
  const { locale, slug } = await context.params;
  const t = await getGlossaryTerm(slug, locale as Locale);
  if (!t) return new NextResponse("Not found", { status: 404 });
  const L = await loadLabels(locale as Locale);

  const lines: string[] = [];
  lines.push(`# ${t.term}`);
  lines.push(`URL: ${SITE_URL}/glossary/${t.slug}`);
  lines.push(`${L.labelLastUpdated}: ${t.lastUpdated}`);
  lines.push("");
  lines.push(t.definition);
  if (t.context) {
    lines.push("");
    lines.push(`## ${L.headingContext}`);
    lines.push("");
    lines.push(t.context);
  }
  if (t.synonyms.length) {
    lines.push("");
    lines.push(`${L.labelSynonyms}: ${t.synonyms.join(", ")}`);
  }
  if (t.related?.length) {
    lines.push("");
    lines.push(`## ${L.headingRelated}`);
    lines.push("");
    for (const r of t.related) {
      lines.push(`- ${SITE_URL}/glossary/${r}`);
    }
  }
  if (t.seeAlso?.length) {
    lines.push("");
    lines.push(`## ${L.headingSeeAlso}`);
    lines.push("");
    for (const link of t.seeAlso) {
      const href = link.href.startsWith("/")
        ? `${SITE_URL}${link.href}`
        : link.href;
      lines.push(`- [${link.label}](${href})`);
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
