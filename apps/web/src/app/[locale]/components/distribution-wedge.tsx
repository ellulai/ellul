import { getTranslations } from "next-intl/server";
import { rawSubtree } from "@ellul.ai/i18n";

const STEP_KEYS = ["signup", "spinup", "handoff"] as const;
const FEATURE_KEYS = [
  "alwaysOn",
  "parallel",
  "offLaptop",
  "persistent",
  "realDev",
  "stack",
] as const;
// Brand names per packages/i18n-messages/scripts/glossary.json — literal
// English across every locale. Do NOT translate / katakanize.
const AGENTS = ["Claude Code", "Codex", "Cursor", "OpenCode", "Grok Build"];

export default async function DistributionWedge() {
  const t = await getTranslations("home.howItWorks");
  const steps = rawSubtree<Record<string, { title: string; desc: string }>>(t, "steps");
  const features = rawSubtree<Record<string, { title: string; desc: string }>>(t, "features");

  return (
    <section
      id="how-it-works"
      className="relative z-10 w-full border-y border-cream/[0.06] py-24"
    >
      <div className="mx-auto max-w-7xl px-6">
        <p className="section-label">{t("eyebrow")}</p>
        <h2 className="mt-4 max-w-3xl text-3xl font-light tracking-[-0.02em] text-cream sm:text-4xl">
          {t("headline")}
        </h2>
        <p className="mt-4 max-w-2xl text-base leading-[1.7] text-cream/55">
          {t("subhead")}
        </p>

        {/* Steps grid */}
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {STEP_KEYS.map((key, i) => (
            <div
              key={key}
              className="rounded-xl border border-cream/[0.06] bg-ink-1 p-6"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-sodium/30 bg-sodium-soft text-sm font-bold text-sodium">
                {i + 1}
              </div>
              <h3 className="mt-4 text-base font-semibold text-cream">{steps[key]?.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-cream/60">{steps[key]?.desc}</p>
            </div>
          ))}
        </div>

        {/* What you get */}
        <div className="mt-16">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-cream/40">
            {t("featuresEyebrow")}
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURE_KEYS.map((key) => (
              <div
                key={key}
                className="rounded-xl border border-cream/[0.06] bg-ink-1 p-5"
              >
                <div className="flex items-start gap-3">
                  <svg
                    className="mt-0.5 h-4 w-4 shrink-0 text-sodium/85"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <div>
                    <p className="text-sm font-medium text-cream/90">{features[key]?.title}</p>
                    <p className="mt-1 text-xs leading-relaxed text-cream/45">{features[key]?.desc}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Agent pills */}
        <div className="mt-12">
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-cream/30">
            {t("bringEyebrow")}
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            {AGENTS.map((f) => (
              <span
                key={f}
                className="rounded-full border border-cream/[0.08] bg-cream/[0.03] px-4 py-1.5 text-xs font-medium text-cream/55"
              >
                {f}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
