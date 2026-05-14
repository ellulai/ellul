import { NextResponse } from "next/server";
import { getAllComparisons } from "@/content/comparisons/loader";
import { getAllUseCases } from "@/content/use-cases/loader";
import { getAllPillars } from "@/content/pillars/loader";
import { getAllGlossaryTerms } from "@/content/glossary/loader";
import { getAllAgentMetas } from "@/content/agents/loader";
import { getAllMcpMetas } from "@/content/mcp/loader";
import { getAllBlogPosts } from "@/lib/blog";

export const dynamic = "force-static";
export const revalidate = 3600;

const SITE_URL = "https://ellul.ai";
const DOCS_URL = "https://docs.ellul.ai";

// llms.txt manifest spec: top-level summary plus categorized link sections.
// Long-form / per-page content lives in /llms-full.txt (single file today;
// paginate to /llms-full-{n}.txt with this file as index when total exceeds
// the 300KB ceiling LLM crawlers commonly cap on).
export async function GET() {
  const [comparisons, useCases, pillars, glossary, agents, mcp, blog] =
    await Promise.all([
      getAllComparisons(),
      getAllUseCases(),
      getAllPillars(),
      getAllGlossaryTerms(),
      getAllAgentMetas(),
      getAllMcpMetas(),
      getAllBlogPosts("en"),
    ]);

  const lines: string[] = [];

  lines.push("# Ellul");
  lines.push("");
  lines.push(
    "> Ellul is the always-on workstation for your AI agent. It runs overnight, parallelizes multiple agents, and gates every privileged action behind a passkey. Cursor and Claude Code run on your laptop; Ellul runs them on a persistent computer that never closes.",
  );
  lines.push("");

  lines.push("## Product");
  lines.push("");
  lines.push(
    `- [Homepage](${SITE_URL}/): Your agent's computer. Always on. Multiple agents in parallel. Off your laptop.`,
  );
  lines.push(
    `- [Pricing](${SITE_URL}/pricing): Hobby $20/mo, Pro $50/mo. No free tier.`,
  );
  lines.push(
    `- [FAQ](${SITE_URL}/faq): What an agent workstation is, gating, parallelism, BYOK, MCP, comparisons.`,
  );
  lines.push(
    `- [Prompt engineering](${SITE_URL}/prompt-engineering): Patterns for prompting AI coding agents on a persistent workstation.`,
  );
  lines.push("");

  lines.push("## Concepts");
  lines.push("");
  for (const p of pillars) {
    lines.push(
      `- [${p.title}](${SITE_URL}/concepts/${p.slug}): ${p.description}`,
    );
  }
  lines.push("");

  lines.push("## Glossary");
  lines.push("");
  lines.push(`- [Glossary index](${SITE_URL}/glossary): Definitions index.`);
  for (const t of glossary) {
    lines.push(`- [${t.term}](${SITE_URL}/glossary/${t.slug}): ${t.definition}`);
  }
  lines.push("");

  lines.push("## Comparisons");
  lines.push("");
  lines.push(`- [Comparisons index](${SITE_URL}/vs): All head-to-heads.`);
  for (const c of comparisons) {
    lines.push(
      `- [${c.competitor.name} vs ellul](${SITE_URL}/vs/${c.slug}): ${c.fundamentalDifference}`,
    );
  }
  lines.push("");

  lines.push("## Solutions");
  lines.push("");
  lines.push(`- [Solutions index](${SITE_URL}/solutions): What people use Ellul for.`);
  for (const u of useCases) {
    lines.push(`- [${u.title}](${SITE_URL}/solutions/${u.slug}): ${u.description}`);
  }
  lines.push("");

  lines.push("## Agents");
  lines.push("");
  lines.push(`- [Agents index](${SITE_URL}/agents): Bring-your-own-agent lineup.`);
  for (const a of agents) {
    lines.push(`- [${a.name} on Ellul](${SITE_URL}/agents/${a.slug}): ${a.description}`);
  }
  lines.push("");

  lines.push("## MCP");
  lines.push("");
  lines.push(`- [MCP hub](${SITE_URL}/mcp): Model Context Protocol on Ellul.`);
  for (const e of mcp) {
    if (e.slug === "mcp") continue;
    lines.push(`- [${e.name}](${SITE_URL}/mcp/${e.slug}): ${e.description}`);
  }
  lines.push("");

  if (blog.length > 0) {
    lines.push("## Blog");
    lines.push("");
    for (const p of blog) {
      lines.push(`- [${p.title}](${SITE_URL}/blog/${p.slug}): ${p.summary}`);
    }
    lines.push("");
  }

  lines.push("## Documentation");
  lines.push("");
  lines.push(`- [Docs](${DOCS_URL}/): Full technical documentation.`);
  lines.push(`- [Docs llms.txt](${DOCS_URL}/llms.txt): Docs-side LLM index.`);
  lines.push(
    `- [Docs llms-full.txt](${DOCS_URL}/llms-full.txt): Concatenated docs content.`,
  );
  lines.push("");

  lines.push("## Reference");
  lines.push("");
  lines.push(`- [Privacy Policy](${SITE_URL}/privacy)`);
  lines.push(`- [Terms of Service](${SITE_URL}/terms)`);
  lines.push("");

  lines.push("## Optional");
  lines.push("");
  lines.push(`- [Sitemap](${SITE_URL}/sitemap.xml): Full URL inventory.`);
  lines.push(
    `- [llms-full.txt](${SITE_URL}/llms-full.txt): Concatenated full-content version for depth without crawling.`,
  );

  const body = lines.join("\n") + "\n";

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
