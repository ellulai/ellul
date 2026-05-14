// Docs MDX shortcodes. Re-exports the shared marketing set from
// @ellul.ai/marketing-mdx so apps/docs and apps/web render the same Callout,
// CodeTabs, Image, PricingTable, and FAQ. Adds docs-specific surfaces
// (Steps/LockCard/ComparisonTable) that don't have parity in marketing.
//
// Callout has a type-driven dispatch: legacy docs MDX using
// <Callout type="principle"|"danger"|"success"> renders the docs-specific
// <DocsCallout>; the shared marketing types ("note"|"tip"|"warning") render
// the new shared Callout. This lets us migrate without touching existing MDX.

import type { ReactNode } from "react";
import {
  Callout as SharedCallout,
  type CalloutProps as SharedCalloutProps,
  CodeTabs,
  CodeTab,
  Image,
  PricingTable,
  FAQ,
} from "@ellul.ai/marketing-mdx";
import { DocsCallout } from "./callout";

export { LockCard } from "./lock-card";
export { FaqItem, FaqSection } from "./faq";
export { ComparisonTable } from "./comparison";
export { Step, Steps } from "./steps";
export { DocsCallout, CodeTabs, CodeTab, Image, PricingTable, FAQ };

type DocsCalloutType = "principle" | "warning" | "success" | "danger";
type SharedCalloutType = "note" | "warning" | "tip";

interface UnifiedCalloutProps {
  type?: DocsCalloutType | SharedCalloutType;
  title?: string;
  children: ReactNode;
}

const DOCS_TYPES = new Set<DocsCalloutType>([
  "principle",
  "success",
  "danger",
]);

/**
 * Unified Callout. Routes legacy docs types ("principle" | "success" |
 * "danger") to the docs-specific renderer; routes shared marketing types
 * ("note" | "tip") and unspecified to the shared renderer.
 *
 * "warning" exists in both sets — defaults to the shared renderer because
 * its visual treatment is consistent across surfaces.
 */
export function Callout({ type, title, children }: UnifiedCalloutProps) {
  if (type && DOCS_TYPES.has(type as DocsCalloutType)) {
    return (
      <DocsCallout type={type as DocsCalloutType} title={title}>
        {children}
      </DocsCallout>
    );
  }
  return (
    <SharedCallout type={(type as SharedCalloutProps["type"]) ?? "note"} title={title}>
      {children}
    </SharedCallout>
  );
}
