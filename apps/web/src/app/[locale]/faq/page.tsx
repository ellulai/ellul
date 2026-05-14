import type { Metadata } from "next";
import { setRequestLocale, getTranslations } from "next-intl/server";
import { rawSubtree } from "@ellul.ai/i18n";
import { Link } from "@/i18n/routing";
import type { Locale } from "@ellul.ai/i18n-consts";
import { pageMetadata } from "@/lib/page-metadata";
import { FaqList, faqSchemaFor, type FaqItem } from "../components/faq-list";

export const dynamic = "force-static";

const baseUrl = "https://ellul.ai";

const GROUP_ORDER = [
  "basics",
  "alwaysOn",
  "parallel",
  "passkey",
  "comparisons",
  "agents",
  "mcp",
  "account",
  "region",
  "pricing",
] as const;

type GroupKey = (typeof GROUP_ORDER)[number];

const ITEMS_BY_GROUP: Record<GroupKey, readonly string[]> = {
  basics: ["agentWorkstation", "whyNotLaptop", "replaceCursor", "whatItDoes"],
  alwaysOn: ["howLong", "crashOvernight", "checkProgress"],
  parallel: ["howWork", "sameCodebase", "enforcement"],
  passkey: ["meaning", "credLeak", "losePasskey", "disable"],
  comparisons: [
    "codespaces",
    "sprites",
    "e2b",
    "daytona",
    "replit",
    "devin",
    "bolt",
    "manus",
    "windsurf",
  ],
  agents: ["which", "byok", "claudePro", "otherAgent", "localModels"],
  mcp: ["support", "preBuilt", "need", "credLeak"],
  account: ["migrate", "refund", "cancelData", "recovery", "export"],
  region: ["otherLanguages", "whatRegion", "sovereignty"],
  pricing: ["cost", "enterprise", "deployWhere", "usageLimits"],
};

function localizedFaqUrl(locale: Locale): string {
  return locale === "en" ? `${baseUrl}/faq` : `${baseUrl}/${locale}/faq`;
}

function localizedHomeUrl(locale: Locale): string {
  return locale === "en" ? baseUrl : `${baseUrl}/${locale}`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "faq.meta" });
  return pageMetadata({
    locale: locale as Locale,
    path: "/faq",
    title: t("title"),
    description: t("description"),
    ogType: "article",
  });
}

export default async function FaqPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale: rawLocale } = await params;
  const locale = rawLocale as Locale;
  setRequestLocale(locale);

  const t = await getTranslations("faq");

  const groups: Array<{ key: GroupKey; heading: string; items: FaqItem[] }> = GROUP_ORDER.map((groupKey) => {
    const items = rawSubtree<Record<string, FaqItem>>(t, `groups.${groupKey}.items`);
    return {
      key: groupKey,
      heading: t(`groups.${groupKey}.heading`),
      items: ITEMS_BY_GROUP[groupKey].map((itemKey) => items[itemKey] as FaqItem),
    };
  });

  const allItems: FaqItem[] = groups.flatMap((g) => g.items);
  const faqSchema = faqSchemaFor(allItems);

  const breadcrumbSchema = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: t("breadcrumb.home"), item: localizedHomeUrl(locale) },
      { "@type": "ListItem", position: 2, name: t("breadcrumb.faq"), item: localizedFaqUrl(locale) },
    ],
  };

  return (
    <main className="flex flex-col items-center px-6">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />

      <section className="relative z-10 flex flex-col items-center pt-12 pb-8 sm:pt-16">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-sodium/80">
          {t("page.eyebrow")}
        </p>
        <h1 className="mt-4 text-center text-[2.5rem] font-extralight leading-[1.05] tracking-[-0.03em] text-cream sm:text-[3rem] sm:tracking-[-0.035em] md:text-[3.5rem]">
          {t("page.headline")}
        </h1>
        <p className="mt-5 max-w-2xl text-center text-base leading-[1.7] text-cream/55 sm:text-lg">
          {t("page.subhead")}
        </p>
      </section>

      <section className="relative z-10 w-full max-w-3xl pb-16">
        {groups.map((group) => (
          <div key={group.key} className="mb-10">
            <h2 className="mb-4 text-[11px] font-medium uppercase tracking-[0.22em] text-cream/45">
              {group.heading}
            </h2>
            <FaqList items={group.items} />
          </div>
        ))}
      </section>

      <section className="relative z-10 flex flex-col items-center pb-20 text-center">
        <h2 className="text-2xl font-light tracking-[-0.02em] text-cream sm:text-3xl">
          {t("outro.heading")}
        </h2>
        <p className="mt-3 max-w-md text-sm leading-[1.7] text-cream/55">
          {t("outro.subhead")}
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/pricing"
            className="rounded-md bg-sodium px-6 py-3 text-sm font-semibold text-ink transition hover:bg-sodium-strong"
          >
            {t("outro.ctaPricing")}
          </Link>
          <a
            href="https://docs.ellul.ai"
            className="rounded-md border border-cream/[0.12] px-6 py-3 text-sm font-medium text-cream/75 transition hover:border-cream/30 hover:text-cream"
          >
            {t("outro.ctaDocs")}
          </a>
        </div>
      </section>
    </main>
  );
}
