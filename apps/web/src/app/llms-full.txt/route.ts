import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import matter from "gray-matter";
import { getAllComparisons } from "@/content/comparisons/loader";
import {
  getAllUseCases,
  getUseCase,
} from "@/content/use-cases/loader";
import {
  getAllPillars,
  getPillar,
} from "@/content/pillars/loader";
import { getAllGlossaryTerms } from "@/content/glossary/loader";
import {
  getAllAgentMetas,
  getAgent,
  hasAgentMdx,
} from "@/content/agents/loader";
import {
  getAllMcpMetas,
  getMcpDoc,
  hasMcpMdx,
} from "@/content/mcp/loader";
import { getAllBlogPosts, getBlogPost } from "@/lib/blog";
import { deriveAdvantage } from "@/content/comparisons/schema";

export const dynamic = "force-static";
export const revalidate = 3600;

const SITE_URL = "https://ellul.ai";

// LLM crawlers commonly cap concatenated indices around 300KB. Today's content
// is well under that ceiling, so a single file is fine. When this exceeds the
// cap, split into /llms-full-{n}.txt and update /llms.txt to list the parts.
const SOFT_CAP_BYTES = 300_000;

function comparisonToMarkdown(c: Awaited<ReturnType<typeof getAllComparisons>>[number]): string {
  const out: string[] = [];
  out.push(`# ${c.competitor.name} vs ellul`);
  out.push(`URL: ${SITE_URL}/vs/${c.slug}`);
  out.push(`Last updated: ${c.lastUpdated}`);
  out.push("");
  out.push(c.hero.sub);
  out.push("");
  out.push(`**Fundamental difference:** ${c.fundamentalDifference}`);
  out.push("");
  out.push(`**Where ${c.competitor.name} is strong:** ${c.competitorPitch}`);
  out.push("");
  out.push(`**Where ellul is stronger:** ${c.ellulPitch}`);
  out.push("");
  out.push("## Feature comparison");
  out.push("");
  out.push(`| Capability | ${c.competitor.name} | ellul | Advantage |`);
  out.push(`| --- | --- | --- | --- |`);
  for (const row of c.features) {
    const fmt = (v: boolean | string) =>
      typeof v === "boolean" ? (v ? "yes" : "no") : v;
    out.push(
      `| ${row.capability} | ${fmt(row.competitor)} | ${fmt(row.ellul)} | ${deriveAdvantage(row)} |`,
    );
  }
  out.push("");
  out.push("## Pricing");
  out.push("");
  out.push(`| Tier | ${c.competitor.name} | ellul |`);
  out.push(`| --- | --- | --- |`);
  for (const row of c.pricing) {
    out.push(`| ${row.tier} | ${row.competitor} | ${row.ellul} |`);
  }
  out.push("");
  out.push(`## Verdict`);
  out.push("");
  out.push(`**${c.verdict.headline}**`);
  out.push("");
  out.push(c.verdict.body);
  out.push("");
  out.push("## When to use each");
  out.push("");
  out.push(`Use ${c.competitor.name} when:`);
  for (const item of c.whenToUseCompetitor) out.push(`- ${item.text}`);
  out.push("");
  out.push("Use ellul when:");
  for (const item of c.whenToUseEllul) out.push(`- ${item.text}`);
  out.push("");
  out.push("## FAQ");
  out.push("");
  for (const q of c.faq) {
    out.push(`**${q.q}**`);
    out.push("");
    out.push(q.a);
    out.push("");
  }
  return out.join("\n");
}

function readStaticMdx(rel: string): string | null {
  const filePath = path.join(process.cwd(), "src", "content", rel);
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  return matter(raw).content;
}

export async function GET() {
  const sections: string[] = [];

  sections.push("# Ellul: full content index");
  sections.push("");
  sections.push(
    "> Concatenated long-form content from ellul, structured so an LLM can ingest the entire marketing surface without crawling individual URLs. Includes comparisons, use-cases, concept pillars, glossary, agent integrations, MCP catalog, and the prompt-engineering reference.",
  );
  sections.push("");

  // Comparisons.
  const comparisons = await getAllComparisons();
  for (const c of comparisons) {
    sections.push("---");
    sections.push("");
    sections.push(comparisonToMarkdown(c));
    sections.push("");
  }

  // Pillars (concepts).
  const pillars = await getAllPillars();
  for (const meta of pillars) {
    const p = await getPillar(meta.slug, "en");
    sections.push("---");
    sections.push("");
    sections.push(`# ${meta.title}`);
    sections.push(`URL: ${SITE_URL}/concepts/${meta.slug}`);
    sections.push(`Last updated: ${meta.lastUpdated}`);
    sections.push("");
    sections.push(meta.description);
    sections.push("");
    if (p) sections.push(p.content);
    sections.push("");
  }

  // Use-cases.
  const useCases = await getAllUseCases();
  for (const meta of useCases) {
    const u = await getUseCase(meta.slug, "en");
    sections.push("---");
    sections.push("");
    sections.push(`# ${meta.title}`);
    sections.push(`URL: ${SITE_URL}/solutions/${meta.slug}`);
    sections.push(`Last updated: ${meta.lastUpdated}`);
    sections.push("");
    sections.push(meta.description);
    sections.push("");
    if (u) sections.push(u.content);
    sections.push("");
  }

  // Glossary.
  sections.push("---");
  sections.push("");
  sections.push("# Glossary");
  sections.push(`URL: ${SITE_URL}/glossary`);
  sections.push("");
  const glossary = await getAllGlossaryTerms();
  for (const t of glossary) {
    sections.push(`## ${t.term}`);
    sections.push(`URL: ${SITE_URL}/glossary/${t.slug}`);
    sections.push("");
    sections.push(t.definition);
    if (t.context) {
      sections.push("");
      sections.push(t.context);
    }
    if (t.synonyms.length) {
      sections.push("");
      sections.push(`Synonyms: ${t.synonyms.join(", ")}`);
    }
    sections.push("");
  }

  // Agents (only those with shipped MDX).
  const agents = await getAllAgentMetas();
  for (const meta of agents) {
    if (!hasAgentMdx(meta.slug)) continue;
    const a = await getAgent(meta.slug, "en");
    sections.push("---");
    sections.push("");
    sections.push(`# ${meta.name} on Ellul`);
    sections.push(`URL: ${SITE_URL}/agents/${meta.slug}`);
    sections.push(`Last updated: ${meta.lastUpdated}`);
    sections.push("");
    sections.push(meta.description);
    sections.push("");
    if (a) sections.push(a.content);
    sections.push("");
  }

  // MCP entries (only those with shipped MDX).
  const mcpEntries = await getAllMcpMetas();
  for (const meta of mcpEntries) {
    if (!hasMcpMdx(meta.slug)) continue;
    const d = await getMcpDoc(meta.slug, "en");
    sections.push("---");
    sections.push("");
    sections.push(`# ${meta.name}: MCP on Ellul`);
    sections.push(`URL: ${SITE_URL}/mcp/${meta.slug}`);
    sections.push(`Last updated: ${meta.lastUpdated}`);
    sections.push("");
    sections.push(meta.description);
    sections.push("");
    if (d) sections.push(d.content);
    sections.push("");
  }

  // Prompt engineering.
  sections.push("---");
  sections.push("");
  sections.push("# Prompt engineering for agents on Ellul");
  sections.push(`URL: ${SITE_URL}/prompt-engineering`);
  sections.push("");
  const promptEng = readStaticMdx("static/prompt-engineering/en.mdx");
  if (promptEng) sections.push(promptEng);
  sections.push("");

  // Blog posts.
  const blog = await getAllBlogPosts("en");
  for (const meta of blog) {
    const post = await getBlogPost(meta.slug, "en");
    if (!post) continue;
    sections.push("---");
    sections.push("");
    sections.push(`# ${meta.title}`);
    sections.push(`URL: ${SITE_URL}/blog/${meta.slug}`);
    sections.push(`Published: ${meta.publishedAt}`);
    sections.push("");
    sections.push(meta.summary);
    sections.push("");
    sections.push(post.content);
    sections.push("");
  }

  const body = sections.join("\n") + "\n";

  // Soft cap warning surfaced as a leading comment if exceeded; the actual
  // pagination split would land here in a follow-up phase.
  let payload = body;
  const size = Buffer.byteLength(payload, "utf-8");
  if (size > SOFT_CAP_BYTES) {
    payload = `<!-- llms-full.txt is ${size} bytes (>${SOFT_CAP_BYTES}); plan to paginate to llms-full-{n}.txt -->\n${body}`;
  }

  return new NextResponse(payload, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
