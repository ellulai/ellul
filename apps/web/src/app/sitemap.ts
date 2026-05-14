import type { MetadataRoute } from "next";
import { ALL_LOCALES, type Locale } from "@ellul.ai/i18n-consts";
import { isIndexableLocale } from "@ellul.ai/i18n-consts/indexability";
import { STATIC_ROUTES } from "@/lib/routes";
import {
  allTagsFor,
  getAllBlogPosts,
  getAvailableLocales as getAvailableBlogLocales,
  tagSlug,
} from "@/lib/blog";
import {
  getAllComparisons,
  getComparisonAvailableLocales,
} from "@/content/comparisons/loader";
import {
  getAllUseCases,
  getAvailableLocales as getAvailableUseCaseLocales,
} from "@/content/use-cases/loader";
import {
  getAllPillars,
  getAvailableLocales as getAvailablePillarLocales,
  getMetaTranslatedLocales as getPillarMetaTranslatedLocales,
} from "@/content/pillars/loader";
import {
  getAllGlossaryTerms,
  getGlossaryAvailableLocales,
} from "@/content/glossary/loader";
import {
  getAllAgentMetas,
  hasAgentMdx,
} from "@/content/agents/loader";
import {
  getAllMcpMetas,
  hasMcpMdx,
} from "@/content/mcp/loader";
import { listAuthorHandles } from "@/content/authors/loader";

const BASE_URL = process.env.NEXT_PUBLIC_WEB_URL!;
const SURFACE = "web" as const;

function localeUrl(locale: string, pathname: string): string {
  const cleanPath = pathname === "/" ? "" : pathname;
  if (locale === "en") return `${BASE_URL}${cleanPath || "/"}`;
  return `${BASE_URL}/${locale}${cleanPath}`;
}

/**
 * Build hreflang alternates only when 2+ locales are indexable for this URL.
 * A single self-referencing hreflang is noise — it only has meaning when
 * there are multiple language versions. Includes x-default pointing to
 * the English canonical when alternates are emitted.
 */
function alternates(
  pathname: string,
  locales: Locale[],
): { languages: Record<string, string> } | undefined {
  if (locales.length < 2) return undefined;
  return {
    languages: {
      ...Object.fromEntries(locales.map((l) => [l, localeUrl(l, pathname)])),
      "x-default": localeUrl("en", pathname),
    },
  };
}

function latestDate(dates: (string | undefined)[]): string {
  const valid = dates.filter(Boolean) as string[];
  if (valid.length === 0) return "2026-04-30";
  return valid.sort().reverse()[0]!;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const indexableLocales = ALL_LOCALES.filter((l) =>
    isIndexableLocale(SURFACE, l),
  );

  // ── Load all content upfront ─────────────────────────────────────────
  const posts = await getAllBlogPosts("en");
  const comparisons = await getAllComparisons();
  const useCases = await getAllUseCases();
  const pillars = await getAllPillars();
  const glossary = await getAllGlossaryTerms();
  const agents = await getAllAgentMetas();
  const mcpEntries = await getAllMcpMetas();
  const authorHandles = listAuthorHandles();

  // ── Compute real lastmod for listing pages from their content ────────
  const listingLastmod: Record<string, string> = {
    "/": latestDate([
      ...posts.map((p) => p.updatedAt ?? p.publishedAt),
      ...comparisons.map((c) => c.lastUpdated),
    ]),
    "/blog": latestDate(posts.map((p) => p.updatedAt ?? p.publishedAt)),
    "/vs": latestDate(comparisons.map((c) => c.lastUpdated)),
    "/solutions": latestDate(useCases.map((u) => u.lastUpdated)),
    "/concepts": latestDate(pillars.map((p) => p.lastUpdated)),
    "/glossary": latestDate(glossary.map((t) => t.lastUpdated)),
    "/authors": latestDate(posts.map((p) => p.updatedAt ?? p.publishedAt)),
    "/agents": latestDate(agents.map((a) => a.lastUpdated)),
    "/mcp": latestDate(mcpEntries.map((e) => e.lastUpdated)),
  };

  // ── Static routes ────────────────────────────────────────────────────
  const staticEntries: MetadataRoute.Sitemap = STATIC_ROUTES.map((r) => {
    const alt = alternates(r.path, indexableLocales);
    return {
      url: localeUrl("en", r.path),
      lastModified: r.lastModified ?? listingLastmod[r.path] ?? "2026-04-30",
      changeFrequency: r.changeFrequency,
      priority: r.priority,
      ...(alt ? { alternates: alt } : {}),
    };
  });

  // ── Author pages ─────────────────────────────────────────────────────
  const authorEntries: MetadataRoute.Sitemap = authorHandles.map((handle) => {
    const alt = alternates(`/authors/${handle}`, indexableLocales);
    return {
      url: localeUrl("en", `/authors/${handle}`),
      lastModified: listingLastmod["/authors"] ?? "2026-04-30",
      changeFrequency: "monthly" as const,
      priority: 0.5,
      ...(alt ? { alternates: alt } : {}),
    };
  });

  // ── Blog posts (locale alternates only where the MDX exists) ────────
  const blogEntries: MetadataRoute.Sitemap = posts.map((p) => {
    const translated = new Set(getAvailableBlogLocales(p.slug));
    const localesForAlternates = indexableLocales.filter((l) =>
      translated.has(l),
    );
    const alt = alternates(`/blog/${p.slug}`, localesForAlternates);
    const ogImageUrl = p.ogImage
      ? `${BASE_URL}${p.ogImage}`
      : `${BASE_URL}/blog/${p.slug}/opengraph-image`;
    return {
      url: localeUrl("en", `/blog/${p.slug}`),
      lastModified: p.updatedAt ?? p.publishedAt,
      changeFrequency: "monthly" as const,
      priority: 0.9,
      ...(alt ? { alternates: alt } : {}),
      images: [ogImageUrl],
    };
  });

  // ── Blog tag pages ───────────────────────────────────────────────────
  const tagsMap = new Map<string, string>();
  for (const p of posts) {
    for (const t of allTagsFor(p)) tagsMap.set(tagSlug(t), t);
  }
  const tagEntries: MetadataRoute.Sitemap = [...tagsMap.keys()].map(
    (slug) => {
      const alt = alternates(`/blog/tag/${slug}`, indexableLocales);
      return {
        url: localeUrl("en", `/blog/tag/${slug}`),
        lastModified: listingLastmod["/blog"] ?? "2026-04-30",
        changeFrequency: "weekly" as const,
        priority: 0.6,
        ...(alt ? { alternates: alt } : {}),
      };
    },
  );

  // ── Comparisons ──────────────────────────────────────────────────────
  const comparisonEntries: MetadataRoute.Sitemap = await Promise.all(
    comparisons.map(async (c) => {
      const translated = new Set(
        await getComparisonAvailableLocales(c.slug),
      );
      const localesForAlternates = indexableLocales.filter((l) =>
        translated.has(l),
      );
      const alt = alternates(`/vs/${c.slug}`, localesForAlternates);
      return {
        url: localeUrl("en", `/vs/${c.slug}`),
        lastModified: c.lastUpdated,
        changeFrequency: "monthly" as const,
        priority: 0.85,
        ...(alt ? { alternates: alt } : {}),
      };
    }),
  );

  // ── Use-cases (locale alternates only where MDX exists) ──────────────
  const useCaseEntries: MetadataRoute.Sitemap = useCases.map((u) => {
    const translated = new Set(getAvailableUseCaseLocales(u.slug));
    const localesForAlternates = indexableLocales.filter((l) =>
      translated.has(l),
    );
    const alt = alternates(`/solutions/${u.slug}`, localesForAlternates);
    return {
      url: localeUrl("en", `/solutions/${u.slug}`),
      lastModified: u.lastUpdated,
      changeFrequency: "monthly" as const,
      priority: 0.85,
      ...(alt ? { alternates: alt } : {}),
    };
  });

  // ── Pillars (concepts) ───────────────────────────────────────────────
  const pillarEntries: MetadataRoute.Sitemap = await Promise.all(
    pillars.map(async (p) => {
      const mdxLocales = new Set(getAvailablePillarLocales(p.slug));
      const metaLocales = new Set(await getPillarMetaTranslatedLocales(p.slug));
      const localesForAlternates = indexableLocales.filter(
        (l) => mdxLocales.has(l) && metaLocales.has(l),
      );
      const alt = alternates(`/concepts/${p.slug}`, localesForAlternates);
      return {
        url: localeUrl("en", `/concepts/${p.slug}`),
        lastModified: p.lastUpdated,
        changeFrequency: "monthly" as const,
        priority: 0.9,
        ...(alt ? { alternates: alt } : {}),
      };
    }),
  );

  // ── Glossary ─────────────────────────────────────────────────────────
  const glossaryEntries: MetadataRoute.Sitemap = await Promise.all(
    glossary.map(async (t) => {
      const translated = new Set(
        await getGlossaryAvailableLocales(t.slug),
      );
      const localesForAlternates = indexableLocales.filter((l) =>
        translated.has(l),
      );
      const alt = alternates(`/glossary/${t.slug}`, localesForAlternates);
      return {
        url: localeUrl("en", `/glossary/${t.slug}`),
        lastModified: t.lastUpdated,
        changeFrequency: "monthly" as const,
        priority: 0.6,
        ...(alt ? { alternates: alt } : {}),
      };
    }),
  );

  // ── Agents (gate hollow slugs without MDX) ───────────────────────────
  const agentEntries: MetadataRoute.Sitemap = agents
    .filter((a) => hasAgentMdx(a.slug))
    .map((a) => {
      const alt = alternates(`/agents/${a.slug}`, indexableLocales);
      return {
        url: localeUrl("en", `/agents/${a.slug}`),
        lastModified: a.lastUpdated,
        changeFrequency: "monthly" as const,
        priority: 0.7,
        ...(alt ? { alternates: alt } : {}),
      };
    });

  // ── MCP (gate hollow slugs without MDX) ──────────────────────────────
  const mcpListing: MetadataRoute.Sitemap = mcpEntries
    .filter((e) => hasMcpMdx(e.slug))
    .map((e) => {
      const alt = alternates(`/mcp/${e.slug}`, indexableLocales);
      return {
        url: localeUrl("en", `/mcp/${e.slug}`),
        lastModified: e.lastUpdated,
        changeFrequency: "monthly" as const,
        priority: 0.7,
        ...(alt ? { alternates: alt } : {}),
      };
    });

  return [
    ...staticEntries,
    ...authorEntries,
    ...pillarEntries,
    ...comparisonEntries,
    ...useCaseEntries,
    ...glossaryEntries,
    ...agentEntries,
    ...mcpListing,
    ...blogEntries,
    ...tagEntries,
  ];
}
