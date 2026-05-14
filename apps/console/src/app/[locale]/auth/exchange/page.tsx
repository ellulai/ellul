// SPDX-License-Identifier: MIT
"use client";

import { useEffect, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { getSession } from "@/lib/auth-client";
import { useLocaleAwareRedirect } from "@/lib/locale-redirect";
import { LoadingScreen } from "@/components/ui/spinner";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

function ExchangeContent() {
  const router = useRouter();
  const redirectAfterAuth = useLocaleAwareRedirect();
  const searchParams = useSearchParams();
  const tCommon = useTranslations("common");
  const exchanged = useRef(false);

  useEffect(() => {
    if (exchanged.current) return;
    exchanged.current = true;

    const code = searchParams.get("code");
    if (!code) {
      router.replace("/sign-up");
      return;
    }

    const exchange = async () => {
      try {
        const res = await fetch(`${API_URL}/api/auth/native/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ code }),
        });

        if (res.ok) {
          // Session is now established — fetch user to honor pref locale.
          const { data } = await getSession();
          redirectAfterAuth("/dashboard", data?.user);
        } else {
          router.replace("/sign-up");
        }
      } catch {
        router.replace("/sign-up");
      }
    };

    exchange();
  }, [router, redirectAfterAuth, searchParams]);

  return <LoadingScreen message={tCommon("signingIn")} />;
}

export default function AuthExchangePage() {
  const tCommon = useTranslations("common");
  return (
    <Suspense fallback={<LoadingScreen message={tCommon("signingIn")} />}>
      <ExchangeContent />
    </Suspense>
  );
}
