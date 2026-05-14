import type { MetadataRoute } from "next";

export const dynamic = "force-static";

const BASE_URL = process.env.NEXT_PUBLIC_DOCS_URL!;

// Default: indexable. Set ROBOTS_DISALLOW=true on staging deploys to flip
// the entire surface to global Disallow.
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
      { userAgent: "*", allow: "/" },
      ...ALLOW_ALL_AI.map((userAgent) => ({ userAgent, allow: "/" })),
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
    host: BASE_URL,
  };
}
