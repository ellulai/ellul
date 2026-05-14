// SPDX-License-Identifier: MIT

"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

export default function NotFound() {
  const t = useTranslations("console.notFound");
  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6">
      <p className="mb-4 text-xl font-semibold tracking-tight">
        <span className="text-cream">ellul</span>
      </p>
      <h1 className="text-4xl font-bold tracking-tight text-cream">404</h1>
      <p className="mt-2 text-cream/60">{t("message")}</p>
      <Link
        href="/"
        className="mt-6 rounded-lg border border-border bg-card px-6 py-2.5 text-sm font-medium text-cream transition-colors hover:bg-secondary"
      >
        {t("backHome")}
      </Link>
    </main>
  );
}
