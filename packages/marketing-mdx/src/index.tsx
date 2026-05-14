// Shared MDX shortcodes for the marketing surfaces (apps/web blog +
// use-cases, apps/docs). Adding a new shortcode here makes it available to
// every surface; surfaces compose this set with their own surface-specific
// shortcodes (e.g. apps/docs adds Steps + LockCard alongside).

export { Callout, type CalloutProps, type CalloutType } from "./Callout";
export {
  CodeTabs,
  CodeTab,
  type CodeTabsProps,
  type CodeTabProps,
} from "./CodeTabs";
export { Image, type ImageProps } from "./Image";
export {
  PricingTable,
  type PricingTableProps,
  type PricingTableRow,
} from "./PricingTable";
export { FAQ, type FAQItem, type FAQProps } from "./FAQ";

export const SHARED_MDX_SHORTCODES = [
  "Callout",
  "CodeTabs",
  "CodeTab",
  "Image",
  "PricingTable",
  "FAQ",
] as const;

export type SharedMdxShortcode = (typeof SHARED_MDX_SHORTCODES)[number];
