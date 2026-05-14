/**
 * Cross-package shared types for the product/tier taxonomy.
 *
 * Note: there are TWO separate Product taxonomies in the codebase that look
 * similar but address different layers — they are not drift, do not merge:
 *   - VPS-side (sovereign-shield middleware): cloud_platform | cloud_sandbox |
 *     shield_proxy — what the running VPS knows about itself.
 *   - API-side (apps/api/config/product-config): cloud_platform | shield_proxy
 *     — what the control plane provisions.
 *
 * If you need a Product type, import from the layer you live in, not from here.
 */

/**
 * The three security tiers that gate the runtime. Values must match exactly
 * the strings the VPS reads from /etc/ellul/tier and writes back via the
 * downgrade/promotion routes — DO NOT rename without coordinating a
 * heartbeat-protocol bump.
 */
export type SecurityTier = "standard" | "web_locked" | "private_locked";

/**
 * Server plan / billing tier. Lives here so console + api + tests share one
 * source. Source of truth for callers is the apps/api/config/runtime-rules
 * derivation, but the literal union is stable.
 */
export type ServerPlan = "free" | "hobby" | "pro";
