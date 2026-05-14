import { getTranslations } from "next-intl/server";
import { rawSubtree } from "@ellul.ai/i18n";

// 24-hour times. Code-shaped values per packages/i18n-messages/scripts/translate-prompt.md
// rule 6 — they stay literal across locales. Matches the cadence shown in
// the hero NIGHT_LOG_LAYOUT and reads cleanly in JP/KR/DE which use 24-hour
// by default.
const TIMELINE = [
  { time: "23:42", eventKey: "closeLaptop", agent: false },
  { time: "01:18", eventKey: "agentFinish", agent: true },
  { time: "03:04", eventKey: "testsPushed", agent: true },
  { time: "06:51", eventKey: "prDrafted", agent: true },
  { time: "07:30", eventKey: "youApprove", agent: false },
] as const;

export default async function ProblemStatement() {
  const t = await getTranslations("home.problem");
  const events = rawSubtree<Record<string, string>>(t, "timeline.events");

  return (
    <section
      id="autonomy"
      className="relative z-10 w-full border-y border-cream/[0.06] bg-cream/[0.015] py-24"
    >
      <div className="mx-auto max-w-7xl px-6">
        <div className="grid gap-16 lg:grid-cols-2 lg:items-center">
          <div>
            <p className="section-label">{t("eyebrow")}</p>
            <h2 className="mt-4 text-3xl font-light tracking-[-0.02em] text-cream sm:text-4xl lg:text-5xl">
              {t("headlineLine1")}
              <br />
              <span className="text-cream/45">{t("headlineLine2")}</span>
            </h2>

            <p className="mt-6 max-w-xl text-base leading-[1.7] text-cream/55">
              {t("bodyTop")}
            </p>

            <div className="mt-6 border-l border-sodium/50 pl-6">
              <p className="text-base leading-[1.7] text-cream/80 sm:text-lg sm:leading-[1.6]">
                {t.rich("bodyMiddle", {
                  emphasis: (chunks) => (
                    <em className="not-italic text-sodium">{chunks}</em>
                  ),
                })}
              </p>
            </div>

            <p className="mt-6 text-sm leading-[1.7] text-cream/40">
              {t("bodyBottom")}
            </p>
          </div>

          {/* Right: overnight timeline */}
          <div className="relative">
            <div className="absolute -inset-4 bg-[radial-gradient(ellipse_at_top_right,rgba(240,166,90,0.06),transparent_70%)] blur-2xl" />
            <div className="relative rounded-xl border border-cream/[0.06] bg-ink-1 p-6 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.7)]">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-cream/40">
                  {t("timeline.heading")}
                </p>
                <span className="font-mono text-[11px] text-cream/35">
                  {t("timeline.branchLabel")}
                </span>
              </div>

              <div className="mt-5 space-y-3">
                {TIMELINE.map((item, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="flex flex-col items-center">
                      <div
                        className={`mt-1 h-2 w-2 rounded-full ${
                          item.agent ? "bg-sodium" : "bg-cream/25"
                        }`}
                      />
                      {i < TIMELINE.length - 1 && (
                        <div className="mt-1 h-8 w-px bg-cream/[0.08]" />
                      )}
                    </div>
                    <div className="flex-1 pb-1">
                      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-cream/30">
                        {item.time}
                      </p>
                      <p
                        className={`mt-0.5 text-sm ${
                          item.agent ? "text-cream/85" : "text-cream/55"
                        }`}
                      >
                        {events[item.eventKey]}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
