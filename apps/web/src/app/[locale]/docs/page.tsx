import type { Metadata } from "next";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/routing";
import type { Locale } from "@ellul.ai/i18n-consts";
import { pageMetadata } from "@/lib/page-metadata";

const CONSOLE_URL = process.env.NEXT_PUBLIC_CONSOLE_URL!;

const STEP_KEYS = ["create-account", "launch-sandbox", "build-with-ai"] as const;
const USE_CASE_KEYS = [
  "agent-security",
  "financial-isolation",
  "platform-embedding",
  "compliance",
] as const;
const SECURITY_KEYS = [
  "capability-report",
  "liveness-ping",
  "manual-mode",
  "self-hash-attest",
  "self-test",
  "sha256-drift-check",
  "signed-manifest",
] as const;
const ARCH_KEYS = ["foundry", "control", "studio", "core-invariant"] as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "webDocs.meta" });
  return pageMetadata({
    locale: locale as Locale,
    path: "/docs",
    title: t("title"),
    description: t("description"),
    ogType: "article",
  });
}

export default async function DocsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale as Locale);
  const t = await getTranslations({ locale, namespace: "webDocs" });

  return (
    <main className="flex flex-col items-center px-6">
      <article className="relative z-10 w-full max-w-3xl py-16 sm:py-24">
        <section>
          <h1 className="text-3xl font-bold tracking-tight text-cream sm:text-5xl">
            {t("mission.heading")}
          </h1>
          <p className="mt-6 text-base leading-relaxed text-cream/60">
            {t("mission.p1")}
          </p>
          <p className="mt-4 text-base leading-relaxed text-cream/60">
            {t("mission.p2")}
          </p>
        </section>

        <section className="mt-20">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("gettingStarted.heading")}
          </h2>
          <p className="mt-4 text-base text-cream/60">
            {t("gettingStarted.intro")}
          </p>

          <div className="mt-8 space-y-6">
            {STEP_KEYS.map((key) => (
              <div
                key={key}
                className="rounded-2xl border border-cream/[0.06] bg-cream/[0.02] p-6"
              >
                <div className="flex items-start gap-4">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-sodium/20 bg-sodium/10 text-sm font-bold text-sodium">
                    {t(`gettingStarted.steps.${key}.step`)}
                  </div>
                  <div className="flex-1">
                    <h3 className="text-base font-semibold text-cream">
                      {t(`gettingStarted.steps.${key}.title`)}
                    </h3>
                    <p className="mt-1 text-sm leading-relaxed text-cream/60">
                      {t(`gettingStarted.steps.${key}.desc`)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-8">
            <a
              href={`${CONSOLE_URL}/sign-up`}
              className="inline-block rounded-xl bg-sodium px-8 py-3 text-sm font-semibold text-ink shadow-lg shadow-sodium/25 transition-all hover:shadow-xl hover:shadow-sodium/30 hover:brightness-110"
            >
              {t("gettingStarted.ctaPrimary")}
            </a>
          </div>
        </section>

        <section className="mt-20">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("useCases.heading")}
          </h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            {USE_CASE_KEYS.map((key) => (
              <div
                key={key}
                className="rounded-2xl border border-cream/[0.06] bg-cream/[0.02] p-6"
              >
                <h3 className="text-sm font-semibold text-cream">
                  {t(`useCases.items.${key}.title`)}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-cream/60">
                  {t(`useCases.items.${key}.desc`)}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-20">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("security.heading")}
          </h2>
          <p className="mt-4 text-base leading-relaxed text-cream/60">
            {t("security.intro")}
          </p>

          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            {SECURITY_KEYS.map((key) => (
              <div
                key={key}
                className="rounded-2xl border border-cream/[0.06] bg-cream/[0.02] p-6"
              >
                <h3 className="text-sm font-semibold text-cream">
                  {t(`security.items.${key}.name`)}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-cream/60">
                  {t(`security.items.${key}.desc`)}
                </p>
                <p className="mt-3 truncate font-mono text-[10px] text-cream/35">
                  {t(`security.items.${key}.capabilityId`)}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-20">
          <h2 className="text-2xl font-bold tracking-tight text-cream">
            {t("architecture.heading")}
          </h2>
          <p className="mt-4 text-base leading-relaxed text-cream/60">
            {t("architecture.intro")}
          </p>

          <div className="mt-8 space-y-4">
            {ARCH_KEYS.map((key) => (
              <div key={key} className="flex gap-4">
                <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-sodium" />
                <div>
                  <h3 className="text-sm font-semibold text-cream">
                    {t(`architecture.items.${key}.component`)}
                  </h3>
                  <p className="mt-1 text-sm leading-relaxed text-cream/60">
                    {t(`architecture.items.${key}.desc`)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-20 rounded-2xl border border-cream/[0.06] bg-cream/[0.02] p-8 text-center">
          <h2 className="text-lg font-semibold text-cream">{t("cta.heading")}</h2>
          <p className="mt-2 text-sm text-cream/60">{t("cta.sub")}</p>
          <div className="mt-6 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <a
              href={`${CONSOLE_URL}/sign-up`}
              className="rounded-xl bg-sodium px-8 py-3 text-sm font-semibold text-ink shadow-lg shadow-sodium/25 transition-all hover:shadow-xl hover:shadow-sodium/30 hover:brightness-110"
            >
              {t("cta.ctaPrimary")}
            </a>
            <Link
              href="/pricing"
              className="rounded-xl border border-cream/[0.08] bg-cream/[0.03] px-8 py-3 text-sm font-semibold text-cream/75 transition-all hover:bg-cream/[0.06] hover:text-cream"
            >
              {t("cta.ctaSecondary")}
            </Link>
          </div>
        </section>
      </article>
    </main>
  );
}
