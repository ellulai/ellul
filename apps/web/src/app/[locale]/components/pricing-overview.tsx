import { getTranslations } from "next-intl/server";
import { TierGrid, PLATFORM_TIERS, tierLabelsFromT, localizeTiers } from "@ellul.ai/ui/pricing";

const CONSOLE_URL = process.env.NEXT_PUBLIC_CONSOLE_URL!;

const STACK = [
  { name: "Cursor Pro", price: 20 },
  { name: "Copilot", price: 20 },
  { name: "Vercel Pro", price: 20 },
];

export default async function PricingOverview() {
  const t = await getTranslations("home.pricingOverview");
  const tTier = await getTranslations("tier");

  const localizedTiers = localizeTiers(PLATFORM_TIERS, tTier);

  return (
    <section id="pricing" className="relative z-10 w-full py-24">
      <div className="mx-auto max-w-7xl px-6">
        <div className="mx-auto max-w-3xl text-center">
          <p className="section-label">{t("eyebrow")}</p>
          <h2 className="mt-4 text-3xl font-light tracking-[-0.02em] text-cream sm:text-4xl">
            {t("headlineLine1")}
            <br />
            <span className="text-cream/45">{t("headlineLine2")}</span>
          </h2>
        </div>

        {/* Replacement anchor */}
        <div className="mx-auto mt-10 max-w-3xl">
          <div className="rounded-2xl border border-cream/[0.06] bg-ink-1 p-6 sm:p-8">
            <p className="text-center text-sm font-medium text-cream/45">
              {t("stackHeader")}
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              {STACK.map((s, i) => (
                <div key={s.name} className="flex items-center">
                  <div className="rounded-lg border border-cream/[0.08] bg-cream/[0.03] px-4 py-2.5 text-center">
                    <p className="text-sm font-medium text-cream/85">{s.name}</p>
                    <p className="mt-0.5 text-[11px] text-cream/45">{t("perMonth", { price: `$${s.price}` })}</p>
                  </div>
                  {i < STACK.length - 1 && (
                    <span className="mx-1 text-cream/25">+</span>
                  )}
                </div>
              ))}
            </div>
            <p className="mx-auto mt-6 max-w-xl text-center text-base leading-[1.7] text-cream/75">
              {t.rich("priceLine", {
                strong: (chunks) => (
                  <span className="font-semibold text-sodium">{chunks}</span>
                ),
              })}
            </p>
          </div>
        </div>

        <div className="mt-14">
          <TierGrid
            tiers={localizedTiers}
            labels={tierLabelsFromT(tTier)}
            getHref={(t) => t.comingSoon ? undefined : `${CONSOLE_URL}/sign-up`}
            getCtaLabel={(t) => t.comingSoon ? tTier("cta.comingSoon") : t.price === 0 ? tTier("cta.getStartedFree") : tTier("cta.getStarted")}
          />
        </div>
      </div>
    </section>
  );
}
