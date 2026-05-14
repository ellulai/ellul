import { NextResponse } from "next/server";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { loadMessages } from "@ellul.ai/i18n-messages/loaders";
import {
  getAllAgentMetas,
  hasAgentMdx,
} from "@/content/agents/loader";

export const dynamic = "force-static";

const SITE_URL = "https://ellul.ai";

async function loadLabels(locale: Locale): Promise<{
  agentsHubHeader: string;
  agentsHubIntro: string;
  labelRaw: string;
  labelVendor: string;
  labelPricing: string;
  stubStatus: string;
}> {
  const messages = (await loadMessages(locale)) as {
    pages?: { rawMd?: Record<string, string> };
  };
  const ns = messages.pages?.rawMd;
  if (!ns) throw new Error(`pages.rawMd missing for locale "${locale}"`);
  return {
    agentsHubHeader: ns.agentsHubHeader!,
    agentsHubIntro: ns.agentsHubIntro!,
    labelRaw: ns.labelRaw!,
    labelVendor: ns.labelVendor!,
    labelPricing: ns.labelPricing!,
    stubStatus: ns.stubStatus!,
  };
}

export function generateStaticParams() {
  return ALL_LOCALES.map((locale) => ({ locale }));
}

// /agents/raw.md serves the markdown rendition of the agents index. Each
// entry has vendor, description, pricing, and a link to its deep-page
// raw.md. Closes the GEO sibling-route gap so an LLM can read the catalog
// without parsing HTML.
export async function GET(
  _: Request,
  context: { params: Promise<{ locale: string }> },
) {
  const { locale } = await context.params;
  const agents = await getAllAgentMetas(locale as Locale);
  const L = await loadLabels(locale as Locale);

  const lines: string[] = [];
  lines.push(`# ${L.agentsHubHeader}`);
  lines.push(`URL: ${SITE_URL}/agents`);
  lines.push("");
  lines.push(L.agentsHubIntro);
  lines.push("");

  for (const a of agents) {
    const ready = hasAgentMdx(a.slug);
    lines.push(`## ${a.name}`);
    lines.push(`URL: ${SITE_URL}/agents/${a.slug}`);
    if (ready) {
      lines.push(`${L.labelRaw}: ${SITE_URL}/agents/${a.slug}/raw.md`);
    }
    lines.push(`${L.labelVendor}: ${a.vendor}`);
    lines.push(`${L.labelPricing}: ${a.pricingNote}`);
    if (!ready) lines.push(L.stubStatus);
    lines.push("");
    lines.push(a.description);
    lines.push("");
  }

  return new NextResponse(lines.join("\n") + "\n", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
