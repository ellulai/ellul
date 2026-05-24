import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { readFileSync } from "fs";
import { resolve } from "path";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const PLATFORM_DOMAIN = process.env.NEXT_PUBLIC_PLATFORM_DOMAIN!;
const APP_DOMAIN = process.env.NEXT_PUBLIC_APP_DOMAIN!;

const securityHeaders = [
  ...(process.env.NODE_ENV === "production"
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=31536000; includeSubDomains; preload",
        },
      ]
    : []),
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "SAMEORIGIN",
  },
  {
    key: "X-XSS-Protection",
    value: "1; mode=block",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "img-src 'self' data: https: blob:",
      "font-src 'self' data: https://fonts.gstatic.com",
      `connect-src 'self' https://api.${PLATFORM_DOMAIN} https://*.${PLATFORM_DOMAIN} wss://*.${PLATFORM_DOMAIN} https://*.${APP_DOMAIN} wss://*.${APP_DOMAIN} https://*.sslip.io wss://*.sslip.io${process.env.NODE_ENV !== "production" ? ` http://localhost ws://localhost http://localhost:7700 ws://localhost:7700 http://localhost:3002 ws://localhost:3002 ws://localhost:3000 http://localhost:3001${process.env.PROOT_PROXY_PORT ? ` http://localhost:${process.env.PROOT_PROXY_PORT} ws://localhost:${process.env.PROOT_PROXY_PORT}` : ""}` : ""}`,
      `frame-src 'self' https://*.${PLATFORM_DOMAIN} https://*.${APP_DOMAIN} https://*.sslip.io http://localhost http://localhost:8443 http://localhost:4443${process.env.NEXT_PUBLIC_LIMA_PREVIEW_PORT ? ` http://localhost:${process.env.NEXT_PUBLIC_LIMA_PREVIEW_PORT}` : ""}`,
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      // NOTE: upgrade-insecure-requests removed — Cloudflare enforces HTTPS
      // at the edge, and this directive breaks Android proot (localhost HTTP
      // iframes get upgraded to HTTPS which has no TLS cert).
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  transpilePackages: [
    "@ellul.ai/api-client",
    "@ellul.ai/ui",
    "@ellul.ai/i18n",
    "@ellul.ai/i18n-consts",
    "@ellul.ai/i18n-messages",
  ],

  async rewrites() {
    if (process.env.NODE_ENV !== "development") return [];
    let limaSecret = process.env.LIMA_JWT_SECRET;
    let proxyPort = process.env.PROOT_PROXY_PORT;
    if (!limaSecret || !proxyPort) {
      try {
        const content = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
        if (!limaSecret) {
          const m = content.match(/^LIMA_JWT_SECRET=(.+)$/m);
          if (m?.[1]?.trim()) limaSecret = m[1].trim();
        }
        if (!proxyPort) {
          const m = content.match(/^PROOT_PROXY_PORT=(.+)$/m);
          if (m?.[1]?.trim()) proxyPort = m[1].trim();
        }
      } catch {}
    }
    // Proot proxy takes priority — all traffic through Caddy on the device
    if (proxyPort) {
      const main = `http://localhost:${proxyPort}`;
      const code = `http://localhost:${proxyPort}`;
      return {
        beforeFiles: [
          { source: "/ws", destination: `${main}/ws` },
          { source: "/code-ws", destination: `${code}/code-ws` },
          { source: "/_auth/:path*", destination: `${main}/_auth/:path*` },
          { source: "/browser/:path*", destination: `${code}/browser/:path*` },
          { source: "/vps-config.js", destination: `${main}/vps-config.js` },
          { source: "/health", destination: `${main}/health` },
          { source: "/_term/:path*", destination: `${main}/term/:path*` },
          { source: "/term/:path*", destination: `${main}/term/:path*` },
          { source: "/terminal/:path*", destination: `${main}/terminal/:path*` },
          { source: "/srv/:path*", destination: `${code}/:path*` },
          { source: "/agent/:path*", destination: `${main}/agent/:path*` },
        ],
        afterFiles: [
          { source: "/api/:path*", destination: "/vps-proxy/api/:path*" },
        ],
        fallback: [],
      };
    }
    if (limaSecret) {
      const shield = "http://127.0.0.1:3005";
      const fileApi = "http://127.0.0.1:3002";
      const bridge = "http://127.0.0.1:7700";
      return {
        beforeFiles: [
          { source: "/ws", destination: `${bridge}/ws` },
          { source: "/code-ws", destination: `${fileApi}/code-ws` },
          { source: "/_auth/:path*", destination: "/auth-proxy/:path*" },
          { source: "/browser/:path*", destination: `${fileApi}/browser/:path*` },
          { source: "/vps-config.js", destination: "/api/local-vps-config" },
          { source: "/health", destination: `${shield}/health` },
        ],
        afterFiles: [
          { source: "/api/:path*", destination: "/vps-proxy/api/:path*" },
        ],
        fallback: [],
      };
    }
    return {
      fallback: [
        { source: "/srv/api/:path*", destination: "http://127.0.0.1:3002/api/:path*" },
        { source: "/srv/_term/:path*", destination: "http://127.0.0.1:7701/_term/:path*" },
        { source: "/srv/:path*", destination: "http://127.0.0.1:3005/:path*" },
      ],
    };
  },

  // Security headers
  async headers() {
    return [
      {
        // Apply to all routes
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },

  // Required for Cloudflare Workers deployment
  // https://opennext.js.org/cloudflare
  experimental: {
    // Enable server actions (if used)
    serverActions: {
      bodySizeLimit: "2mb",
    },
    // React Compiler — auto-memoizes components (React 19+)
    reactCompiler: true,
  },

  // Image optimization - use Cloudflare Images or unoptimized for Workers
  images: {
    unoptimized: true,
    // Or use Cloudflare Images:
    // loader: "custom",
    // loaderFile: "./src/lib/cloudflare-image-loader.ts",
  },

  // Ensure environment variables are available
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL!,
    NEXT_PUBLIC_WEB_URL: process.env.NEXT_PUBLIC_WEB_URL!,
    NEXT_PUBLIC_PLATFORM_DOMAIN: PLATFORM_DOMAIN,
    NEXT_PUBLIC_APP_DOMAIN: APP_DOMAIN,
  },

  typescript: {
    ignoreBuildErrors: true,
  },

  // Disable x-powered-by header
  poweredByHeader: false,
};

export default withNextIntl(nextConfig);
