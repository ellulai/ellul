import { Suspense } from "react";
import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Noto_Sans_JP, Noto_Sans_KR } from "next/font/google";
import { notFound } from "next/navigation";
import { setRequestLocale, getMessages, getTranslations } from "next-intl/server";
import { NextIntlClientProvider } from "next-intl";
import { ALL_LOCALES, type Locale, isRtlLocale, OG_LOCALE } from "@ellul.ai/i18n-consts";
import { buildHreflangAlternates } from "@ellul.ai/i18n/metadata";
import { getDocsBySection } from "@/lib/docs";
import { searchConsoleVerification } from "@/lib/search-console-verification";

const DOCS_BASE_URL = process.env.NEXT_PUBLIC_DOCS_URL!;
import { SidebarShell } from "@/components/sidebar-shell";
import { PostHogProvider } from "@/components/analytics/posthog-provider";
import { WebVitalsReporter } from "@/components/analytics/web-vitals";
import "../globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
  weight: ["200", "300", "400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
  weight: ["400", "500"],
});

const notoSansJP = Noto_Sans_JP({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-noto-sans-jp",
  weight: ["400", "500", "700"],
  preload: false,
});

const notoSansKR = Noto_Sans_KR({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-noto-sans-kr",
  weight: ["400", "500", "700"],
  preload: false,
});

export function generateStaticParams() {
  return ALL_LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale: rawLocale } = await params;
  const locale = (ALL_LOCALES.includes(rawLocale as Locale)
    ? (rawLocale as Locale)
    : "en") as Locale;
  const t = await getTranslations({ locale, namespace: "docs.meta" });

  const { canonical, languages } = buildHreflangAlternates({
    baseUrl: DOCS_BASE_URL,
    pathname: "/",
  });

  const verification = searchConsoleVerification(locale);

  return {
    metadataBase: new URL(DOCS_BASE_URL),
    title: {
      default: t("titleDefault"),
      template: t("titleTemplate"),
    },
    description: t("description"),
    alternates: { canonical, languages },
    openGraph: {
      title: t("titleDefault"),
      description: t("description"),
      siteName: "ellul",
      locale: OG_LOCALE[locale],
    },
    ...(verification.google
      ? { verification: { google: verification.google, other: verification.other } }
      : Object.keys(verification.other).length
        ? { verification: { other: verification.other } }
        : {}),
  };
}

export default async function LocaleLayout({
  children,
  params,
}: Readonly<{
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}>) {
  const { locale: rawLocale } = await params;
  if (!ALL_LOCALES.includes(rawLocale as Locale)) notFound();
  const locale = rawLocale as Locale;

  setRequestLocale(locale);
  const messages = await getMessages({ locale });
  const sections = getDocsBySection(locale);

  return (
    <html
      lang={locale}
      dir={isRtlLocale(locale) ? "rtl" : "ltr"}
      className={`${inter.variable} ${jetbrainsMono.variable} ${notoSansJP.variable} ${notoSansKR.variable}`}
    >
      <body className="font-sans">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Suspense fallback={null}>
            <PostHogProvider surface="docs" />
          </Suspense>
          <WebVitalsReporter surface="docs" />
          <SidebarShell sections={sections}>{children}</SidebarShell>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
