import { Suspense } from "react";
import type { Metadata } from "next";
import { Inter, JetBrains_Mono, Noto_Sans_JP, Noto_Sans_KR } from "next/font/google";
import { notFound } from "next/navigation";
import { setRequestLocale, getMessages, getTranslations } from "next-intl/server";
import { NextIntlClientProvider } from "next-intl";
import { EllulLogo } from "@ellul.ai/ui/ellul-logo";
import { ALL_LOCALES, type Locale, isRtlLocale, OG_LOCALE } from "@ellul.ai/i18n-consts";
import { FOOTER_MARKET_LINKS, isPriorityLocale } from "@ellul.ai/i18n-consts/markets";
import { isStaticRoute } from "@/lib/routes";
import { pageMetadata } from "@/lib/page-metadata";
import { organizationSchema, websiteSchema } from "@/lib/structured-data";
import { searchConsoleVerification } from "@/lib/search-console-verification";
import { Link } from "@/i18n/routing";
import { MobileMenu } from "./mobile-menu";
import { ResourcesDropdown } from "./resources-dropdown";
import { PostHogProvider } from "@/components/analytics/posthog-provider";
import { WebVitalsReporter } from "@/components/analytics/web-vitals";
import {
  CtaClickReporter,
  LlmReferralReporter,
} from "@/components/analytics/content-events";
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

const baseUrl = process.env.NEXT_PUBLIC_WEB_URL!;

const CONSOLE_URL = process.env.NEXT_PUBLIC_CONSOLE_URL!;
const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL!;

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

  const t = await getTranslations({ locale, namespace: "home.meta" });
  const homeTitle = t("title");
  const homeDescription = t("description");
  const homeKeywords = t.raw("keywords") as string[];

  const base = pageMetadata({
    locale,
    path: "/",
    title: homeTitle,
    description: homeDescription,
    keywords: homeKeywords,
    authors: [{ name: "ellul" }],
  });

  const verification = searchConsoleVerification(locale);

  return {
    ...base,
    metadataBase: new URL(baseUrl),
    title: {
      default: homeTitle,
      template: "%s | ellul",
    },
    applicationName: "ellul",
    creator: "ellul",
    publisher: "ellul",
    openGraph: {
      ...base.openGraph,
      locale: OG_LOCALE[locale],
    },
    twitter: {
      ...base.twitter,
      creator: "@ellul_ai",
      site: "@ellul_ai",
    },
    category: "technology",
    ...(verification.google
      ? { verification: { google: verification.google, other: verification.other } }
      : Object.keys(verification.other).length
        ? { verification: { other: verification.other } }
        : {}),
    other: { google: "notranslate" },
  };
}

async function Navbar({ locale }: { locale: Locale }) {
  const tNav = await getTranslations({ locale, namespace: "nav" });
  const tAuth = await getTranslations({ locale, namespace: "auth" });

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-cream/[0.06] bg-ink/80 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <div className="flex items-center gap-8">
          <Link
            href="/"
            className="flex items-center gap-2 text-lg font-light tracking-[-0.03em] text-cream"
          >
            <EllulLogo className="h-7 w-7" />
            ellul
          </Link>
          <div className="hidden items-center gap-6 md:flex">
            <Link href="/#autonomy" className="text-sm text-cream/55 transition-colors hover:text-cream">
              {tNav("product.autonomy")}
            </Link>
            <Link href="/#composition" className="text-sm text-cream/55 transition-colors hover:text-cream">
              {tNav("product.composition")}
            </Link>
            <Link href="/#how-it-works" className="text-sm text-cream/55 transition-colors hover:text-cream">
              {tNav("product.howItWorks")}
            </Link>
            <Link href="/#pricing" className="text-sm text-cream/55 transition-colors hover:text-cream">
              {tNav("product.pricing")}
            </Link>
            <a href={DOCS_URL} className="text-sm text-cream/55 transition-colors hover:text-cream">
              {tNav("product.docs")}
            </a>
            <ResourcesDropdown />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <a
            href={`${CONSOLE_URL}/sign-in`}
            className="hidden sm:inline-block rounded-md px-3 py-2 text-sm text-cream/70 transition hover:text-cream"
          >
            {tAuth("signIn")}
          </a>
          <a
            href={`${CONSOLE_URL}/sign-up`}
            className="hidden sm:inline-block rounded-md bg-sodium px-4 py-2 text-sm font-medium text-ink transition hover:bg-sodium-strong"
          >
            {tAuth("getStarted")}
          </a>

          <MobileMenu consoleUrl={CONSOLE_URL} />
        </div>
      </div>
    </nav>
  );
}

async function Footer({ locale }: { locale: Locale }) {
  const tFooter = await getTranslations({ locale, namespace: "footer" });
  const tBrand = await getTranslations({ locale, namespace: "brand" });
  const marketLinks = isPriorityLocale(locale)
    ? FOOTER_MARKET_LINKS[locale].filter((l) => isStaticRoute(l.href))
    : [];

  return (
    <footer className="relative z-10 border-t border-cream/[0.06] bg-black/20">
      <div className="mx-auto max-w-7xl px-6 py-12">
        <div className="grid gap-8 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <span className="flex items-center gap-2 text-sm font-light tracking-[-0.02em] text-cream/85">
              <EllulLogo className="h-5 w-5" />
              ellul
            </span>
            <p className="mt-2 text-xs leading-relaxed text-cream/35">
              {tBrand("tagline")}
            </p>
          </div>

          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/35">{tFooter("product.label")}</p>
            <div className="mt-3 flex flex-col gap-2">
              <Link href="/#autonomy" className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("product.autonomy")}</Link>
              <Link href="/#composition" className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("product.composition")}</Link>
              <Link href="/#how-it-works" className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("product.howItWorks")}</Link>
              <Link href="/#safety" className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("product.safety")}</Link>
              <Link href="/#pricing" className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("product.pricing")}</Link>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/35">{tFooter("explore.label")}</p>
            <div className="mt-3 flex flex-col gap-2">
              <Link href="/blog" className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("explore.blog")}</Link>
              <Link href="/vs" className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("explore.comparisons")}</Link>
              <Link href="/concepts" className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("explore.concepts")}</Link>
              <Link href="/solutions" className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("explore.solutions")}</Link>
              <Link href="/glossary" className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("explore.glossary")}</Link>
              <Link href="/agents" className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("explore.agents")}</Link>
              <Link href="/mcp" className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("explore.mcp")}</Link>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/35">{tFooter("resources.label")}</p>
            <div className="mt-3 flex flex-col gap-2">
              <a href={DOCS_URL} className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("resources.documentation")}</a>
              <a href={`${DOCS_URL}/getting-started/quick-start`} className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("resources.quickStart")}</a>
              <a href={`${DOCS_URL}/concepts/sovereign-model`} className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("resources.sovereignModel")}</a>
              <a href={`${DOCS_URL}/security`} className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("resources.security")}</a>
              <a href={`${DOCS_URL}/reference/tier-comparison`} className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("resources.tierComparison")}</a>
              <a href={`${DOCS_URL}/reference/faq`} className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("resources.faq")}</a>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/35">{tFooter("company.label")}</p>
            <div className="mt-3 flex flex-col gap-2">
              <a href="https://github.com/joeetdev/ellul.ai-vps" target="_blank" rel="noopener noreferrer" className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("company.github")}</a>
              <Link href="/privacy" className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("company.privacy")}</Link>
              <Link href="/terms" className="text-sm text-cream/55 transition-colors hover:text-cream">{tFooter("company.terms")}</Link>
            </div>
          </div>
        </div>

        {marketLinks.length > 0 && (
          <div className="mt-10 border-t border-cream/[0.06] pt-6">
            <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/35">
              {tFooter("featured")}
            </p>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
              {marketLinks.map((m) => (
                <Link
                  key={m.href}
                  href={m.href}
                  className="text-sm text-cream/55 transition-colors hover:text-cream"
                >
                  {m.anchorText}
                </Link>
              ))}
            </div>
          </div>
        )}

        <div className="mt-10 flex flex-col items-start justify-between gap-3 border-t border-cream/[0.06] pt-6 sm:flex-row sm:items-center">
          <p className="text-xs text-cream/25">
            {tBrand("byline")}
          </p>
          <p className="text-xs text-cream/25">
            {tBrand("copyright", { year: new Date().getFullYear() })}
          </p>
        </div>
      </div>
    </footer>
  );
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
  const t = await getTranslations({ locale, namespace: "home.meta" });
  const description = t("description");

  return (
    <html
      lang={locale}
      dir={isRtlLocale(locale) ? "rtl" : "ltr"}
      translate="no"
      className={`${inter.variable} ${jetbrainsMono.variable} ${notoSansJP.variable} ${notoSansKR.variable}`}
    >
      <body className="font-sans">
        <NextIntlClientProvider locale={locale} messages={messages}>
          <Suspense fallback={null}>
            <PostHogProvider surface="web" />
          </Suspense>
          <WebVitalsReporter surface="web" />
          <CtaClickReporter />
          <LlmReferralReporter />
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema(description)) }}
          />
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: JSON.stringify(websiteSchema(locale, description)) }}
          />
          <Navbar locale={locale} />
          <div className="pt-16">{children}</div>
          <Footer locale={locale} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
