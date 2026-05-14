import type { Metadata } from "next";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { rawSubtree } from "@ellul.ai/i18n";
import { TierGrid, PLATFORM_TIERS, tierLabelsFromT, localizeTiers } from "@ellul.ai/ui/pricing";
import type { Locale } from "@ellul.ai/i18n-consts";
import { pageMetadata } from "@/lib/page-metadata";
import { productSchema, tierOffer } from "@/lib/structured-data";

const CONSOLE_URL = process.env.NEXT_PUBLIC_CONSOLE_URL!;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "pricing.meta" });
  return pageMetadata({
    locale: locale as Locale,
    path: "/pricing",
    title: t("title"),
    description: t("description"),
  });
}

const FEATURE_KEYS = [
  "fido2",
  "namespace",
  "shield",
  "postgres",
  "deploy",
  "hibernate",
] as const;

const FAQ_KEYS = ["diff", "gateSystem", "upgrade"] as const;

export default async function PricingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale as Locale);

  const t = await getTranslations("pricing");
  const tTier = await getTranslations("tier");
  const planFeatures = rawSubtree<Record<string, { title: string; desc: string }>>(t, "everyPlanIncludes.items");
  const faqItems = rawSubtree<Record<string, { q: string; a: string }>>(t, "faq.items");

  const localizedTiers = localizeTiers(PLATFORM_TIERS, tTier);

  const productJsonLd = productSchema({
    name: "ellul Cloud Platform",
    description: t("subhead"),
    offers: localizedTiers
      .filter((tier) => !tier.comingSoon && typeof tier.price === "number")
      .map((tier) =>
        tierOffer({
          name: tier.name,
          price: String(tier.price),
          url: `${CONSOLE_URL}/sign-up?tier=${tier.id}`,
        }),
      ),
  });

  return (
    <main className="flex flex-col items-center px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(productJsonLd) }}
      />
      {/* ── Header ── */}
      <section className="relative z-10 flex flex-col items-center pt-8 pb-4 sm:pt-12">
        <h1 className="text-[2.75rem] font-extralight leading-[1.02] tracking-[-0.03em] text-cream sm:text-[3rem] sm:tracking-[-0.035em] md:text-[3.5rem] lg:text-[4rem] lg:tracking-[-0.04em]">
          {t("heading")}
        </h1>
        <p className="mt-4 max-w-2xl text-center text-base leading-[1.7] text-cream/55">
          {t("subhead")}
        </p>
      </section>

      {/* ── Cloud Platform ── */}
      <section className="relative z-10 w-full max-w-7xl pb-16">
        <p className="text-center text-xs font-semibold uppercase tracking-wider text-cream/30">
          {t("platformLabel")}
        </p>
        <TierGrid
          tiers={localizedTiers}
          labels={tierLabelsFromT(tTier)}
          getHref={(tier) => tier.comingSoon ? undefined : `${CONSOLE_URL}/sign-up?tier=${tier.id}`}
          getCtaLabel={(tier) => tier.comingSoon ? tTier("cta.comingSoon") : tier.price === 0 ? tTier("cta.getStartedFree") : tTier("cta.getStarted")}
        />
      </section>

      {/* ── What you get ── */}
      <section className="relative z-10 w-full max-w-5xl pb-16">
        <h2 className="text-center text-2xl font-light tracking-[-0.02em] text-cream sm:text-3xl">
          {t("everyPlanIncludes.heading")}
        </h2>
        <p className="mt-3 text-center text-sm leading-[1.7] text-cream/55 max-w-xl mx-auto">
          {t("everyPlanIncludes.subhead")}
        </p>
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURE_KEYS.map((key) => (
            <div
              key={key}
              className="rounded-2xl border border-cream/[0.06] bg-cream/[0.02] p-6 text-left backdrop-blur-sm"
            >
              <h3 className="text-sm font-semibold tracking-tight text-cream">
                {planFeatures[key]?.title}
              </h3>
              <p className="mt-2 text-sm text-cream/60">{planFeatures[key]?.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── FAQ ── */}
      <section className="relative z-10 w-full max-w-3xl pb-16">
        <h2 className="text-center text-2xl font-light tracking-[-0.02em] text-cream sm:text-3xl">
          {t("faq.heading")}
        </h2>
        <div className="mt-8 space-y-4">
          {FAQ_KEYS.map((key) => (
            <details
              key={key}
              className="group rounded-2xl border border-cream/[0.06] bg-cream/[0.02] backdrop-blur-sm transition-all hover:border-cream/[0.1]"
            >
              <summary className="flex cursor-pointer select-none items-center justify-between px-6 py-4 text-sm font-semibold text-cream">
                {faqItems[key]?.q}
                <svg
                  className="h-4 w-4 shrink-0 text-cream/30 transition-transform group-open:rotate-45"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
              </summary>
              <p className="px-6 pb-4 text-sm text-cream/60">{faqItems[key]?.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ── Bottom CTA ── */}
      <section className="relative z-10 pb-16 text-center">
        <a
          href={`${CONSOLE_URL}/sign-up`}
          className="inline-block rounded-md bg-sodium px-8 py-3 text-sm font-medium text-ink transition hover:bg-sodium"
        >
          {t("cta.button")}
        </a>
        <p className="mt-3 text-sm text-cream/60">
          {t("cta.note")}
        </p>
      </section>
    </main>
  );
}
