import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const PLATFORM_DOMAIN = process.env.NEXT_PUBLIC_PLATFORM_DOMAIN!;
const APP_DOMAIN = process.env.NEXT_PUBLIC_APP_DOMAIN!;

const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains; preload",
  },
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
      `connect-src 'self' https://api.${PLATFORM_DOMAIN} https://*.${PLATFORM_DOMAIN} wss://*.${PLATFORM_DOMAIN} https://*.${APP_DOMAIN} wss://*.${APP_DOMAIN} https://*.sslip.io wss://*.sslip.io`,
      `frame-src 'self' https://*.${PLATFORM_DOMAIN} https://*.${APP_DOMAIN} https://*.sslip.io`,
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "upgrade-insecure-requests",
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

  // Disable x-powered-by header
  poweredByHeader: false,
};

export default withNextIntl(nextConfig);
