// SPDX-License-Identifier: MIT
"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import { getSession } from "@/lib/auth-client";
import { useLocaleAwareRedirect } from "@/lib/locale-redirect";
import { LoadingScreen } from "@/components/ui/spinner";
import { PLATFORM_TIERS, CLI_SHIELD_TIERS, TierCard, tierLabelsFromT, localizeTiers } from "@ellul.ai/ui/pricing";
import { EllulLogo } from "@ellul.ai/ui/ellul-logo";
import { OAuthSignIn } from "@/components/auth/oauth-buttons";

const WEB_URL = process.env.NEXT_PUBLIC_WEB_URL!;

function SignUpContent() {
  const redirectAfterAuth = useLocaleAwareRedirect();
  const searchParams = useSearchParams();
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [selectedTier, setSelectedTier] = useState<string | null>(null);
  const t = useTranslations("signUp");
  const tAuth = useTranslations("auth");
  const tTier = useTranslations("tier");
  const tCommon = useTranslations("common");

  const tierParam = searchParams.get("tier");
  const productParam = searchParams.get("product");
  const callbackPort = searchParams.get("callback_port");
  const callbackNonce = searchParams.get("nonce");

  const isShieldFlow = productParam === "shield_proxy";
  const baseTiers = isShieldFlow ? CLI_SHIELD_TIERS : PLATFORM_TIERS;

  const localizedTiers = localizeTiers(baseTiers, tTier);

  useEffect(() => {
    if (isShieldFlow) {
      setSelectedTier("shield_proxy");
    } else if (tierParam && PLATFORM_TIERS.find((t) => t.id === tierParam)) {
      setSelectedTier(tierParam);
    }
  }, [tierParam, isShieldFlow]);

  useEffect(() => {
    const check = async () => {
      try {
        const { data } = await getSession();
        if (data) {
          const selectedId = isShieldFlow ? "shield_proxy:pro" : tierParam;
          if (selectedId) {
            sessionStorage.setItem("ps_signup_product_plan", selectedId);
          }
          if (callbackPort && callbackNonce) {
            localStorage.setItem("ps_cli_callback_port", callbackPort);
            localStorage.setItem("ps_cli_callback_nonce", callbackNonce);
          }
          redirectAfterAuth("/dashboard", data.user);
          return;
        }
      } catch {
        // Not authenticated — stay on sign-up page
      } finally {
        setIsCheckingAuth(false);
      }
    };
    check();
  }, [redirectAfterAuth, tierParam, isShieldFlow, callbackPort, callbackNonce]);

  if (isCheckingAuth) {
    return <LoadingScreen message={tCommon("loading")} />;
  }

  const productPlan = selectedTier || tierParam;
  const heading = isShieldFlow ? t("headingShield") : t("heading");
  const subhead = isShieldFlow
    ? t("subheadShieldFlow")
    : selectedTier
      ? t("subheadHasTier")
      : t("subheadPickTier");

  return (
    <main className="min-h-screen flex flex-col items-center px-4 py-12 sm:py-20">
      <div className="text-center mb-10">
        <a href={WEB_URL} className="inline-flex items-center gap-2 mb-8">
          <EllulLogo className="h-8 w-8" />
          <span className="text-2xl font-bold tracking-tight text-cream">ellul</span>
        </a>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-cream">
          {heading}
        </h1>
        <p className="mt-2 text-sm text-cream/60 max-w-md mx-auto">
          {subhead}
        </p>
      </div>

      {/* Selected tier confirmation */}
      {selectedTier && (
        <div className="w-full max-w-sm mb-8">
          {(() => {
            const tier = localizedTiers.find((t) => t.id === selectedTier);
            if (!tier) return null;
            return (
              <div
                className={`rounded-2xl border px-5 py-4 ${
                  tier.recommended
                    ? "border-sodium/40 bg-ink-1"
                    : "border-[rgba(245,239,230,0.07)] bg-[#13131A]"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-semibold tracking-tight bg-sodium bg-clip-text text-transparent">
                    {tier.name}
                  </h3>
                  <div className="flex items-baseline gap-1">
                    <span className="text-xl font-semibold text-cream">${tier.price}</span>
                    <span className="text-xs text-cream/40">{tTier("perMonth")}</span>
                  </div>
                </div>
                <div className="rounded-lg bg-black/30 border border-[rgba(245,239,230,0.07)] px-3 py-2 text-[11px]">
                  <span className="text-cream/80 font-semibold">{tier.capacity}</span>
                </div>
                {!isShieldFlow && (
                  <button
                    onClick={() => setSelectedTier(null)}
                    className="mt-3 text-xs text-sodium hover:text-sodium transition-colors"
                  >
                    {t("changePlan")}
                  </button>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Tier picker (when no tier selected) */}
      {!selectedTier && !isShieldFlow && (
        <div className="w-full max-w-4xl mb-10">
          <div className="grid gap-3 sm:grid-cols-2 max-w-2xl mx-auto">
            {localizedTiers.map((tier) => (
              <TierCard
                key={tier.id}
                tier={tier}
                onClick={() => setSelectedTier(tier.id)}
                labels={tierLabelsFromT(tTier)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="w-full max-w-sm">
        {selectedTier ? (
          <OAuthSignIn
            productPlan={productPlan}
            callbackPort={callbackPort}
            callbackNonce={callbackNonce}
          />
        ) : (
          <p className="text-center text-xs text-cream/45">{t("selectTierPrompt")}</p>
        )}

        <p className="mt-8 text-center text-sm text-cream/60">
          {t("alreadyHaveAccount")}{" "}
          <Link
            href="/sign-in"
            className="font-semibold text-sodium hover:text-sodium-strong transition-colors"
          >
            {tAuth("signIn")}
          </Link>
        </p>

        <p className="mt-6 text-center text-xs text-cream/45">
          {tAuth("agreeTerms")}
        </p>
      </div>
    </main>
  );
}

export default function SignUpPage() {
  const tCommon = useTranslations("common");
  return (
    <Suspense fallback={<LoadingScreen message={tCommon("loading")} />}>
      <SignUpContent />
    </Suspense>
  );
}
