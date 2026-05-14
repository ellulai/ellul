import type { Metadata } from "next";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { rawSubtree } from "@ellul.ai/i18n";
import { Link } from "@/i18n/routing";
import type { Locale } from "@ellul.ai/i18n-consts";
import { pageMetadata } from "@/lib/page-metadata";

export const dynamic = "force-static";

const NOT_COLLECTED_ITEM_KEYS = ["apiKeys", "code", "crypto"] as const;
const HOW_USED_ITEM_KEYS = [
  "provision",
  "auth",
  "billing",
  "transactional",
  "diagnose",
  "legal",
] as const;
const THIRD_PARTY_SERVICE_KEYS = [
  "anthropic",
  "openai",
  "openrouter",
  "github",
  "google",
] as const;
const SUBPROCESSOR_KEYS = ["payment", "cloud", "cdn", "support"] as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "privacy.meta" });
  return pageMetadata({
    locale: locale as Locale,
    path: "/privacy",
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

export default async function PrivacyPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale as Locale);

  const t = await getTranslations("privacy");
  const notCollected = rawSubtree<Record<string, { label: string; desc: string }>>(t, "notCollected.items");
  const howUsed = rawSubtree<Record<string, string>>(t, "howUsed.items");
  const services = rawSubtree<Record<string, { name: string; purpose: string }>>(t, "thirdParty.services");
  const subprocessors = rawSubtree<Record<string, string>>(t, "thirdParty.subprocessors");
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
            {t("collected.heading")}
          </h2>

          <h3 className="mt-8 text-base font-semibold text-cream">
            {t("collected.account.title")}
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-cream/60">
            {t("collected.account.body")}
          </p>

          <h3 className="mt-8 text-base font-semibold text-cream">
            {t("collected.usage.title")}
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-cream/60">
            {t("collected.usage.body")}
          </p>

          <h3 className="mt-8 text-base font-semibold text-cream">
            {t("collected.device.title")}
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-cream/60">
            {t("collected.device.body")}
          </p>

          <h3 className="mt-8 text-base font-semibold text-cream">
            {t("collected.payment.title")}
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-cream/60">
            {t("collected.payment.body")}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("notCollected.heading")}
          </h2>
          <div className="mt-6 space-y-4">
            {NOT_COLLECTED_ITEM_KEYS.map((key) => {
              const item = notCollected[key];
              return (
                <div key={key} className="flex gap-4">
                  <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-sodium" />
                  <div>
                    <h3 className="text-sm font-semibold text-cream">{item?.label}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-cream/60">{item?.desc}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("howUsed.heading")}
          </h2>
          <ul className="mt-6 space-y-3 text-sm leading-relaxed text-cream/60">
            {HOW_USED_ITEM_KEYS.map((key) => (
              <li key={key} className="flex gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-cream/30" />
                {howUsed[key]}
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("thirdParty.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("thirdParty.intro")}
          </p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {THIRD_PARTY_SERVICE_KEYS.map((key) => {
              const svc = services[key];
              return (
                <div
                  key={key}
                  className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] px-4 py-3"
                >
                  <span className="text-sm font-medium text-cream">{svc?.name}</span>
                  <span className="ml-2 text-sm text-cream/45">{svc?.purpose}</span>
                </div>
              );
            })}
          </div>

          <h3 className="mt-10 text-base font-semibold text-cream">
            {t("thirdParty.subprocessorsHeading")}
          </h3>
          <p className="mt-3 text-sm leading-relaxed text-cream/60">
            {t("thirdParty.subprocessorsIntro")}
          </p>
          <ul className="mt-3 space-y-2 text-sm leading-relaxed text-cream/60">
            {SUBPROCESSOR_KEYS.map((key) => (
              <li key={key} className="flex gap-3">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-cream/30" />
                {subprocessors[key]}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm leading-relaxed text-cream/60">
            {t.rich("thirdParty.requestList", { email: emailLink })}
          </p>

          <p className="mt-6 text-sm leading-relaxed text-cream/60">
            {t("thirdParty.noSell")}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("storage.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("storage.body1")}
          </p>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("storage.body2")}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("retention.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("retention.body")}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("children.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t("children.body")}
          </p>
        </section>

        <section className="mt-16">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("rights.heading")}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-cream/60">
            {t.rich("rights.body", { email: emailLink })}
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
