import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/routing";

const CONCEPTS = [
  { key: "agentWorkstation", href: "/concepts/agent-workstation" },
  { key: "alwaysOnAiAgent", href: "/concepts/always-on-ai-agent" },
  { key: "parallelAgents", href: "/concepts/parallel-agents" },
] as const;

const COMPARISONS = [
  { key: "vsCursor", href: "/vs/cursor" },
  { key: "vsDevin", href: "/vs/devin" },
  { key: "vsReplit", href: "/vs/replit" },
] as const;

const MORE = [
  { key: "solutions", href: "/solutions" },
  { key: "blog", href: "/blog" },
  { key: "agents", href: "/agents" },
] as const;

export default async function ContentHub() {
  const t = await getTranslations("home.contentHub");

  return (
    <section className="relative z-10 mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28">
      <div className="max-w-2xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sodium/80">
          {t("eyebrow")}
        </p>
        <h2 className="mt-5 text-[2rem] font-extralight leading-[1.05] tracking-[-0.03em] text-cream sm:text-[2.5rem]">
          {t("headlineLine1")}
          <br />
          <span className="text-cream/55">{t("headlineLine2")}</span>
        </h2>
      </div>

      <div className="mt-14 grid gap-10 lg:grid-cols-3">
        {/* Concepts column */}
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/35">
            {t("concepts.label")}
          </p>
          <div className="mt-4 flex flex-col gap-3">
            {CONCEPTS.map((c) => (
              <Link
                key={c.key}
                href={c.href}
                className="group rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-4 transition hover:border-cream/[0.12] hover:bg-cream/[0.04]"
              >
                <p className="text-sm font-semibold text-cream group-hover:text-sodium">
                  {t(`concepts.${c.key}.title`)}
                </p>
                <p className="mt-1 text-[13px] leading-[1.6] text-cream/50">
                  {t(`concepts.${c.key}.desc`)}
                </p>
              </Link>
            ))}
          </div>
        </div>

        {/* Comparisons column */}
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/35">
            {t("comparisons.label")}
          </p>
          <div className="mt-4 flex flex-col gap-3">
            {COMPARISONS.map((c) => (
              <Link
                key={c.key}
                href={c.href}
                className="group rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-4 transition hover:border-cream/[0.12] hover:bg-cream/[0.04]"
              >
                <p className="text-sm font-semibold text-cream group-hover:text-sodium">
                  {t(`comparisons.${c.key}.title`)}
                </p>
                <p className="mt-1 text-[13px] leading-[1.6] text-cream/50">
                  {t(`comparisons.${c.key}.desc`)}
                </p>
              </Link>
            ))}
          </div>
        </div>

        {/* More column */}
        <div>
          <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-cream/35">
            {t("more.label")}
          </p>
          <div className="mt-4 flex flex-col gap-3">
            {MORE.map((c) => (
              <Link
                key={c.key}
                href={c.href}
                className="group rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-4 transition hover:border-cream/[0.12] hover:bg-cream/[0.04]"
              >
                <p className="text-sm font-semibold text-cream group-hover:text-sodium">
                  {t(`more.${c.key}.title`)}
                </p>
                <p className="mt-1 text-[13px] leading-[1.6] text-cream/50">
                  {t(`more.${c.key}.desc`)}
                </p>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
