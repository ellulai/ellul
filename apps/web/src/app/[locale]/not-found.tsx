import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/routing";
import type { Locale } from "@ellul.ai/i18n-consts";

export async function generateMetadata({
  params,
}: {
  params?: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const resolved = (await params)?.locale as Locale | undefined;
  const t = await getTranslations({
    locale: resolved ?? "en",
    namespace: "common.notFound",
  });
  return {
    title: t("title"),
    robots: { index: false, follow: false },
  };
}

export default async function NotFound() {
  const t = await getTranslations("common.notFound");

  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center px-6">
      <h1 className="text-6xl font-bold tracking-tight text-cream">404</h1>
      <p className="mt-4 text-base text-cream/60">{t("title")}</p>
      <div className="mt-8 flex gap-3">
        <Link
          href="/"
          className="rounded-xl border border-cream/[0.08] bg-cream/[0.03] px-6 py-2.5 text-sm font-semibold text-cream/75 transition-all hover:bg-cream/[0.06] hover:text-cream"
        >
          {t("backHome")}
        </Link>
        <Link
          href="/docs"
          className="rounded-xl border border-cream/[0.08] bg-cream/[0.03] px-6 py-2.5 text-sm font-semibold text-cream/75 transition-all hover:bg-cream/[0.06] hover:text-cream"
        >
          {t("docs")}
        </Link>
      </div>
    </main>
  );
}
