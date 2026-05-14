import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const POSTHOG_INGEST = process.env.NEXT_PUBLIC_POSTHOG_INGEST_HOST || "https://us.i.posthog.com";
const POSTHOG_ASSETS = process.env.NEXT_PUBLIC_POSTHOG_ASSETS_HOST || "https://us-assets.i.posthog.com";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@ellul.ai/ui",
    "@ellul.ai/i18n",
    "@ellul.ai/i18n-consts",
    "@ellul.ai/i18n-messages",
    "@ellul.ai/marketing-mdx",
  ],
  images: {
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL!,
    NEXT_PUBLIC_CONSOLE_URL: process.env.NEXT_PUBLIC_CONSOLE_URL!,
  },
  // Reverse-proxy /ingest/* to PostHog so AdBlocker rules don't drop our
  // analytics. This route is first-party — same origin as the page that
  // emitted the event — so a third-party tracker blocker leaves it alone.
  async rewrites() {
    return {
      // beforeFiles runs before Next.js's static-file/prerender lookup, so the
      // bare /vs/{slug}/raw.md request resolves to the prerendered /en/.../raw.md
      // body. The locale middleware handles this for pages but route handlers
      // ending in `.md` reach the prerender lookup before the rewrite resolves
      // unless we explicitly map them here. Per-locale `.md` URLs with the
      // explicit prefix (e.g. /ja/vs/devin/raw.md) still work via the [locale]
      // route directly — these rewrites only cover the no-prefix default-locale
      // case.
      beforeFiles: [
        { source: "/vs/:slug/raw.md", destination: "/en/vs/:slug/raw.md" },
        { source: "/solutions/:slug/raw.md", destination: "/en/solutions/:slug/raw.md" },
        { source: "/glossary/:slug/raw.md", destination: "/en/glossary/:slug/raw.md" },
        { source: "/blog/:slug/raw.md", destination: "/en/blog/:slug/raw.md" },
      ],
      // afterFiles: reverse-proxy /ingest/* to PostHog so AdBlocker rules don't
      // drop our analytics. First-party origin keeps tracker blockers off.
      afterFiles: [
        { source: "/ingest/static/:path*", destination: `${POSTHOG_ASSETS}/static/:path*` },
        { source: "/ingest/:path*", destination: `${POSTHOG_INGEST}/:path*` },
      ],
      fallback: [],
    };
  },
  // Discoverability hints pointing crawlers at /llms.txt and /llms-full.txt.
  // Not part of an IETF standard yet; the load-bearing signals are robots.txt
  // (which lists AI bots and links the sitemap) and llms.txt (which is what
  // every llms.txt-aware crawler probes). These headers are belt-and-braces.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-LLM-Index", value: "/llms.txt" },
          { key: "X-LLM-Index-Full", value: "/llms-full.txt" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: "/mcp/mcp", destination: "/mcp/overview", permanent: true },
    ];
  },
  skipTrailingSlashRedirect: true,
};

export default withNextIntl(nextConfig);
