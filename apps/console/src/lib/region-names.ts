// SPDX-License-Identifier: MIT

const REGION_KEYS = ["us-east", "us-west", "eu-central", "eu-north", "asia-pacific"] as const;

type RegionTranslator = (key: string) => string;

// Returns localized "Name (Detail)". Pass `t` from useTranslations("console.lib.regions")
// for proper localization; falls back to identifier when key is unknown or `t` is omitted.
export function getRegionDisplayName(
  regionId: string | null | undefined,
  t?: RegionTranslator,
): string {
  if (!regionId) return t ? t("fallback") : "—";
  if (!t) return regionId;
  if (!(REGION_KEYS as readonly string[]).includes(regionId)) return regionId;
  const name = t(`${regionId}.name`);
  const detail = t(`${regionId}.detail`);
  return `${name} (${detail})`;
}
