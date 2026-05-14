import { DEFAULT_LOCALE, type Locale } from "@ellul.ai/i18n-consts";
import { listComparisonSlugs, getComparison } from "@/content/comparisons/loader";
import { listPillarSlugs, getPillarMeta } from "@/content/pillars/loader";
import { listUseCaseSlugs, getUseCaseMeta } from "@/content/use-cases/loader";
import { listGlossarySlugs, getGlossaryTerm } from "@/content/glossary/loader";
import { listAgentSlugs, getAgentMeta } from "@/content/agents/loader";
import { listMcpSlugs, getMcpMeta } from "@/content/mcp/loader";
import { listBlogSlugs, getBlogPostMeta, allTagsFor } from "@/lib/blog";

export type ContentType =
  | "comparison"
  | "pillar"
  | "use-case"
  | "blog"
  | "glossary"
  | "agent"
  | "mcp";

export interface ContentLink {
  type: ContentType;
  slug: string;
  title: string;
  href: string;
  description?: string;
}

interface GraphNode {
  type: ContentType;
  slug: string;
  title: string;
  description?: string;
  tags: string[];
  explicitLinks: Array<{ type: ContentType; slug: string }>;
}

interface ContentGraph {
  nodes: Map<string, GraphNode>;
  tagIndex: Map<string, string[]>;
  backlinks: Map<string, string[]>;
}

const PATH_PREFIX: Record<ContentType, string> = {
  comparison: "/vs",
  pillar: "/concepts",
  "use-case": "/solutions",
  blog: "/blog",
  glossary: "/glossary",
  agent: "/agents",
  mcp: "/mcp",
};

function nodeKey(type: ContentType, slug: string): string {
  return `${type}:${slug}`;
}

function hrefFor(type: ContentType, slug: string): string {
  return `${PATH_PREFIX[type]}/${slug}`;
}

function toContentLink(node: GraphNode): ContentLink {
  return {
    type: node.type,
    slug: node.slug,
    title: node.title,
    href: hrefFor(node.type, node.slug),
    description: node.description,
  };
}

const graphCache = new Map<Locale, ContentGraph>();

async function buildGraph(locale: Locale): Promise<ContentGraph> {
  if (graphCache.has(locale)) return graphCache.get(locale)!;

  const nodes = new Map<string, GraphNode>();
  const tagIndex = new Map<string, string[]>();
  const backlinks = new Map<string, string[]>();

  function addNode(node: GraphNode): void {
    const key = nodeKey(node.type, node.slug);
    nodes.set(key, node);
    for (const tag of node.tags) {
      const normalized = tag.toLowerCase();
      if (!tagIndex.has(normalized)) tagIndex.set(normalized, []);
      tagIndex.get(normalized)!.push(key);
    }
  }

  function recordBacklinks(node: GraphNode): void {
    const sourceKey = nodeKey(node.type, node.slug);
    for (const link of node.explicitLinks) {
      const targetKey = nodeKey(link.type, link.slug);
      if (!backlinks.has(targetKey)) backlinks.set(targetKey, []);
      backlinks.get(targetKey)!.push(sourceKey);
    }
  }

  // Comparisons
  for (const slug of listComparisonSlugs()) {
    const data = await getComparison(slug, locale);
    if (!data) continue;
    const explicit: GraphNode["explicitLinks"] = data.relatedUseCases.map(
      (s) => ({ type: "use-case" as ContentType, slug: s }),
    );
    addNode({
      type: "comparison",
      slug,
      title: data.meta.title,
      description: data.meta.description,
      tags: data.tags,
      explicitLinks: explicit,
    });
  }

  // Pillars
  for (const slug of listPillarSlugs()) {
    const meta = await getPillarMeta(slug, locale);
    if (!meta) continue;
    const explicit: GraphNode["explicitLinks"] = [
      ...meta.relatedComparisons.map((s) => ({
        type: "comparison" as ContentType,
        slug: s,
      })),
      ...meta.relatedUseCases.map((s) => ({
        type: "use-case" as ContentType,
        slug: s,
      })),
      ...meta.relatedTerms.map((s) => ({
        type: "glossary" as ContentType,
        slug: s,
      })),
    ];
    addNode({
      type: "pillar",
      slug,
      title: meta.title,
      description: meta.description,
      tags: meta.tags,
      explicitLinks: explicit,
    });
  }

  // Use cases
  for (const slug of listUseCaseSlugs()) {
    const meta = await getUseCaseMeta(slug, locale);
    if (!meta) continue;
    const explicit: GraphNode["explicitLinks"] = meta.relatedComparisons.map(
      (s) => ({ type: "comparison" as ContentType, slug: s }),
    );
    addNode({
      type: "use-case",
      slug,
      title: meta.title,
      description: meta.description,
      tags: meta.tags,
      explicitLinks: explicit,
    });
  }

  // Glossary
  for (const slug of listGlossarySlugs()) {
    const term = await getGlossaryTerm(slug, locale);
    if (!term) continue;
    const explicit: GraphNode["explicitLinks"] = term.related.map((s) => ({
      type: "glossary" as ContentType,
      slug: s,
    }));
    addNode({
      type: "glossary",
      slug,
      title: term.term,
      description: term.definition,
      tags: [],
      explicitLinks: explicit,
    });
  }

  // Agents
  for (const slug of listAgentSlugs()) {
    const meta = await getAgentMeta(slug, locale);
    if (!meta) continue;
    const explicit: GraphNode["explicitLinks"] = [
      ...meta.relatedComparisons.map((s) => ({
        type: "comparison" as ContentType,
        slug: s,
      })),
      ...meta.relatedTerms.map((s) => ({
        type: "glossary" as ContentType,
        slug: s,
      })),
    ];
    addNode({
      type: "agent",
      slug,
      title: meta.name,
      description: meta.description,
      tags: meta.tags,
      explicitLinks: explicit,
    });
  }

  // MCP
  for (const slug of listMcpSlugs()) {
    const meta = await getMcpMeta(slug, locale);
    if (!meta) continue;
    const explicit: GraphNode["explicitLinks"] = [
      ...meta.relatedComparisons.map((s) => ({
        type: "comparison" as ContentType,
        slug: s,
      })),
      ...meta.relatedAgents.map((s) => ({
        type: "agent" as ContentType,
        slug: s,
      })),
      ...meta.relatedTerms.map((s) => ({
        type: "glossary" as ContentType,
        slug: s,
      })),
    ];
    addNode({
      type: "mcp",
      slug,
      title: meta.name,
      description: meta.description,
      tags: meta.tags,
      explicitLinks: explicit,
    });
  }

  // Blog
  for (const slug of listBlogSlugs()) {
    const meta = await getBlogPostMeta(slug, locale);
    if (!meta) continue;
    addNode({
      type: "blog",
      slug,
      title: meta.title,
      description: meta.summary,
      tags: allTagsFor(meta),
      explicitLinks: [],
    });
  }

  // Build backlink index from explicit links
  for (const node of nodes.values()) {
    recordBacklinks(node);
  }

  const graph: ContentGraph = { nodes, tagIndex, backlinks };
  graphCache.set(locale, graph);
  return graph;
}

export async function getRelatedContent(
  slug: string,
  contentType: ContentType,
  locale: Locale = DEFAULT_LOCALE,
  maxPerType: number = 3,
): Promise<Record<ContentType, ContentLink[]>> {
  const graph = await buildGraph(locale);
  const key = nodeKey(contentType, slug);
  const source = graph.nodes.get(key);

  const result: Record<ContentType, ContentLink[]> = {
    comparison: [],
    pillar: [],
    "use-case": [],
    blog: [],
    glossary: [],
    agent: [],
    mcp: [],
  };

  if (!source) return result;

  // Score every other node by relevance
  const scores = new Map<string, number>();

  // Explicit links get highest weight
  for (const link of source.explicitLinks) {
    const targetKey = nodeKey(link.type, link.slug);
    if (graph.nodes.has(targetKey)) {
      scores.set(targetKey, (scores.get(targetKey) ?? 0) + 10);
    }
  }

  // Shared tags
  for (const tag of source.tags) {
    const normalized = tag.toLowerCase();
    const peers = graph.tagIndex.get(normalized) ?? [];
    for (const peerKey of peers) {
      if (peerKey === key) continue;
      scores.set(peerKey, (scores.get(peerKey) ?? 0) + 1);
    }
  }

  // Backlinks (pages linking to us are related)
  const inbound = graph.backlinks.get(key) ?? [];
  for (const backlinkKey of inbound) {
    scores.set(backlinkKey, (scores.get(backlinkKey) ?? 0) + 3);
  }

  // Group by type and sort by score
  const grouped = new Map<ContentType, Array<{ key: string; score: number }>>();
  for (const [nodeKey, score] of scores) {
    const node = graph.nodes.get(nodeKey);
    if (!node) continue;
    if (!grouped.has(node.type)) grouped.set(node.type, []);
    grouped.get(node.type)!.push({ key: nodeKey, score });
  }

  for (const [type, entries] of grouped) {
    entries.sort((a, b) => b.score - a.score);
    result[type] = entries.slice(0, maxPerType).map((e) => {
      const node = graph.nodes.get(e.key)!;
      return toContentLink(node);
    });
  }

  return result;
}

export async function getBacklinks(
  slug: string,
  contentType: ContentType,
  locale: Locale = DEFAULT_LOCALE,
): Promise<ContentLink[]> {
  const graph = await buildGraph(locale);
  const key = nodeKey(contentType, slug);
  const inbound = graph.backlinks.get(key) ?? [];

  return inbound
    .map((k) => graph.nodes.get(k))
    .filter((n): n is GraphNode => n !== undefined)
    .map(toContentLink);
}

export async function getClusterSiblings(
  slug: string,
  contentType: ContentType,
  locale: Locale = DEFAULT_LOCALE,
): Promise<ContentLink[]> {
  const graph = await buildGraph(locale);
  const key = nodeKey(contentType, slug);
  const source = graph.nodes.get(key);
  if (!source || source.tags.length === 0) return [];

  // Primary tag is the first tag in the array
  const primaryTag = source.tags[0]!.toLowerCase();
  const siblings = graph.tagIndex.get(primaryTag) ?? [];

  return siblings
    .filter((k) => k !== key)
    .map((k) => graph.nodes.get(k))
    .filter((n): n is GraphNode => n !== undefined)
    .map(toContentLink);
}
