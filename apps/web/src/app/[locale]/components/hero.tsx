import { getTranslations } from "next-intl/server";
import { rawSubtree } from "@ellul.ai/i18n";
import { ClaudeLogo, GrokLogo, OpenAILogo, CursorLogo, OpenCodeLogo } from "./ai-logos";

const CONSOLE_URL = process.env.NEXT_PUBLIC_CONSOLE_URL!;

// Brand names per packages/i18n-messages/scripts/glossary.json — they stay
// literal English across every locale. Do NOT translate / katakanize.
const AGENTS = [
  { Logo: ClaudeLogo, label: "Claude Code" },
  { Logo: OpenAILogo, label: "Codex" },
  { Logo: CursorLogo, label: "Cursor" },
  { Logo: OpenCodeLogo, label: "OpenCode" },
  { Logo: GrokLogo, label: "Grok Build" },
];

type NightLogRow = {
  time: string;
  agentKey: "checkout" | "docs" | "ellul";
  lineKey: string;
  highlight?: boolean;
};

// 24-hour HH:MM timestamps. Code-shaped values per translate-prompt.md rule 6
// — stay literal across locales. Agent labels (`checkout`, `docs`, `ellul`)
// resolve via `agentLabels[row.agentKey]` against the translated namespace.
const NIGHT_LOG_LAYOUT: readonly NightLogRow[] = [
  { time: "23:42", agentKey: "checkout", lineKey: "branchStart" },
  { time: "23:51", agentKey: "checkout", lineKey: "wroteTests" },
  { time: "01:18", agentKey: "checkout", lineKey: "addedIdempotency" },
  { time: "01:54", agentKey: "checkout", lineKey: "testsGreen" },
  { time: "02:33", agentKey: "docs", lineKey: "regenSchema" },
  { time: "03:04", agentKey: "checkout", lineKey: "gitPush" },
  { time: "03:14", agentKey: "checkout", lineKey: "openedPr", highlight: true },
  { time: "06:51", agentKey: "ellul", lineKey: "waiting" },
];

export default async function Hero() {
  const t = await getTranslations("home.hero");
  const entries = rawSubtree<Record<string, string>>(t, "nightLog.entries");
  const agentLabels = rawSubtree<Record<string, string>>(t, "nightLog.agentLabels");

  return (
    <section
      id="hero"
      className="relative z-10 mx-auto flex min-h-[calc(100vh-4rem)] max-w-7xl items-center px-4 py-12 sm:px-6 sm:py-16"
    >
      <div className="grid w-full items-center gap-10 sm:gap-16 lg:grid-cols-[1.05fr_1fr]">
        {/* Left: copy */}
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sodium/80">
            {t("eyebrow")}
          </p>

          <h1 className="mt-5 text-[2.75rem] font-extralight leading-[1.02] tracking-[-0.03em] text-cream sm:text-[3rem] sm:tracking-[-0.035em] md:text-[3.5rem] lg:text-[4rem] lg:tracking-[-0.04em]">
            {t("headlineLine1")}
            <br />
            <span className="text-sodium">{t("headlineLine2")}</span>
          </h1>

          <p className="mt-7 max-w-[44ch] text-base leading-[1.7] text-cream/55 sm:text-lg sm:leading-[1.65]">
            {t("subhead")}
          </p>

          <div className="mt-8">
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-cream/40">
              {t("bringAgent")}
            </p>
            <ul className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-3">
              {AGENTS.map(({ Logo, label }) => (
                <li key={label} className="flex items-center gap-2 text-cream/70">
                  <Logo aria-hidden colored className="h-5 w-5" />
                  <span className="text-[13px] font-medium">{label}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a
              href={`${CONSOLE_URL}/sign-up`}
              className="rounded-md bg-sodium px-7 py-3.5 text-sm font-semibold text-ink transition hover:bg-sodium-strong"
            >
              {t("ctaPrimary")}
            </a>
            <a
              href="#autonomy"
              className="group inline-flex items-center gap-2 px-2 py-3.5 text-sm font-medium text-cream/65 transition hover:text-cream"
            >
              {t("ctaSecondary")}
              <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                ↓
              </span>
            </a>
          </div>

          <div className="mt-10 grid max-w-md grid-cols-3 gap-px overflow-hidden rounded-lg bg-cream/[0.06] p-px">
            {[
              { v: t("stats.runValue"), l: t("stats.runLabel") },
              { v: t("stats.parallelValue"), l: t("stats.parallelLabel") },
              { v: t("stats.credsValue"), l: t("stats.credsLabel") },
            ].map((s) => (
              <div key={s.l} className="bg-ink px-3 py-3 sm:px-4">
                <p className="font-mono text-sm font-semibold text-cream sm:text-base">
                  {s.v}
                </p>
                <p className="mt-0.5 text-[9px] uppercase tracking-wider text-cream/40 sm:text-[10px]">
                  {s.l}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Right: night log */}
        <div className="relative">
          <div className="absolute -inset-6 bg-[radial-gradient(ellipse_at_top,rgba(240,166,90,0.08),transparent_70%)] blur-2xl" />

          <div className="relative mb-3 flex items-end justify-between">
            <p className="text-[11px] uppercase tracking-[0.22em] text-cream/40">
              {t("nightLog.eyebrow")}
            </p>
            <p className="font-mono text-[11px] text-cream/25">{t("nightLog.timestamp")}</p>
          </div>

          <div className="relative overflow-hidden rounded-2xl border border-cream/[0.08] bg-ink-1 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.7)]">
            <ol className="divide-y divide-cream/[0.04] font-mono text-[11px] leading-relaxed sm:text-[12.5px]">
              {NIGHT_LOG_LAYOUT.map((row, i) => (
                <li
                  key={i}
                  className={`flex items-baseline gap-2 px-4 py-2.5 sm:gap-3 sm:px-5 ${
                    row.highlight ? "bg-sodium-soft" : ""
                  }`}
                >
                  <span className="w-10 shrink-0 text-cream/30 sm:w-12">{row.time}</span>
                  <span className="w-14 shrink-0 truncate text-[10px] text-sodium/80 sm:w-16 sm:text-[11px]">
                    {agentLabels[row.agentKey]}
                  </span>
                  <span
                    className={`min-w-0 flex-1 break-words ${row.highlight ? "text-cream" : "text-cream/65"}`}
                  >
                    {entries[row.lineKey]}
                  </span>
                </li>
              ))}
            </ol>

            <div className="border-t border-cream/[0.06] bg-sodium-soft px-4 py-4 sm:px-5">
              <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold text-cream">
                    {t("nightLog.prTitle")}
                  </p>
                  <p className="mt-0.5 break-all font-mono text-[11px] text-cream/45">
                    {t("nightLog.prSub")}
                  </p>
                </div>
                <button
                  type="button"
                  className="shrink-0 rounded-md bg-sodium px-3.5 py-2 text-[12px] font-semibold text-ink"
                >
                  {t("nightLog.prCta")}
                </button>
              </div>
            </div>
          </div>

          <p className="relative mt-3 text-right font-mono text-[11px] text-cream/30">
            {t("nightLog.footnote")}
          </p>
        </div>
      </div>
    </section>
  );
}
