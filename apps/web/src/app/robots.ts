import type { MetadataRoute } from "next";

const BASE_URL = "https://ellul.ai";

// Default: indexable. Staging deploys set ROBOTS_DISALLOW=true to flip
// the entire surface to global Disallow. Lighthouse, local builds, and
// review apps that point NEXT_PUBLIC_WEB_URL at non-production hosts
// stay indexable so SEO/perf audits pass.
const DISALLOW_ALL = process.env.ROBOTS_DISALLOW === "true";

const ALLOW_ALL_AI = [
  "GPTBot",
  "ChatGPT-User",
  "OAI-SearchBot",
  "ClaudeBot",
  "Claude-Web",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "GoogleOther",
  "Applebot",
  "Applebot-Extended",
  "CCBot",
  "cohere-ai",
  "Bytespider",
  "Diffbot",
  "DuckAssistBot",
  "Meta-ExternalAgent",
  "Meta-ExternalFetcher",
  "MistralAI-User",
  "YouBot",
  "Amazonbot",
];

export default function robots(): MetadataRoute.Robots {
  if (DISALLOW_ALL) {
    return {
      rules: [{ userAgent: "*", disallow: "/" }],
    };
  }

  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: ["/signup", "/api/", "/_next/", "/preview/"] },
      ...ALLOW_ALL_AI.map((userAgent) => ({ userAgent, allow: "/" })),
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
    host: BASE_URL,
  };
}
