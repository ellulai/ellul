import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { Locale } from "@ellul.ai/i18n-consts";

/**
 * Catch-all 404 router. Any /[locale]/* path that doesn't match a static or
 * dynamic route lands here and is escalated to /[locale]/not-found.tsx via
 * notFound(). Without this file Next.js falls back to its built-in EN 404
 * (`<title>404: This page could not be found.</title>`), which leaks English
 * onto every locale's invalid path.
 *
 * Precedence: static routes > dynamic routes (`[slug]`) > this catch-all.
 * Existing `/[locale]/agents/[slug]`, `/[locale]/blog/[slug]`, etc. still
 * win — they call `notFound()` themselves when the slug is unknown.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale: locale as Locale, namespace: "common.notFound" });
  return {
    title: t("title"),
    robots: { index: false, follow: false },
  };
}

export default function CatchAllPage(): never {
  notFound();
}
