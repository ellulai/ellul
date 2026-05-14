import { getTranslations } from "next-intl/server";
import { rawSubtree } from "@ellul.ai/i18n";

const ITEMS = [
  {
    key: "alwaysOn",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-6 w-6">
        <circle cx="12" cy="12" r="9" strokeLinecap="round" />
        <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: "previews",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-6 w-6">
        <rect x="3" y="4.5" width="18" height="13" rx="2" />
        <path d="M3 8h18M8 21h8" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "anywhere",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-6 w-6">
        <rect x="7" y="2.5" width="10" height="19" rx="2" />
        <path d="M11 18.5h2" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "integrations",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-6 w-6">
        <path d="M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1" strokeLinecap="round" />
        <path d="M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "passkey",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-6 w-6">
        <path d="M12 3l8 3v5c0 5-3.5 9-8 10-4.5-1-8-5-8-10V6l8-3z" strokeLinejoin="round" />
        <path d="m9 12 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    key: "composable",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="h-6 w-6">
        <circle cx="6" cy="7" r="2.5" />
        <circle cx="18" cy="7" r="2.5" />
        <circle cx="12" cy="17" r="2.5" />
        <path d="M7.5 9l3 6M16.5 9l-3 6" strokeLinecap="round" />
      </svg>
    ),
  },
] as const;

export default async function Highlights() {
  const t = await getTranslations("home.highlights");
  const items = rawSubtree<Record<string, { title: string; body: string }>>(t, "items");

  return (
    <section
      id="highlights"
      className="relative z-10 mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28"
    >
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

      <ul className="mt-14 grid gap-px overflow-hidden rounded-2xl bg-cream/[0.06] p-px sm:grid-cols-2 lg:grid-cols-3">
        {ITEMS.map((h) => (
          <li key={h.key} className="flex flex-col gap-3 bg-ink p-6 sm:p-7">
            <div className="text-sodium">{h.icon}</div>
            <h3 className="text-base font-semibold text-cream">{items[h.key]?.title}</h3>
            <p className="text-[13.5px] leading-[1.65] text-cream/55">{items[h.key]?.body}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
