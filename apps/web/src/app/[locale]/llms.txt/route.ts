import { NextResponse } from "next/server";
import { notFound } from "next/navigation";
import {
  ALL_LOCALES,
  DEFAULT_LOCALE,
  type Locale,
} from "@ellul.ai/i18n-consts";
import { loadMessages } from "@ellul.ai/i18n-messages/loaders";
import {
  getAllComparisons,
  getComparisonAvailableLocales,
} from "@/content/comparisons/loader";
import {
  getAllPillars,
  getAvailableLocales as getAvailablePillarLocales,
  getMetaTranslatedLocales as getPillarMetaTranslatedLocales,
} from "@/content/pillars/loader";
import {
  getAllGlossaryTerms,
  getGlossaryAvailableLocales,
} from "@/content/glossary/loader";

export const dynamic = "force-static";

const SITE_URL = "https://ellul.ai";

async function loadSummary(locale: Locale): Promise<string> {
  const messages = (await loadMessages(locale)) as {
    home?: { llmsTxt?: { summary?: string } };
  };
  return messages.home?.llmsTxt?.summary ?? "";
}

// Localized section titles for the manifest. Anything we haven't translated
// stays in English so the manifest stays parseable.
const SECTION_TITLES: Record<Locale, Record<string, string>> = {
  en: {
    product: "Product",
    concepts: "Concepts",
    glossary: "Glossary",
    comparisons: "Comparisons",
    canonical: "Canonical (English)",
  },
  ja: {
    product: "プロダクト",
    concepts: "コンセプト",
    glossary: "用語集",
    comparisons: "比較",
    canonical: "正規版（英語）",
  },
  ko: {
    product: "Product",
    concepts: "Concepts",
    glossary: "Glossary",
    comparisons: "Comparisons",
    canonical: "Canonical (English)",
  },
  de: {
    product: "Product",
    concepts: "Concepts",
    glossary: "Glossary",
    comparisons: "Comparisons",
    canonical: "Canonical (English)",
  },
  "pt-BR": {
    product: "Product",
    concepts: "Concepts",
    glossary: "Glossary",
    comparisons: "Comparisons",
    canonical: "Canonical (English)",
  },
  fr: {
    product: "Product",
    concepts: "Concepts",
    glossary: "Glossary",
    comparisons: "Comparisons",
    canonical: "Canonical (English)",
  },
};

function localeUrl(locale: Locale, pathname: string): string {
  return `${SITE_URL}/${locale}${pathname}`;
}

// English serves the canonical llms.txt at the root /llms.txt; no /en/llms.txt
// stub. Other locales get a per-locale manifest that lists translated surfaces
// and links back to the canonical EN manifest for sections not yet localized.
export function generateStaticParams() {
  return ALL_LOCALES.filter((locale) => locale !== DEFAULT_LOCALE).map(
    (locale) => ({ locale }),
  );
}

export async function GET(
  _: Request,
  context: { params: Promise<{ locale: string }> },
) {
  const { locale: rawLocale } = await context.params;
  if (rawLocale === DEFAULT_LOCALE) notFound();
  if (!ALL_LOCALES.includes(rawLocale as Locale)) notFound();
  const locale = rawLocale as Locale;
  const t = SECTION_TITLES[locale];

  const [pillars, glossary, comparisons] = await Promise.all([
    getAllPillars(locale),
    getAllGlossaryTerms(locale),
    getAllComparisons(locale),
  ]);

  // Per-URL availability: only list a localized URL if the entry has a
  // translations[locale] block. Anything else falls under the canonical
  // section and links back to /llms.txt.
  const pillarAvailable: Record<string, boolean> = {};
  for (const p of pillars) {
    const mdxLocales = new Set(getAvailablePillarLocales(p.slug));
    const metaLocales = new Set(await getPillarMetaTranslatedLocales(p.slug));
    pillarAvailable[p.slug] = mdxLocales.has(locale) && metaLocales.has(locale);
  }

  const glossaryAvailable: Record<string, boolean> = {};
  for (const g of glossary) {
    const locales = new Set(await getGlossaryAvailableLocales(g.slug));
    glossaryAvailable[g.slug] = locales.has(locale);
  }

  const comparisonAvailable: Record<string, boolean> = {};
  for (const c of comparisons) {
    const locales = new Set(await getComparisonAvailableLocales(c.slug));
    comparisonAvailable[c.slug] = locales.has(locale);
  }

  const lines: string[] = [];

  lines.push("# Ellul");
  lines.push("");

  const summary = await loadSummary(locale);
  lines.push(`> ${summary}`);
  lines.push("");

  // Concepts (only emit URLs that have BOTH meta + MDX translated for this
  // locale; otherwise fall through to the canonical EN manifest).
  const localizedPillars = pillars.filter((p) => pillarAvailable[p.slug]);
  if (localizedPillars.length > 0) {
    lines.push(`## ${t.concepts}`);
    lines.push("");
    for (const p of localizedPillars) {
      lines.push(
        `- [${p.title}](${localeUrl(locale, `/concepts/${p.slug}`)}): ${p.description}`,
      );
    }
    lines.push("");
  }

  const localizedGlossary = glossary.filter((g) => glossaryAvailable[g.slug]);
  if (localizedGlossary.length > 0) {
    lines.push(`## ${t.glossary}`);
    lines.push("");
    for (const g of localizedGlossary) {
      lines.push(
        `- [${g.term}](${localeUrl(locale, `/glossary/${g.slug}`)}): ${g.definition}`,
      );
    }
    lines.push("");
  }

  const localizedComparisons = comparisons.filter(
    (c) => comparisonAvailable[c.slug],
  );
  if (localizedComparisons.length > 0) {
    lines.push(`## ${t.comparisons}`);
    lines.push("");
    for (const c of localizedComparisons) {
      lines.push(
        `- [${c.competitor.name} vs ellul](${localeUrl(locale, `/vs/${c.slug}`)}): ${c.fundamentalDifference}`,
      );
    }
    lines.push("");
  }

  // Canonical (EN). Sections not yet shipped in this locale (Solutions,
  // Agents, MCP, Blog, Docs, Reference) live in the EN manifest; we point
  // crawlers there explicitly so they don't probe missing per-locale URLs.
  lines.push(`## ${t.canonical}`);
  lines.push("");
  lines.push(
    `- [English llms.txt](${SITE_URL}/llms.txt): Canonical manifest with all surfaces.`,
  );
  lines.push(
    `- [llms-full.txt](${SITE_URL}/llms-full.txt): Concatenated full-content version.`,
  );
  lines.push(`- [Sitemap](${SITE_URL}/sitemap.xml): Full URL inventory.`);
  lines.push("");

  return new NextResponse(lines.join("\n") + "\n", {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
