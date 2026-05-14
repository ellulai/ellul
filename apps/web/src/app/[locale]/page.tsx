import { setRequestLocale, getTranslations } from "next-intl/server";
import { rawSubtree } from "@ellul.ai/i18n";
import type { Locale } from "@ellul.ai/i18n-consts";
import Hero from "./components/hero";
import Highlights from "./components/highlights";
import ProblemStatement from "./components/problem-statement";
import PillarsOverview from "./components/pillars-overview";
import DistributionWedge from "./components/distribution-wedge";
import GateSystem from "./components/gate-system";
import PricingOverview from "./components/pricing-overview";
import ContentHub from "./components/content-hub";
import CtaFooter from "./components/cta-footer";

export const dynamic = "force-static";

const baseUrl = "https://ellul.ai";

const FEATURE_KEYS = [
  "alwaysOn",
  "parallel",
  "passkey",
  "byoa",
  "namespace",
  "encrypted",
  "integrations",
] as const;

const FAQ_ITEM_KEYS = [
  "agentWorkstation",
  "vsCursor",
  "parallel",
  "passkey",
  "duration",
] as const;

function localizedHomeUrl(locale: Locale): string {
  return locale === "en" ? baseUrl : `${baseUrl}/${locale}`;
}

export default async function Home({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = rawLocale as Locale;
  setRequestLocale(locale);

  const t = await getTranslations("home");
  const tTier = await getTranslations("tier");
  const features = rawSubtree<Record<string, string>>(t, "softwareSchema.features");
  const faqItems = rawSubtree<Record<string, { q: string; a: string }>>(t, "faqSchema.items");

  // schema.org JSON-LD: applicationCategory is a controlled enum
  // (DeveloperApplication) — must stay literal. operatingSystem, priceCurrency,
  // billingDuration, unitText are schema.org/ISO codes Google parses verbatim;
  // keep literal across locales. applicationSubCategory is free-text and IS
  // localized for JP discoverability.
  const softwareApplicationSchema = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "ellul",
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: t("softwareSchema.applicationSubCategory"),
    operatingSystem: "Web",
    description: t("softwareSchema.description"),
    url: localizedHomeUrl(locale),
    offers: [
      {
        "@type": "Offer",
        name: tTier("hobby.name"),
        price: "20",
        priceCurrency: "USD",
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price: "20",
          priceCurrency: "USD",
          billingDuration: "P1M",
          unitText: "month",
        },
      },
      {
        "@type": "Offer",
        name: tTier("pro.name"),
        price: "50",
        priceCurrency: "USD",
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price: "50",
          priceCurrency: "USD",
          billingDuration: "P1M",
          unitText: "month",
        },
      },
    ],
    featureList: FEATURE_KEYS.map((k) => features[k]).filter(Boolean),
    publisher: {
      "@type": "Organization",
      name: "ellul",
      url: baseUrl,
    },
  };

  const homeFaqSchema = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ_ITEM_KEYS.map((k) => {
      const item = faqItems[k];
      return {
        "@type": "Question",
        name: item?.q ?? "",
        acceptedAnswer: {
          "@type": "Answer",
          text: item?.a ?? "",
        },
      };
    }),
  };

  return (
    <main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplicationSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(homeFaqSchema) }}
      />
      <Hero />
      <Highlights />
      <ProblemStatement />
      <PillarsOverview />
      <DistributionWedge />
      <GateSystem />
      <PricingOverview />
      <ContentHub />
      <CtaFooter />
    </main>
  );
}
