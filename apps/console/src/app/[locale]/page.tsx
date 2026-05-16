// SPDX-License-Identifier: MIT
"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { getSession } from "@/lib/auth-client";
import { useLocaleAwareRedirect } from "@/lib/locale-redirect";
import { LoadingScreen } from "@/components/ui/spinner";
import { MOCK_MODE } from "@/lib/mock-data";
import { isTauriApp } from "@/lib/utils";

const WEB_URL = process.env.NEXT_PUBLIC_WEB_URL!;

export default function Home() {
  const router = useRouter();
  const redirectAfterAuth = useLocaleAwareRedirect();
  const tCommon = useTranslations("common");

  useEffect(() => {
    if (MOCK_MODE) {
      router.replace("/dashboard");
      return;
    }
    const check = async () => {
      const MAX_RETRIES = 3;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const { data, error } = await getSession();
        if (data) {
          redirectAfterAuth("/dashboard", data.user);
          return;
        }
        const isTransient = error && typeof error === "object" && "status" in error &&
          ((error as { status?: number }).status === undefined || (error as { status?: number }).status! >= 500);
        if (isTransient && attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        if (isTauriApp()) {
          router.replace("/sign-up");
        } else {
          window.location.href = WEB_URL;
        }
        return;
      }
    };
    check();
  }, [router, redirectAfterAuth]);

  return <LoadingScreen message={tCommon("loading")} />;
}
