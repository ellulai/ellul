import { NextResponse } from "next/server";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { loadMessages } from "@ellul.ai/i18n-messages/loaders";
import {
  getAllMcpMetas,
  hasMcpMdx,
} from "@/content/mcp/loader";

export const dynamic = "force-static";

const SITE_URL = "https://ellul.ai";

interface RawMdLabels {
  header: string;
  intro: string;
  labelKind: string;
  labelVendor: string;
  labelRaw: string;
  stubStatus: string;
}

async function loadLabels(locale: Locale): Promise<RawMdLabels> {
  const messages = (await loadMessages(locale)) as {
    pages?: { mcpHub?: { rawMd?: RawMdLabels } };
  };
  const ns = messages.pages?.mcpHub?.rawMd;
  if (!ns) {
    throw new Error(`pages.mcpHub.rawMd missing for locale "${locale}"`);
  }
  return ns;
}

export function generateStaticParams() {
  return ALL_LOCALES.map((locale) => ({ locale }));
}

// /mcp/raw.md serves the markdown rendition of the MCP catalog index. Each
// entry has vendor, kind, and description. Sibling to /mcp's HTML page so
// an LLM can read the catalog without parsing JS.
export async function GET(
  _: Request,
  context: { params: Promise<{ locale: string }> },
) {
  const { locale } = await context.params;
  const entries = await getAllMcpMetas(locale as Locale);
  const labels = await loadLabels(locale as Locale);

  const lines: string[] = [];
  lines.push(`# ${labels.header}`);
  lines.push(`URL: ${SITE_URL}/mcp`);
  lines.push("");
  lines.push(labels.intro);
  lines.push("");

  for (const e of entries) {
    const ready = hasMcpMdx(e.slug);
    lines.push(`## ${e.name}`);
    lines.push(`URL: ${SITE_URL}/mcp/${e.slug}`);
    if (ready) {
      lines.push(`${labels.labelRaw}: ${SITE_URL}/mcp/${e.slug}/raw.md`);
    }
    lines.push(`${labels.labelKind}: ${e.kind}`);
    if (e.vendor) lines.push(`${labels.labelVendor}: ${e.vendor}`);
    if (!ready) lines.push(labels.stubStatus);
    lines.push("");
    lines.push(e.description);
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
