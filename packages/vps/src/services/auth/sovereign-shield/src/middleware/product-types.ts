/**
 * Leaf type module for the product/billing taxonomy. Lives separately from
 * product-gate.middleware so the engine modules can `import type` from here
 * without triggering a circular dependency through the gate's runtime imports.
 */

export type Product = 'cloud_platform' | 'cloud_sandbox' | 'shield_proxy' | 'byos';
export type BillingTier = 'free' | 'paid';
