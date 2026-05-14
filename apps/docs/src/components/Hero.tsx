import Link from "next/link";
import { useTranslations } from "next-intl";

interface BadgeProps {
  variant: "secure" | "beta";
  children: React.ReactNode;
}

function Badge({ variant, children }: BadgeProps) {
  const styles = {
    secure:
      "bg-[#13131A] text-cream border border-[rgba(245, 239, 230, 0.07)] shadow-panel-lift",
    beta:
      "bg-[#13131A] text-sodium border border-[rgba(245, 239, 230, 0.07)] shadow-panel-lift",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider ${styles[variant]}`}
    >
      {children}
    </span>
  );
}

export { Badge };

export function Hero() {
  const t = useTranslations("docs.hero");
  return (
    <section className="relative flex flex-col items-center justify-center px-4 py-16 text-center sm:px-8 sm:py-24">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div
          className="absolute -top-1/4 -left-1/4 h-[400px] w-[400px] rounded-full opacity-20 sm:h-[600px] sm:w-[600px]"
          style={{
            background: "radial-gradient(circle, rgba(245,239,230,0.6) 0%, transparent 70%)",
            animation: "ambient-float 30s ease-in-out infinite",
          }}
        />
        <div
          className="absolute -bottom-1/4 -right-1/4 h-[350px] w-[350px] rounded-full opacity-15 sm:h-[500px] sm:w-[500px]"
          style={{
            background: "radial-gradient(circle, rgba(240,166,90,0.4) 0%, transparent 70%)",
            animation: "ambient-float 40s ease-in-out infinite reverse",
          }}
        />
      </div>

      <div className="relative z-10">
        <div className="mb-6 flex flex-wrap justify-center gap-2">
          <Badge variant="secure">{t("badgeAlwaysOn")}</Badge>
          <Badge variant="beta">{t("badgeDocs")}</Badge>
        </div>

        <h1 className="mx-auto max-w-3xl text-[2.25rem] font-extralight leading-[1.02] tracking-[-0.03em] text-cream sm:text-[2.75rem] sm:tracking-[-0.035em] md:text-[3.5rem] lg:text-[4rem] lg:tracking-[-0.04em]">
          {t("headlineLine1")}
          <br />
          <span className="text-sodium">{t("headlineLine2")}</span>
        </h1>

        <p className="mx-auto mt-6 max-w-xl text-sm leading-[1.7] text-cream/55 sm:mt-7 sm:text-base sm:leading-[1.65] lg:text-lg">
          {t("subhead")}
        </p>

        <div className="mt-8 flex flex-wrap justify-center gap-3 sm:mt-10">
          <Link
            href="/getting-started/welcome"
            className="rounded-xl bg-sodium px-6 py-2.5 text-sm font-semibold text-ink shadow-panel-lift transition-all"
          >
            {t("ctaPrimary")}
          </Link>
          <Link
            href="https://console.ellul.ai/sign-up"
            className="rounded-xl border border-cream/[0.08] bg-cream/[0.03] px-6 py-2.5 text-sm font-semibold text-cream/75 backdrop-blur-sm transition-all hover:bg-cream/[0.06] hover:text-cream"
          >
            {t("ctaSecondary")}
          </Link>
        </div>
      </div>
    </section>
  );
}
