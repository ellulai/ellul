import type { Metadata } from "next";
import { setRequestLocale, getTranslations } from "next-intl/server";
import type { Locale } from "@ellul.ai/i18n-consts";
import { pageMetadata } from "@/lib/page-metadata";

export const dynamic = "force-static";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({
    locale,
    namespace: "webDocs.layout",
  });
  return pageMetadata({
    locale: locale as Locale,
    path: "/docs",
    title: t("title"),
    description: t("description"),
  });
}

export default async function DocsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale as Locale);
  return <>{children}</>;
}
