import { NextResponse } from "next/server";
import { getAllDocs } from "@/lib/docs";

export const dynamic = "force-static";
export const revalidate = 3600;

const DOCS_URL = "https://docs.ellul.ai";
const WEB_URL = "https://ellul.ai";

export async function GET() {
  const docs = getAllDocs("en");
  const sections = new Map<string, typeof docs>();
  for (const d of docs) {
    const arr = sections.get(d.section) ?? [];
    arr.push(d);
    sections.set(d.section, arr);
  }

  const lines: string[] = [];
  lines.push("# Ellul Documentation");
  lines.push("");
  lines.push(
    "> Technical documentation for Ellul — the always-on workstation for AI agents. Architecture, security model, sandbox primitives, agent integration, and deployment.",
  );
  lines.push("");

  for (const [section, items] of sections) {
    lines.push(`## ${section}`);
    lines.push("");
    for (const d of items) {
      lines.push(`- [${d.title}](${DOCS_URL}/${d.slug}): ${d.description}`);
    }
    lines.push("");
  }

  lines.push("## Optional");
  lines.push("");
  lines.push(`- [Sitemap](${DOCS_URL}/sitemap.xml): Full URL inventory.`);
  lines.push(
    `- [llms-full.txt](${DOCS_URL}/llms-full.txt): Concatenated docs content.`,
  );
  lines.push(`- [Marketing site](${WEB_URL}/): Product overview.`);
  lines.push(`- [Marketing llms.txt](${WEB_URL}/llms.txt): Product-side LLM index.`);

  return new NextResponse(lines.join("\n") + "\n", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
