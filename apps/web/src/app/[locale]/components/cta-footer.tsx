import { getTranslations } from "next-intl/server";

const CONSOLE_URL = process.env.NEXT_PUBLIC_CONSOLE_URL!;

export default async function CtaFooter() {
  const t = await getTranslations("home.cta");

  return (
    <section id="cta" className="relative z-10 w-full border-t border-cream/[0.06] py-32">
      <div className="mx-auto max-w-7xl px-6 text-center">
        <h2 className="mx-auto max-w-3xl text-[2.75rem] font-extralight leading-[1.02] tracking-[-0.03em] text-cream sm:text-[3rem] sm:tracking-[-0.035em] md:text-[3.5rem] lg:text-[4rem] lg:tracking-[-0.04em]">
          {t("headlineLine1")}
          <br />
          <span className="text-sodium">{t("headlineLine2")}</span>
        </h2>

        <p className="mx-auto mt-7 max-w-[44ch] text-base leading-[1.7] text-cream/55 sm:text-lg sm:leading-[1.65]">
          {t("subhead")}
        </p>

        <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
          <a
            href={`${CONSOLE_URL}/sign-up`}
            className="rounded-md bg-sodium px-7 py-3.5 text-sm font-semibold text-ink transition hover:bg-sodium-strong"
          >
            {t("primary")}
          </a>
          <a
            href="#pricing"
            className="rounded-md border border-cream/[0.08] bg-cream/[0.03] px-7 py-3.5 text-sm font-medium text-cream/80 transition hover:border-cream/[0.16] hover:text-cream"
          >
            {t("secondary")}
          </a>
        </div>
      </div>
    </section>
  );
}
