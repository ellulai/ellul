// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/* ─── Tier data ─── */
export interface TierSpec {
  id: string;
  name: string;
  price: number;
  description: string;
  capacity: string;
  /** Hardware specs — the real diff between tiers */
  specs?: {
    ram: string;
    cpu: string;
    disk: string;
    transfer: string;
  };
  /** Feature bullet list shown below specs */
  features?: string[];
  recommended?: boolean;
  /** Grayed out / coming soon */
  comingSoon?: boolean;
}

/* ─── Cloud Platform tiers ─── */
export const PLATFORM_TIERS: TierSpec[] = [
  {
    id: "cloud_platform:hobby",
    name: "Hobby",
    price: 20,
    description: "An always-on workstation for side projects.",
    capacity: "2 sandboxes",
    specs: {
      ram: "4 GB",
      cpu: "2 vCPU",
      disk: "40 GB SSD",
      transfer: "2 TB",
    },
    features: [
      "FIDO2 authentication",
      "Per-project sandboxing",
      "PostgreSQL database",
      "Deploy previews",
    ],
  },
  {
    id: "cloud_platform:pro",
    name: "Pro",
    price: 50,
    description: "Your daily driver. Parallel sandboxes for production work.",
    capacity: "5 sandboxes",
    recommended: true,
    specs: {
      ram: "8 GB",
      cpu: "4 vCPU",
      disk: "80 GB SSD",
      transfer: "3 TB",
    },
    features: [
      "FIDO2 authentication",
      "Per-project sandboxing",
      "PostgreSQL database",
      "Deploy previews",
      "gBrain persistent memory",
    ],
  },
];

/* ─── Shield Proxy tiers ─── */
export const CLI_SHIELD_TIERS: TierSpec[] = [
  {
    id: "shield_proxy",
    name: "Shield Gateway",
    price: 10,
    description: "FIDO2-gated proxy for existing agent frameworks. No SDK, no code changes.",
    capacity: "Unlimited projects",
    recommended: true,
  },
];

/* ─── TierCard ─── */
export type TierBadge = "current" | "recommended" | "scheduled";

/** Localizable labels rendered inside a TierCard. Defaults to English. */
export interface TierCardLabels {
  /** Badge labels per badge type. Defaults: "Current Plan" / "Most Popular" / "Scheduled". */
  badge?: Partial<Record<TierBadge, string>>;
  /** Spec row labels. Defaults: RAM / CPU / Disk / Transfer. */
  specs?: Partial<Record<keyof NonNullable<TierSpec["specs"]>, string>>;
  /** Per-month suffix shown next to the price. Defaults: "/mo". */
  perMonth?: string;
  /** Default CTA when no `ctaLabel` and no `href`. Defaults: "Select Plan". */
  selectPlan?: string;
  /** CTA when `href` is set and no `ctaLabel` override. Defaults: "Get Started". */
  getStarted?: string;
  /** CTA when `tier.comingSoon` is true. Defaults: "Coming Soon". */
  comingSoon?: string;
  /** Badge shown next to Pro-exclusive features. Defaults: "Pro only". */
  proOnly?: string;
}

export interface TierCardProps {
  tier: TierSpec;
  href?: string;
  onClick?: () => void;
  ctaLabel?: string;
  className?: string;
  /** Overrides the implicit `tier.recommended` badge. */
  badge?: TierBadge | null;
  /** Adds a selection ring (server-creation flow). */
  selected?: boolean;
  /** Dims and disables interaction. */
  disabled?: boolean;
  /** Hide the CTA — used when the card represents the current plan. */
  hideCta?: boolean;
  /** Localized label overrides. Anything omitted falls back to English. */
  labels?: TierCardLabels;
}

const BADGE_STYLE: Record<TierBadge, { bg: string; text: string }> = {
  current:     { bg: "bg-[#F5EFE6]/15", text: "text-[#F5EFE6]" },
  recommended: { bg: "bg-[#F0A65A]",    text: "text-[#0B0B0F]" },
  scheduled:   { bg: "bg-[#F0A65A]/20", text: "text-[#F0A65A]" },
};

const DEFAULT_BADGE_LABEL: Record<TierBadge, string> = {
  current:     "Current Plan",
  recommended: "Most Popular",
  scheduled:   "Scheduled",
};

const DEFAULT_SPEC_LABEL = {
  ram:      "RAM",
  cpu:      "CPU",
  disk:     "Disk",
  transfer: "Transfer",
} as const;

const DEFAULT_PER_MONTH    = "/mo";
const DEFAULT_SELECT_PLAN  = "Select Plan";
const DEFAULT_GET_STARTED  = "Get Started";
const DEFAULT_COMING_SOON  = "Coming Soon";
const DEFAULT_PRO_ONLY     = "Pro only";

export function TierCard({
  tier, href, onClick, ctaLabel, className,
  badge, selected, disabled, hideCta, labels,
}: TierCardProps) {
  const isButton = !!onClick;
  const isComingSoon = tier.comingSoon;
  const resolvedBadge: TierBadge | null = isComingSoon
    ? null
    : badge ?? (tier.recommended ? "recommended" : null);
  const isHighlight = resolvedBadge === "recommended" || resolvedBadge === "current";
  const ctaHighlight = selected !== undefined ? !selected : isHighlight;

  const badgeLabel = (b: TierBadge) =>
    labels?.badge?.[b] ?? DEFAULT_BADGE_LABEL[b];
  const specLabel = (k: keyof typeof DEFAULT_SPEC_LABEL) =>
    labels?.specs?.[k] ?? DEFAULT_SPEC_LABEL[k];
  const perMonth   = labels?.perMonth   ?? DEFAULT_PER_MONTH;
  const selectPlan = labels?.selectPlan ?? DEFAULT_SELECT_PLAN;
  const getStarted = labels?.getStarted ?? DEFAULT_GET_STARTED;
  const comingSoon = labels?.comingSoon ?? DEFAULT_COMING_SOON;
  const proOnly    = labels?.proOnly   ?? DEFAULT_PRO_ONLY;

  const label = isComingSoon
    ? comingSoon
    : ctaLabel ?? (href ? getStarted : selectPlan);

  const cardBase = "relative flex flex-col rounded-2xl border px-6 py-7 transition-all";
  const cardInteraction = isComingSoon || disabled
    ? "opacity-60 cursor-default"
    : isButton ? "text-left hover:-translate-y-0.5" : "hover:-translate-y-1";
  const cardTheme = isHighlight && !isComingSoon
    ? `border-[#F0A65A]/40 bg-[#13131A] shadow-[0_30px_60px_-30px_rgba(240,166,90,0.25)]${!isButton ? " lg:-translate-y-1.5 lg:hover:-translate-y-2.5" : ""}`
    : "border-[#F5EFE6]/[0.08] hover:border-[#F5EFE6]/[0.14] bg-[#13131A]";
  const selectedRing = selected ? " ring-2 ring-[#F0A65A] ring-offset-2 ring-offset-[#0B0B0F]" : "";
  const cardClasses = `${cardBase} ${cardInteraction} ${cardTheme}${selectedRing} ${className ?? ""}`;

  const ctaBase = "mt-auto pt-2 w-full rounded-xl py-2.5 text-center text-xs font-semibold uppercase tracking-[0.16em] transition-all";
  const ctaTheme = isComingSoon
    ? "border border-[#F5EFE6]/[0.06] bg-[#F5EFE6]/[0.02] text-[#F5EFE6]/30 cursor-default"
    : ctaHighlight
      ? `bg-[#F0A65A] text-[#0B0B0F]${href ? " hover:bg-[#F4B873]" : ""}`
      : `border border-[#F5EFE6]/[0.1] bg-[#F5EFE6]/[0.03] text-[#F5EFE6]/85${href ? " hover:bg-[#F5EFE6]/[0.06] hover:text-[#F5EFE6]" : ""}`;

  const inner = (
    <>
      {resolvedBadge && (
        <div className={`absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] ${BADGE_STYLE[resolvedBadge].bg} ${BADGE_STYLE[resolvedBadge].text}`}>
          {badgeLabel(resolvedBadge)}
        </div>
      )}

      <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#F0A65A]/85">
        {tier.name}
      </h3>
      <div className="mt-2 flex items-baseline gap-1">
        <span className="text-4xl font-bold text-[#F5EFE6]">
          ${tier.price}
        </span>
        <span className="text-sm font-medium text-[#F5EFE6]/40">{perMonth}</span>
      </div>

      <p className="mt-2 text-[13px] leading-relaxed text-[#F5EFE6]/55">
        {tier.description}
      </p>

      <span className="mt-3 inline-block rounded-full border border-[#F5EFE6]/[0.08] bg-[#F5EFE6]/[0.04] px-2.5 py-0.5 text-[11px] font-medium text-[#F5EFE6]/85">
        {tier.capacity}
      </span>

      {tier.specs && (
        <dl className={`mt-4 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px]${!tier.features?.length ? " mb-6" : ""}`}>
          <dt className="text-[#F5EFE6]/45">{specLabel("ram")}</dt>
          <dd className="text-right font-medium text-[#F5EFE6]/85">{tier.specs.ram}</dd>
          <dt className="text-[#F5EFE6]/45">{specLabel("cpu")}</dt>
          <dd className="text-right font-medium text-[#F5EFE6]/85">{tier.specs.cpu}</dd>
          <dt className="text-[#F5EFE6]/45">{specLabel("disk")}</dt>
          <dd className="text-right font-medium text-[#F5EFE6]/85">{tier.specs.disk}</dd>
          <dt className="text-[#F5EFE6]/45">{specLabel("transfer")}</dt>
          <dd className="text-right font-medium text-[#F5EFE6]/85">{tier.specs.transfer}</dd>
        </dl>
      )}

      {tier.features && tier.features.length > 0 && (
        <ul className="mt-4 mb-6 space-y-1.5 text-[12px]">
          {tier.features.map((feature) => {
            const isGbrain = feature.toLowerCase().includes("gbrain");
            return (
              <li key={feature} className="flex items-center gap-2 text-[#F5EFE6]/75">
                <svg className="h-3.5 w-3.5 shrink-0 text-[#F0A65A]/70" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM7.25 10.75 4.75 8.25l1-1 1.5 1.5 3.5-3.5 1 1-4.5 4.5Z" />
                </svg>
                <span>{feature}</span>
                {isGbrain && (
                  <span className="rounded-full bg-[#F0A65A]/15 px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-[#F0A65A]">
                    {proOnly}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {hideCta ? null : isComingSoon ? (
        <div className={`${ctaBase} ${ctaTheme}`}>
          {label}
        </div>
      ) : href ? (
        <a href={href} className={`block ${ctaBase} ${ctaTheme}`}>
          {label}
        </a>
      ) : (
        <div className={`${ctaBase} ${ctaTheme}`}>
          {label}
        </div>
      )}
    </>
  );

  if (isButton && !isComingSoon && !disabled) {
    return (
      <button type="button" onClick={onClick} className={cardClasses}>
        {inner}
      </button>
    );
  }

  return (
    <div className={cardClasses}>
      {inner}
    </div>
  );
}

/**
 * Keys this helper reads from a `tier`-scoped translator. Declared as a
 * narrow union so any `t` function whose parameter is a SUPERSET of this
 * union (e.g. next-intl's typed `t` for the `tier` namespace) is
 * assignable by contravariance.
 */
export type TierLabelsMessageKey =
  | "badge.current"
  | "badge.recommended"
  | "badge.scheduled"
  | "specs.ram"
  | "specs.cpu"
  | "specs.disk"
  | "specs.transfer"
  | "perMonth"
  | "cta.selectPlan"
  | "cta.getStarted"
  | "cta.comingSoon"
  | "proOnly";

/**
 * Builds a `TierCardLabels` object from a next-intl / use-intl `t` function
 * scoped to the `tier` namespace. Lets surfaces hand off tier localization
 * in one line:
 *
 *   const tTier = useTranslations("tier");
 *   <TierGrid labels={tierLabelsFromT(tTier)} … />
 *
 * The `t` shape matches both server (`getTranslations`) and client
 * (`useTranslations`) return values from next-intl/use-intl.
 */
export function tierLabelsFromT(
  t: (key: TierLabelsMessageKey) => string,
): TierCardLabels {
  return {
    badge: {
      current:     t("badge.current"),
      recommended: t("badge.recommended"),
      scheduled:   t("badge.scheduled"),
    },
    specs: {
      ram:      t("specs.ram"),
      cpu:      t("specs.cpu"),
      disk:     t("specs.disk"),
      transfer: t("specs.transfer"),
    },
    perMonth:   t("perMonth"),
    selectPlan: t("cta.selectPlan"),
    getStarted: t("cta.getStarted"),
    comingSoon: t("cta.comingSoon"),
    proOnly:    t("proOnly"),
  };
}

/** Keys read by `localizeTiers` — tier data (name, description, capacity, features). */
export type TierDataMessageKey =
  | "hobby.name"
  | "hobby.description"
  | "hobby.capacity"
  | "hobby.features.fido2"
  | "hobby.features.sandboxing"
  | "hobby.features.postgres"
  | "hobby.features.deploy"
  | "pro.name"
  | "pro.description"
  | "pro.capacity"
  | "pro.features.fido2"
  | "pro.features.sandboxing"
  | "pro.features.postgres"
  | "pro.features.deploy"
  | "pro.features.gbrain"
  | "shieldGateway.name"
  | "shieldGateway.description"
  | "shieldGateway.capacity";

const TIER_ID_TO_KEY: Record<string, string> = {
  "cloud_platform:hobby": "hobby",
  "cloud_platform:pro":   "pro",
  "shield_proxy":         "shieldGateway",
};

const TIER_FEATURE_KEYS: Record<string, string[]> = {
  "cloud_platform:hobby": ["fido2", "sandboxing", "postgres", "deploy"],
  "cloud_platform:pro":   ["fido2", "sandboxing", "postgres", "deploy", "gbrain"],
};

/**
 * Returns a localized copy of a tier array. Replaces name, description,
 * and capacity with translated values from the `tier` message namespace.
 *
 *   const tTier = useTranslations("tier");
 *   const tiers = localizeTiers(PLATFORM_TIERS, tTier);
 */
export function localizeTiers(
  tiers: TierSpec[],
  t: (key: TierDataMessageKey) => string,
): TierSpec[] {
  return tiers.map((tier) => {
    const key = TIER_ID_TO_KEY[tier.id];
    if (!key) return tier;
    const featureKeys = TIER_FEATURE_KEYS[tier.id];
    return {
      ...tier,
      name:        t(`${key}.name` as TierDataMessageKey),
      description: t(`${key}.description` as TierDataMessageKey),
      capacity:    t(`${key}.capacity` as TierDataMessageKey),
      ...(featureKeys && {
        features: featureKeys.map((fk) => t(`${key}.features.${fk}` as TierDataMessageKey)),
      }),
    };
  });
}

/* ─── TierGrid ─── */
export interface TierGridProps {
  tiers?: TierSpec[];
  getHref?: (tier: TierSpec) => string | undefined;
  onSelect?: (tier: TierSpec) => void;
  getCtaLabel?: (tier: TierSpec) => string;
  getBadge?: (tier: TierSpec) => TierBadge | null | undefined;
  isSelected?: (tier: TierSpec) => boolean;
  isDisabled?: (tier: TierSpec) => boolean;
  hideCta?: (tier: TierSpec) => boolean;
  /** Localized label overrides applied to every TierCard rendered. */
  labels?: TierCardLabels;
}

export function TierGrid({
  tiers = PLATFORM_TIERS,
  getHref, onSelect, getCtaLabel, getBadge, isSelected, isDisabled, hideCta, labels,
}: TierGridProps) {
  const cols = tiers.length <= 2 ? "lg:grid-cols-2 lg:max-w-2xl" : "lg:grid-cols-3 lg:max-w-4xl";
  return (
    <div>
      <div className={`flex flex-col gap-5 pt-4 sm:grid sm:grid-cols-2 sm:gap-5 lg:pt-5 ${cols} lg:mx-auto`}>
        {tiers.map((tier) => (
          <TierCard
            key={tier.id}
            tier={tier}
            href={getHref?.(tier)}
            onClick={onSelect ? () => onSelect(tier) : undefined}
            ctaLabel={getCtaLabel?.(tier)}
            badge={getBadge?.(tier) ?? undefined}
            selected={isSelected?.(tier)}
            disabled={isDisabled?.(tier)}
            hideCta={hideCta?.(tier)}
            labels={labels}
            className="w-full"
          />
        ))}
      </div>
    </div>
  );
}
