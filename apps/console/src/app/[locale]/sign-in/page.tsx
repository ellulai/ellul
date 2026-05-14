// SPDX-License-Identifier: MIT
"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import { getSession } from "@/lib/auth-client";
import { useLocaleAwareRedirect } from "@/lib/locale-redirect";
import { LoadingScreen } from "@/components/ui/spinner";
import { EllulLogo } from "@ellul.ai/ui/ellul-logo";
import { OAuthSignIn } from "@/components/auth/oauth-buttons";

const WEB_URL = process.env.NEXT_PUBLIC_WEB_URL!;

function SignInContent() {
  const redirectAfterAuth = useLocaleAwareRedirect();
  const searchParams = useSearchParams();
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const t = useTranslations("signIn");
  const tAuth = useTranslations("auth");
  const tCommon = useTranslations("common");

  const callbackPort = searchParams.get("callback_port");
  const callbackNonce = searchParams.get("nonce");

  useEffect(() => {
    const check = async () => {
      try {
        const { data } = await getSession();
        if (data) {
          if (callbackPort && callbackNonce) {
            localStorage.setItem("ps_cli_callback_port", callbackPort);
            localStorage.setItem("ps_cli_callback_nonce", callbackNonce);
          }
          redirectAfterAuth("/dashboard", data.user);
          return;
        }
      } catch {
        // Not authenticated — show sign-in form
      } finally {
        setIsCheckingAuth(false);
      }
    };
    check();
  }, [redirectAfterAuth, callbackPort, callbackNonce]);

  if (isCheckingAuth) {
    return <LoadingScreen message={tCommon("loading")} />;
  }

  return (
    <main className="min-h-screen flex flex-col items-center px-4 py-12 sm:py-20">
      <div className="text-center mb-10">
        <a href={WEB_URL} className="inline-flex items-center gap-2 mb-8">
          <EllulLogo className="h-8 w-8" />
          <span className="text-2xl font-bold tracking-tight text-cream">ellul</span>
        </a>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-cream">
          {t("heading")}
        </h1>
        <p className="mt-2 text-sm text-cream/60 max-w-md mx-auto">
          {t("subhead")}
        </p>
      </div>

      <div className="w-full max-w-sm">
        <OAuthSignIn callbackPort={callbackPort} callbackNonce={callbackNonce} />

        <p className="mt-8 text-center text-sm text-cream/60">
          {t("newToEllul")}{" "}
          <Link href="/sign-up" className="font-semibold text-sodium hover:text-sodium-strong transition-colors">
            {t("newToEllulCta")}
          </Link>
        </p>

        <p className="mt-6 text-center text-xs text-cream/45">
          {tAuth("agreeTerms")}
        </p>
      </div>
    </main>
  );
}

export default function SignInPage() {
  const tCommon = useTranslations("common");
  return (
    <Suspense fallback={<LoadingScreen message={tCommon("loading")} />}>
      <SignInContent />
    </Suspense>
  );
}
