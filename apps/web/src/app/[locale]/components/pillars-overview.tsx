import { getTranslations } from "next-intl/server";
import { rawSubtree } from "@ellul.ai/i18n";

const PANE_KEYS = ["coding", "marketing", "docs"] as const;

const CODING_CAPABILITY_KEYS = ["canRead", "canWrite", "canBuild", "canTest"] as const;

type PaneEntry = {
  label: string;
  role: string;
  activity: string;
  detail: string;
  canRead: string;
  canWrite?: string;
  canBuild?: string;
  canTest?: string;
  blocked?: string;
};

export default async function PillarsOverview() {
  const t = await getTranslations("home.pillars");
  const panesRaw = rawSubtree<Record<typeof PANE_KEYS[number], PaneEntry>>(t, "panes");

  const panes = PANE_KEYS.map((key) => {
    const p = panesRaw[key];
    if (key === "coding") {
      return {
        key,
        label: p.label,
        role: p.role,
        activity: p.activity,
        detail: p.detail,
        can: CODING_CAPABILITY_KEYS.map((c) => p[c] ?? ""),
        blocked: null as string | null,
      };
    }
    return {
      key,
      label: p.label,
      role: p.role,
      activity: p.activity,
      detail: p.detail,
      can: [p.canRead],
      blocked: p.blocked ?? null,
    };
  });

  const summary = [
    { label: t("summary.eachAgentLabel"), value: t("summary.eachAgentValue") },
    { label: t("summary.crossLabel"), value: t("summary.crossValue") },
    { label: t("summary.coordLabel"), value: t("summary.coordValue") },
  ];

  return (
    <section
      id="composition"
      className="relative z-10 w-full py-24"
    >
      <div className="mx-auto max-w-7xl px-6">
        <div className="max-w-3xl">
          <p className="section-label">{t("eyebrow")}</p>
          <h2 className="mt-4 text-3xl font-light tracking-[-0.02em] text-cream sm:text-4xl lg:text-5xl">
            {t("headlineLine1")}
            <br />
            <span className="text-cream/45">{t("headlineLine2")}</span>
          </h2>
          <p className="mt-6 text-base leading-[1.7] text-cream/55">
            {t("bodyTop")}
          </p>
          <p className="mt-3 text-base leading-[1.7] text-cream/80">
            {t("bodyBottom")}
          </p>
        </div>

        {/* Three panes, side by side */}
        <div className="mt-14 grid gap-4 lg:grid-cols-3">
          {panes.map((pane) => (
            <div
              key={pane.key}
              className="relative overflow-hidden rounded-xl border border-cream/[0.08] bg-ink-1 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.7)]"
            >
              {/* Pane header: typography differentiates roles, not color */}
              <div className="flex items-center justify-between border-b border-cream/[0.06] px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-cream/15" />
                  <span className="h-1.5 w-1.5 rounded-full bg-cream/15" />
                  <span className="h-1.5 w-1.5 rounded-full bg-cream/15" />
                  <span className="ml-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-cream/40">
                    {pane.label}
                  </span>
                </div>
                <span className="text-[10px] font-medium uppercase tracking-[0.16em] text-sodium/85">
                  {pane.role}
                </span>
              </div>

              {/* Pane body */}
              <div className="p-4">
                <p className="text-sm font-medium text-cream/90">{pane.activity}</p>
                <p className="mt-1 flex items-center gap-2 font-mono text-[11px] text-cream/45">
                  <span className="inline-flex h-1.5 w-1.5 rounded-full bg-sodium" />
                  {pane.detail}
                </p>

                <div className="mt-4 space-y-1.5">
                  {pane.can.map((c) => (
                    <div key={c} className="flex items-center gap-2 text-[11px] text-cream/65">
                      <svg className="h-3 w-3 text-sodium/80" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                      {c}
                    </div>
                  ))}
                  {pane.blocked && (
                    <div className="flex items-center gap-2 text-[11px] text-terra/85">
                      <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                      </svg>
                      {pane.blocked}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-10 grid gap-6 sm:grid-cols-3">
          {summary.map((s) => (
            <div key={s.label} className="border-l-2 border-sodium/40 pl-4">
              <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-cream/40">
                {s.label}
              </p>
              <p className="mt-1 text-base font-semibold text-cream/90">{s.value}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
