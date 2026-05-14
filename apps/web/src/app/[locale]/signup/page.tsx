"use client";

import { Suspense, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";

const CONSOLE_URL =
  process.env.NEXT_PUBLIC_CONSOLE_URL!;

/**
 * Signup bridge: redirects from ellul.ai/signup to console.ellul.ai/sign-up
 * preserving all query params (callback_port, nonce, product, etc.).
 *
 * This page exists because the CLI opens `https://ellul.ai/signup` and the
 * actual signup flow lives on the console app.
 */
function SignupRedirectInner() {
  const searchParams = useSearchParams();
  const t = useTranslations("auth");

  useEffect(() => {
    const params = searchParams.toString();
    const target = `${CONSOLE_URL}/sign-up${params ? `?${params}` : ""}`;
    window.location.href = target;
  }, [searchParams]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-cream/60 text-sm">{t("redirectingToSignUp")}</p>
    </div>
  );
}

export default function SignupRedirect() {
  const t = useTranslations("auth");

  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <p className="text-cream/60 text-sm">{t("redirectingToSignUp")}</p>
        </div>
      }
    >
      <SignupRedirectInner />
    </Suspense>
  );
}
