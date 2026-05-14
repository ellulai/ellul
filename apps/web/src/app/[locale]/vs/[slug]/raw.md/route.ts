import { NextResponse } from "next/server";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { loadMessages } from "@ellul.ai/i18n-messages/loaders";
import {
  getComparison,
  listComparisonSlugs,
} from "@/content/comparisons/loader";
import { deriveAdvantage } from "@/content/comparisons/schema";

export const dynamic = "force-static";

const SITE_URL = "https://ellul.ai";

interface RawMdLabels {
  labelLastUpdated: string;
  labelFundamentalDifference: string;
  whereStrong: string;
  whereEllulStronger: string;
  headingFeatureComparison: string;
  headingPricing: string;
  headingVerdict: string;
  headingWhenToUse: string;
  headingFaq: string;
  useWhen: string;
  useEllulWhen: string;
  valueYes: string;
  valueNo: string;
  tableCapability: string;
  tableAdvantage: string;
  tableTier: string;
  advantageEllul: string;
  advantageCompetitor: string;
  advantageTie: string;
}

async function loadLabels(locale: Locale): Promise<RawMdLabels> {
  const messages = (await loadMessages(locale)) as {
    pages?: { rawMd?: RawMdLabels };
  };
  const ns = messages.pages?.rawMd;
  if (!ns) throw new Error(`pages.rawMd missing for locale "${locale}"`);
  return ns;
}

export function generateStaticParams() {
  const slugs = listComparisonSlugs();
  return ALL_LOCALES.flatMap((locale) =>
    slugs.map((slug) => ({ locale, slug })),
  );
}

// /vs/{slug}/raw.md: markdown rendition of a comparison's feature matrix,
// pricing, and verdict. Lets an LLM cite the exact comparison without parsing
// the HTML page.
export async function GET(
  _: Request,
  context: { params: Promise<{ locale: string; slug: string }> },
) {
  const { locale, slug } = await context.params;
  const c = await getComparison(slug, locale as Locale);
  if (!c) return new NextResponse("Not found", { status: 404 });
  const L = await loadLabels(locale as Locale);

  const advantageLabel = (a: string): string => {
    if (a === "ellul") return L.advantageEllul;
    if (a === "competitor") return L.advantageCompetitor;
    return L.advantageTie;
  };

  const lines: string[] = [];
  lines.push(`# ${c.competitor.name} vs ellul`);
  lines.push(`URL: ${SITE_URL}/vs/${c.slug}`);
  lines.push(`${L.labelLastUpdated}: ${c.lastUpdated}`);
  lines.push("");
  lines.push(c.hero.sub);
  lines.push("");
  lines.push(`**${L.labelFundamentalDifference}:** ${c.fundamentalDifference}`);
  lines.push("");
  lines.push(
    `**${L.whereStrong.replace("{name}", c.competitor.name)}:** ${c.competitorPitch}`,
  );
  lines.push("");
  lines.push(`**${L.whereEllulStronger}:** ${c.ellulPitch}`);
  lines.push("");
  lines.push(`## ${L.headingFeatureComparison}`);
  lines.push("");
  lines.push(
    `| ${L.tableCapability} | ${c.competitor.name} | ellul | ${L.tableAdvantage} |`,
  );
  lines.push(`| --- | --- | --- | --- |`);
  for (const row of c.features) {
    const fmt = (v: boolean | string) =>
      typeof v === "boolean" ? (v ? L.valueYes : L.valueNo) : v;
    lines.push(
      `| ${row.capability} | ${fmt(row.competitor)} | ${fmt(row.ellul)} | ${advantageLabel(deriveAdvantage(row))} |`,
    );
  }
  lines.push("");
  lines.push(`## ${L.headingPricing}`);
  lines.push("");
  lines.push(`| ${L.tableTier} | ${c.competitor.name} | ellul |`);
  lines.push(`| --- | --- | --- |`);
  for (const row of c.pricing) {
    lines.push(`| ${row.tier} | ${row.competitor} | ${row.ellul} |`);
  }
  lines.push("");
  lines.push(`## ${L.headingVerdict}`);
  lines.push("");
  lines.push(`**${c.verdict.headline}**`);
  lines.push("");
  lines.push(c.verdict.body);
  lines.push("");
  lines.push(`## ${L.headingWhenToUse}`);
  lines.push("");
  lines.push(L.useWhen.replace("{name}", c.competitor.name));
  for (const item of c.whenToUseCompetitor) lines.push(`- ${item.text}`);
  lines.push("");
  lines.push(L.useEllulWhen);
  for (const item of c.whenToUseEllul) lines.push(`- ${item.text}`);
  lines.push("");
  lines.push(`## ${L.headingFaq}`);
  lines.push("");
  for (const q of c.faq) {
    lines.push(`**${q.q}**`);
    lines.push("");
    lines.push(q.a);
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
