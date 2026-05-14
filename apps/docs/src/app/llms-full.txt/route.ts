import { NextResponse } from "next/server";
import { getAllSlugs, getDocBySlug } from "@/lib/docs";

export const dynamic = "force-static";
export const revalidate = 3600;

const DOCS_URL = "https://docs.ellul.ai";

const SOFT_CAP_BYTES = 300_000;

export async function GET() {
  const slugs = getAllSlugs();
  const sections: string[] = [];

  sections.push("# Ellul Documentation — full content");
  sections.push("");
  sections.push(
    "> Concatenated technical documentation for Ellul, structured so an LLM can ingest the entire docs surface without crawling individual URLs.",
  );
  sections.push("");

  for (const slug of slugs) {
    const doc = getDocBySlug(slug, "en");
    if (!doc) continue;
    sections.push("---");
    sections.push("");
    sections.push(`# ${doc.title}`);
    sections.push(`URL: ${DOCS_URL}/${doc.slug}`);
    sections.push(`Section: ${doc.section}`);
    if (doc.updatedAt) sections.push(`Last updated: ${doc.updatedAt}`);
    sections.push("");
    if (doc.description) {
      sections.push(doc.description);
      sections.push("");
    }
    sections.push(doc.content);
    sections.push("");
  }

  let payload = sections.join("\n") + "\n";
  const size = Buffer.byteLength(payload, "utf-8");
  if (size > SOFT_CAP_BYTES) {
    payload = `<!-- docs llms-full.txt is ${size} bytes (>${SOFT_CAP_BYTES}); plan to paginate -->\n${payload}`;
  }

  return new NextResponse(payload, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
