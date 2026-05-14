import { NextResponse } from "next/server";
import { ALL_LOCALES, DEFAULT_LOCALE, type Locale } from "@ellul.ai/i18n-consts";
import { getAllSlugs, getDocBySlug } from "@/lib/docs";

export const dynamic = "force-static";

const DOCS_URL = "https://docs.ellul.ai";

export function generateStaticParams() {
  const slugs = getAllSlugs();
  return ALL_LOCALES.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug })),
  );
}

// /{slug-parts}/raw.md — markdown rendition of a doc page for LLM consumption.
// Static-exported route handler; works alongside the [...slug]/page.tsx
// catchall because Next.js prefers the more specific nested route at request
// time (the explicit `raw.md` segment outranks the catchall's match for
// `["...", "raw.md"]`).
export async function GET(
  _: Request,
  context: { params: Promise<{ locale: string; slug: string[] }> },
) {
  const { locale: rawLocale, slug } = await context.params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : DEFAULT_LOCALE) as Locale;
  const doc = getDocBySlug(slug, locale);
  if (!doc) return new NextResponse("Not found", { status: 404 });

  const lines: string[] = [];
  lines.push(`# ${doc.title}`);
  lines.push(`URL: ${DOCS_URL}/${doc.slug}`);
  if (doc.section) lines.push(`Section: ${doc.section}`);
  if (doc.updatedAt) lines.push(`Last updated: ${doc.updatedAt}`);
  lines.push("");
  if (doc.description) {
    lines.push(doc.description);
    lines.push("");
  }
  lines.push(doc.content);

  return new NextResponse(lines.join("\n") + "\n", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
