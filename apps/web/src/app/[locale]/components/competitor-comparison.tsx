"use client";

import { useTranslations } from "next-intl";

export default function CompetitorComparison() {
  const t = useTranslations("comparisons");

  const rows = [
    {
      metric: t("metricIsolation"),
      daytona: t("isolationDaytona"),
      e2b: t("isolationE2b"),
      standard: t("isolationStandard"),
      sovereign: t("isolationSovereign"),
    },
    {
      metric: t("metricSideChannel"),
      daytona: t("sideChannelDaytona"),
      e2b: t("sideChannelE2b"),
      standard: t("sideChannelStandard"),
      sovereign: t("sideChannelSovereign"),
    },
    {
      metric: t("metricMonthlyCost"),
      daytona: t("costDaytona"),
      e2b: t("costE2b"),
      standard: t("costStandard"),
      sovereign: t("costSovereign"),
    },
    {
      metric: t("metricSpinUp"),
      daytona: t("spinUpDaytona"),
      e2b: t("spinUpE2b"),
      standard: t("spinUpStandard"),
      sovereign: t("spinUpSovereign"),
    },
  ];

  const mobileCompetitors = [
    { name: t("columnDaytona"), key: "daytona" as const },
    { name: t("columnE2b"), key: "e2b" as const },
    { name: t("columnEllulSovereign"), key: "sovereign" as const, highlight: true },
  ];

  return (
    <section id="comparison" className="relative z-10 w-full py-24">
      <div className="mx-auto max-w-7xl px-6">
        <h2 className="text-3xl font-light tracking-[-0.02em] text-cream sm:text-4xl">
          {t("heading")}
        </h2>

        {/* Desktop table */}
        <div className="mt-10 hidden overflow-x-auto rounded-xl border border-cream/[0.06] lg:block">
          <table className="data-table">
            <thead>
              <tr>
                <th></th>
                <th>{t("columnDaytona")}</th>
                <th>{t("columnE2b")}</th>
                <th className="bg-sodium/[0.03]">{t("columnEllulStandard")}</th>
                <th className="bg-sodium/[0.03]">{t("columnEllulSovereign")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.metric}>
                  <td className="font-medium text-cream/70 whitespace-nowrap">{r.metric}</td>
                  <td>{r.daytona}</td>
                  <td>{r.e2b}</td>
                  <td className="bg-sodium/[0.03]">{r.standard}</td>
                  <td className="bg-sodium/[0.03] font-medium text-cream/70">{r.sovereign}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile cards */}
        <div className="mt-10 grid gap-4 sm:grid-cols-3 lg:hidden">
          {mobileCompetitors.map((comp) => (
            <div
              key={comp.name}
              className={`rounded-xl border p-5 ${
                comp.highlight
                  ? "border-sodium/20 bg-sodium/[0.04]"
                  : "border-cream/[0.06] bg-cream/[0.02]"
              }`}
            >
              <h3 className={`text-sm font-semibold ${comp.highlight ? "text-sodium" : "text-cream/70"}`}>
                {comp.name}
              </h3>
              <div className="mt-3 space-y-2">
                {rows.map((r) => (
                  <div key={r.metric} className="flex justify-between gap-2">
                    <span className="text-xs text-cream/30">{r.metric}</span>
                    <span className="text-xs text-right text-cream/60">{r[comp.key]}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <p className="mt-8 text-sm text-cream/45">
          {t("migrationNote")}
        </p>
      </div>
    </section>
  );
}
