import { useTranslations } from "next-intl";

const TIER_KEYS = ["standard", "secure", "sovereign"] as const;
const CALLOUT_KEYS = ["wholesale", "lifecycle", "noTax"] as const;

export default function IsolationSpectrum() {
  const t = useTranslations("isolationSpectrum");
  return (
    <section id="isolation-spectrum" className="relative z-10 w-full py-24">
      <div className="mx-auto max-w-7xl px-6">
        <p className="section-label">{t("eyebrow")}</p>
        <h2 className="mt-4 text-3xl font-light tracking-[-0.02em] text-cream sm:text-4xl">
          {t("heading")}
        </h2>
        <p className="mt-4 max-w-2xl text-base leading-[1.7] text-cream/55">
          {t("intro")}
        </p>

        <div className="mt-10 overflow-x-auto rounded-xl border border-cream/[0.06]">
          <table className="data-table">
            <thead>
              <tr>
                <th>{t("headers.tier")}</th>
                <th>{t("headers.isolation")}</th>
                <th className="hidden sm:table-cell">{t("headers.useCase")}</th>
                <th>{t("headers.cost")}</th>
                <th>{t("headers.spinUp")}</th>
              </tr>
            </thead>
            <tbody>
              {TIER_KEYS.map((key) => (
                <tr key={key}>
                  <td className="font-medium text-cream/80 whitespace-nowrap">
                    {t(`tiers.${key}.name`)}
                  </td>
                  <td>{t(`tiers.${key}.isolation`)}</td>
                  <td className="hidden sm:table-cell">
                    {t(`tiers.${key}.useCase`)}
                  </td>
                  <td className="whitespace-nowrap">{t(`tiers.${key}.cost`)}</td>
                  <td className="whitespace-nowrap font-mono text-xs">
                    {t(`tiers.${key}.spinUp`)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          {CALLOUT_KEYS.map((key) => (
            <div key={key} className="flex gap-3">
              <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-sodium/60" />
              <div>
                <h3 className="text-sm font-semibold text-cream/80">
                  {t(`callouts.${key}.title`)}
                </h3>
                <p className="mt-1 text-sm text-cream/45">
                  {t(`callouts.${key}.desc`)}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
