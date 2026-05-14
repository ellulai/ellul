import type { MetadataRoute } from "next";

type ChangeFreq = MetadataRoute.Sitemap[number]["changeFrequency"];

export interface StaticRoute {
  path: string;
  changeFrequency?: ChangeFreq;
  priority: number;
  /** ISO date string. Omit for listing pages — sitemap.ts computes from content. */
  lastModified?: string;
}

// Static routes only. Comparison, use-case, blog, and tag URLs are walked
// dynamically from src/content/ in sitemap.ts so the sitemap stays in lock-step
// with the typed data files.
export const STATIC_ROUTES: StaticRoute[] = [
  { path: "/", changeFrequency: "weekly", priority: 1.0 },
  { path: "/pricing", changeFrequency: "monthly", priority: 0.9, lastModified: "2026-04-30" },
  { path: "/faq", changeFrequency: "monthly", priority: 0.85, lastModified: "2026-04-30" },
  { path: "/blog", changeFrequency: "weekly", priority: 0.8 },
  { path: "/vs", changeFrequency: "weekly", priority: 0.85 },
  { path: "/solutions", changeFrequency: "weekly", priority: 0.85 },
  { path: "/concepts", changeFrequency: "monthly", priority: 0.9 },
  { path: "/glossary", changeFrequency: "monthly", priority: 0.7 },
  { path: "/authors", changeFrequency: "monthly", priority: 0.5 },
  { path: "/agents", changeFrequency: "weekly", priority: 0.85 },
  { path: "/mcp", changeFrequency: "weekly", priority: 0.85 },
  { path: "/docs", changeFrequency: "monthly", priority: 0.8, lastModified: "2026-04-30" },
  { path: "/prompt-engineering", changeFrequency: "monthly", priority: 0.75, lastModified: "2026-04-30" },
  { path: "/privacy", changeFrequency: "yearly", priority: 0.3, lastModified: "2026-04-30" },
  { path: "/terms", changeFrequency: "yearly", priority: 0.3, lastModified: "2026-04-30" },
];

export const STATIC_ROUTE_PATHS: Set<string> = new Set(STATIC_ROUTES.map((r) => r.path));

export function isStaticRoute(path: string): boolean {
  return STATIC_ROUTE_PATHS.has(path);
}
