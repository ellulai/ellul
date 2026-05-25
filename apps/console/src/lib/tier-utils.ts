// SPDX-License-Identifier: MIT

import { isContextVisible } from "./feature-flags";

// - shield_proxy:     Settings only (secrets + security)

export type Product = "cloud_platform" | "shield_proxy" | "self_hosted" | "byos";

// Get which product a tier/product string belongs to
export function getProductForTier(productOrTier?: string): Product {
  if (!productOrTier) return "cloud_platform";
  // New model: product is the value directly (e.g. "cloud_platform")
  if (["cloud_platform", "shield_proxy", "self_hosted", "byos"].includes(productOrTier)) {
    return productOrTier as Product;
  }
  // Composite key: "cloud_platform:hobby" → extract product
  const prefix = productOrTier.split(":")[0] ?? productOrTier;
  if (["cloud_platform", "shield_proxy", "self_hosted", "byos"].includes(prefix)) {
    return prefix as Product;
  }
  return "cloud_platform";
}

// ── Security tier helpers ──

// Whether a security tier requires passkey authentication (web_locked or private_locked).
export function isLockedTier(tier: string | null | undefined): boolean {
  return tier === "web_locked" || tier === "private_locked";
}

// ── Legacy helpers (used throughout console, kept for compatibility) ──

// Check if serverPlan (or composite key) represents the free tier
export function isFreeTier(planOrKey?: string): boolean {
  if (!planOrKey) return false;
  return planOrKey === "free" || planOrKey.endsWith(":free");
}

export function isShieldProxyTier(productOrKey?: string): boolean {
  if (!productOrKey) return false;
  return productOrKey === "shield_proxy" || productOrKey.startsWith("shield_proxy:");
}

export function isPaidTier(planOrKey?: string): boolean {
  if (!planOrKey) return false;
  return planOrKey === "pro" || planOrKey.endsWith(":pro");
}

// Products that hibernate when idle (free plan or non-platform products)
export function isHibernatingTier(planOrProduct?: string): boolean {
  if (!planOrProduct) return false;
  // Free plan always hibernates
  if (planOrProduct === "free" || planOrProduct.endsWith(":free")) return true;
  // Shield proxy always hibernates
  if (planOrProduct === "shield_proxy" || planOrProduct.startsWith("shield_proxy:")) return true;
  return false;
}

// ── Product-based feature visibility ──

// Context visibility by product.
export function canShowContext(
  contextId: string,
  product: Product,
): boolean {
  if (contextId === "deployed") return false;
  if (!isContextVisible(contextId)) return false;
  if (product === "shield_proxy") return contextId === "settings";
  return true; // cloud_platform: all contexts except deployed
}

// shield_proxy:     secrets + security only
export function canShowSettingsTab(
  tabId: string,
  product: Product,
): boolean {
  if (product === "shield_proxy")
    return tabId === "security" || tabId === "secrets";
  return true;
}

// Server settings modal tab visibility by product.
export function canShowServerSettingsTab(
  tabId: string,
  product: Product,
): boolean {
  const isLocal = product === "self_hosted" || product === "byos";
  if (tabId === "general") return true;
  if (tabId === "ai") return product === "cloud_platform" || isLocal;
  if (tabId === "billing") return !isLocal;
  if (tabId === "context") return !isLocal;
  if (tabId === "appearance") return product !== "shield_proxy" && !isLocal;
  if (tabId === "domains") return product === "cloud_platform";
  return true;
}

// ── Runtime tier display ──

export const RUNTIME_TIER_DISPLAY = {
  shared: {
    label: "Shared Runtime",
    description: "Persistent instance on shared hardware",
  },
} as const;

export const PLAN_LABEL = {
  hobby: "Hobby",
  pro: "Pro",
} as const;

export function getRuntimeTierLabel(_rt?: string): string {
  return "Shared Runtime";
}

export function getPlanLabel(plan?: string): string {
  return PLAN_LABEL[plan as keyof typeof PLAN_LABEL] ?? "Hobby";
}

export function isDedicatedRuntime(_rt?: string): boolean {
  return false;
}

// Extract the plan name from a composite tier ID (e.g. "cloud_platform:pro" → "pro")
export function extractPlan(tierId: string): string {
  return tierId.includes(":") ? tierId.split(":")[1]! : tierId;
}
