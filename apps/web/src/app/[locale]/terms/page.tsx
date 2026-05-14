import type { Metadata } from "next";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { rawSubtree } from "@ellul.ai/i18n";
import { Link } from "@/i18n/routing";
import type { Locale } from "@ellul.ai/i18n-consts";
import { pageMetadata } from "@/lib/page-metadata";

export const dynamic = "force-static";

const ACCEPTABLE_USE_ITEM_KEYS = [
  "violation",
  "malware",
  "mining",
  "spam",
  "unauthorized",
  "unlawful",
  "resell",
] as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "terms.meta" });
  return pageMetadata({
    locale: locale as Locale,
    path: "/terms",
    title: t("title"),
    description: t("description"),
  });
}

function emailLink(chunks: React.ReactNode) {
  return (
    <a href="mailto:legal@ellul.ai" className="text-sodium hover:underline">
      {chunks}
    </a>
  );
}

function privacyLink(chunks: React.ReactNode) {
  return (
    <Link href="/privacy" className="text-sodium hover:underline">
      {chunks}
    </Link>
  );
}

export default async function TermsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale as Locale);

  const t = await getTranslations("terms");
  const acceptableUseItems = rawSubtree<Record<string, string>>(t, "acceptableUse.items");
  const refDisclaimer = t("referenceDisclaimer");

  return (
    <main className="flex flex-col items-center px-6">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div
          className="absolute -top-1/4 -left-1/4 w-[600px] h-[600px] rounded-full opacity-15"
          style={{
            background:
              "radial-gradient(circle, rgba(245,239,230,0.6) 0%, transparent 70%)",
            animation: "ambient-float 30s ease-in-out infinite",
          }}
        />
        <div
          className="absolute -bottom-1/4 -right-1/4 w-[500px] h-[500px] rounded-full opacity-10"
          style={{
            background:
              "radial-gradient(circle, rgba(240,166,90,0.4) 0%, transparent 70%)",
            animation: "ambient-float 40s ease-in-out infinite reverse",
          }}
        />
      </div>

      <article className="relative z-10 w-full max-w-3xl py-16 sm:py-24">
        {refDisclaimer ? (
          <aside
            role="note"
            aria-label="Reference translation notice"
            className="mb-10 rounded-xl border border-sodium/30 bg-sodium-soft px-5 py-4"
          >
            <div className="flex gap-3">
              <svg
                className="mt-0.5 h-5 w-5 shrink-0 text-sodium"
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden
              >
                <path
                  fillRule="evenodd"
                  d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-8-3a.75.75 0 0 0-.75.75v3.5a.75.75 0 0 0 1.5 0v-3.5A.75.75 0 0 0 10 7Zm0 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
                  clipRule="evenodd"
                />
              </svg>
              <p className="text-sm leading-relaxed text-cream/85">{refDisclaimer}</p>
            </div>
          </aside>
        ) : null}

        <section>
          <h1 className="text-3xl font-bold tracking-tight text-cream sm:text-5xl">
            {t("header.title")}
          </h1>
          <p className="mt-4 text-sm text-cream/45">{t("header.effectiveLine")}</p>
          <p className="mt-6 text-base leading-relaxed text-cream/60">
            {t("header.intro")}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("description.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("description.body")}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("accounts.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("accounts.body")}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("subscriptions.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("subscriptions.body1")}
          </p>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("subscriptions.body2")}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("acceptableUse.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("acceptableUse.intro")}
          </p>
          <ul className="mt-4 space-y-3 text-sm leading-relaxed text-cream/60">
            {ACCEPTABLE_USE_ITEM_KEYS.map((key) => (
              <li key={key} className="flex gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-cream/30" />
                {acceptableUseItems[key]}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("acceptableUse.outro")}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("apiKeys.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("apiKeys.body1")}
          </p>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("apiKeys.body2")}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("yourContent.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("yourContent.body1")}
          </p>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("yourContent.body2")}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("ip.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("ip.body")}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("privacyRef.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t.rich("privacyRef.body", { link: privacyLink })}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("disclaimers.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60 uppercase tracking-wide">
            {t("disclaimers.bodyAllCaps")}
          </p>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("disclaimers.body")}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("liability.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("liability.body1")}
          </p>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("liability.body2")}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("termination.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("termination.body1")}
          </p>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("termination.body2")}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("governingLaw.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("governingLaw.body")}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("changes.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("changes.body")}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("contact.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t.rich("contact.body", { email: emailLink })}
          </p>
        </section>

        <section className="mt-20 border-t border-cream/[0.06] pt-8">
          <Link
            href="/"
            className="text-sm text-cream/45 transition-colors hover:text-cream"
          >
            {t("backLink")}
          </Link>
        </section>
      </article>
    </main>
  );
}
