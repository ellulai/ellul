import { NextResponse } from "next/server";
import {
  ALL_LOCALES,
  DEFAULT_LOCALE,
  type Locale,
} from "@ellul.ai/i18n-consts";
import { loadMessages } from "@ellul.ai/i18n-messages/loaders";
import {
  getMcpDoc,
  getMcpMeta,
  hasMcpMdx,
  listMcpSlugs,
} from "@/content/mcp/loader";

export const dynamic = "force-static";

const SITE_URL = "https://ellul.ai";

async function loadLabels(locale: Locale): Promise<{
  labelPublished: string;
  labelLastUpdated: string;
  labelVendor: string;
  headingCapabilities: string;
  headingFaq: string;
}> {
  const messages = (await loadMessages(locale)) as {
    pages?: { rawMd?: Record<string, string> };
  };
  const ns = messages.pages?.rawMd;
  if (!ns) throw new Error(`pages.rawMd missing for locale "${locale}"`);
  return {
    labelPublished: ns.labelPublished!,
    labelLastUpdated: ns.labelLastUpdated!,
    labelVendor: ns.labelVendor!,
    headingCapabilities: ns.headingCapabilities!,
    headingFaq: ns.headingFaq!,
  };
}

export function generateStaticParams() {
  const slugs = listMcpSlugs();
  return ALL_LOCALES.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug })),
  );
}

// /mcp/{slug}/raw.md: markdown rendition of an MCP entry's hero, capabilities,
// body, and FAQ. Lets an LLM cite the canonical content without parsing HTML.
export async function GET(
  _: Request,
  context: { params: Promise<{ locale: string; slug: string }> },
) {
  const { locale: rawLocale, slug } = await context.params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : DEFAULT_LOCALE) as Locale;

  const meta = await getMcpMeta(slug, locale);
  if (!meta) return new NextResponse("Not found", { status: 404 });
  if (!hasMcpMdx(slug)) return new NextResponse("Not found", { status: 404 });

  const doc = await getMcpDoc(slug, locale);
  if (!doc) return new NextResponse("Not found", { status: 404 });
  const L = await loadLabels(locale);

  const lines: string[] = [];
  lines.push(`# ${meta.name}`);
  lines.push(`URL: ${SITE_URL}/mcp/${slug}`);
  lines.push(`${L.labelPublished}: ${meta.publishedAt}`);
  lines.push(`${L.labelLastUpdated}: ${meta.lastUpdated}`);
  if (meta.vendor) lines.push(`${L.labelVendor}: ${meta.vendor}`);
  lines.push("");
  lines.push(meta.description);
  lines.push("");
  lines.push(`## ${L.headingCapabilities}`);
  lines.push("");
  for (const cap of meta.capabilities) lines.push(`- ${cap}`);
  lines.push("");
  lines.push(doc.content);
  if (meta.faq.length) {
    lines.push("");
    lines.push(`## ${L.headingFaq}`);
    lines.push("");
    for (const q of meta.faq) {
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
