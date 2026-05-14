import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "export",
  transpilePackages: [
    "@ellul.ai/i18n",
    "@ellul.ai/i18n-consts",
    "@ellul.ai/i18n-messages",
    "@ellul.ai/marketing-mdx",
  ],
  images: {
    unoptimized: true,
  },
};

export default withNextIntl(nextConfig);
