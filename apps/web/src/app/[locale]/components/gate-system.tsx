import { getTranslations } from "next-intl/server";
import { rawSubtree } from "@ellul.ai/i18n";

const GATE_KEYS = [
  "gitPush",
  "deploy",
  "dbWrite",
  "secretRead",
  "domain",
  "policy",
] as const;

export default async function GateSystem() {
  const t = await getTranslations("home.gates");
  const items = rawSubtree<Record<string, { name: string; controls: string; ttl: string }>>(t, "items");

  const flowSteps = [
    { label: t("flow.agentLabel"), detail: t("flow.agentDetail"), accent: false },
    { label: t("flow.sandboxLabel"), detail: t("flow.sandboxDetailPause"), accent: false },
    { label: t("flow.youLabel"), detail: t("flow.youDetail"), accent: true },
    { label: t("flow.sandboxLabel"), detail: t("flow.sandboxDetailAct"), accent: false },
  ];

  return (
    <section
      id="safety"
      className="relative z-10 w-full border-y border-cream/[0.06] bg-cream/[0.015] py-24"
    >
      <div className="mx-auto max-w-7xl px-6">
        <p className="section-label">{t("eyebrow")}</p>
        <h2 className="mt-4 max-w-3xl text-3xl font-light tracking-[-0.02em] text-cream sm:text-4xl lg:text-5xl">
          {t("headline")}
        </h2>
        <p className="mt-6 max-w-2xl text-base leading-[1.7] text-cream/55">
          {t("bodyTop")}
        </p>
        <p className="mt-3 max-w-2xl text-base leading-[1.7] text-cream/80">
          {t("bodyBottom")}
        </p>

        {/* Flow diagram */}
        <div className="mt-12 flex flex-wrap items-center justify-center gap-2 sm:gap-0">
          {flowSteps.map((step, i) => (
            <div key={`${step.label}-${i}`} className="flex items-center">
              <div
                className={`min-w-[96px] rounded-lg border px-3 py-3 text-center sm:min-w-[120px] sm:px-5 sm:py-3.5 ${
                  step.accent
                    ? "border-sodium/40 bg-sodium-soft"
                    : "border-cream/[0.08] bg-ink-1"
                }`}
              >
                <p className={`text-xs font-semibold ${step.accent ? "text-sodium" : "text-cream/75"}`}>
                  {step.label}
                </p>
                <p className="mt-0.5 text-[10px] text-cream/45">{step.detail}</p>
              </div>
              {i < flowSteps.length - 1 && (
                <div className="mx-1.5 hidden text-cream/20 sm:block">
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
                  </svg>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Gate cards */}
        <div className="mt-14">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-cream/40">
            {t("gatesHeading")}
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {GATE_KEYS.map((key) => (
              <div
                key={key}
                className="rounded-xl border border-cream/[0.06] bg-ink-1 p-5"
              >
                <div className="flex items-center justify-between">
                  <code className="text-xs font-semibold text-sodium/85">{items[key]?.name}</code>
                  <span className="rounded-full border border-cream/[0.06] bg-cream/[0.03] px-2 py-0.5 font-mono text-[10px] text-cream/45">
                    {items[key]?.ttl}
                  </span>
                </div>
                <p className="mt-2 text-sm text-cream/75">{items[key]?.controls}</p>
              </div>
            ))}
          </div>
        </div>

        <p className="mt-10 max-w-3xl text-sm text-cream/45">
          {t("disclaimer")}
        </p>
      </div>
    </section>
  );
}
