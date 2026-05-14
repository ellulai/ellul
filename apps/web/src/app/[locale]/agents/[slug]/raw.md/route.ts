import { NextResponse } from "next/server";
import { ALL_LOCALES, DEFAULT_LOCALE, type Locale } from "@ellul.ai/i18n-consts";
import { loadMessages } from "@ellul.ai/i18n-messages/loaders";
import {
  getAgent,
  listAgentSlugsWithMdx,
} from "@/content/agents/loader";

export const dynamic = "force-static";

const SITE_URL = "https://ellul.ai";

async function loadLabels(locale: Locale): Promise<{
  labelLastUpdated: string;
  labelVendor: string;
  labelPricing: string;
  headingCapabilitiesOnEllul: string;
}> {
  const messages = (await loadMessages(locale)) as {
    pages?: { rawMd?: Record<string, string> };
  };
  const ns = messages.pages?.rawMd;
  if (!ns) throw new Error(`pages.rawMd missing for locale "${locale}"`);
  return {
    labelLastUpdated: ns.labelLastUpdated!,
    labelVendor: ns.labelVendor!,
    labelPricing: ns.labelPricing!,
    headingCapabilitiesOnEllul: ns.headingCapabilitiesOnEllul!,
  };
}

export function generateStaticParams() {
  const slugs = listAgentSlugsWithMdx();
  return ALL_LOCALES.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug })),
  );
}

// /agents/{slug}/raw.md serves the markdown rendition of an agent deep page
// for LLM consumption without HTML/JS overhead. The MDX body already contains
// a "Common questions" section sourced from meta.faq, so we do not append a
// second FAQ block here.
export async function GET(
  _: Request,
  context: { params: Promise<{ locale: string; slug: string }> },
) {
  const { locale: rawLocale, slug } = await context.params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : DEFAULT_LOCALE) as Locale;
  const agent = await getAgent(slug, locale);
  if (!agent) return new NextResponse("Not found", { status: 404 });
  const L = await loadLabels(locale);

  const { meta, content } = agent;
  const lines: string[] = [];
  lines.push(`# ${meta.name} on Ellul`);
  lines.push(`URL: ${SITE_URL}/agents/${slug}`);
  lines.push(`${L.labelVendor}: ${meta.vendor}`);
  lines.push(`${L.labelLastUpdated}: ${meta.lastUpdated}`);
  lines.push("");
  lines.push(meta.description);
  lines.push("");
  lines.push(`## ${L.headingCapabilitiesOnEllul}`);
  lines.push("");
  for (const cap of meta.supportedFeatures) lines.push(`- ${cap}`);
  lines.push("");
  lines.push(`${L.labelPricing}: ${meta.pricingNote}`);
  lines.push("");
  lines.push(content);

  return new NextResponse(lines.join("\n") + "\n", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
