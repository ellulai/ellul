"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

export default function NotFound() {
  const t = useTranslations("common");

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-6">
      <p className="mb-4 text-xl font-light tracking-[-0.025em]">
        <span className="bg-sodium bg-clip-text text-transparent">ellul</span>
      </p>
      <h1 className="text-4xl font-extralight tracking-[-0.03em] text-cream sm:text-5xl">404</h1>
      <p className="mt-2 text-cream/60">{t("notFound.title")}</p>
      <Link
        href="/"
        className="mt-6 rounded-lg border border-[rgba(245, 239, 230, 0.07)] bg-[#13131A] px-6 py-2.5 text-sm font-medium text-cream transition-colors hover:bg-[#1A1A23]"
      >
        {t("notFound.backHome")}
      </Link>
    </main>
  );
}
