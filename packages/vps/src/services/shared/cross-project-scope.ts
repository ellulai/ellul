// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Cross-project scope-confusion denial. Shared snapshot .shared/<B>/ is source-code only;
// agent in A requesting gates "for" B's data is meaningless and socially risky. Defense in depth:
// L1 bridge structural, L2 bridge reason-enrichment, L3 shield authoritative, L4 agent prompt.
// Matches .shared/<slug>, /projects/<sbx-...>, bare sbx-xxxxxxx. Slug must be EXACT member of shared list.

import type { SandboxId } from '@ellul.ai/types';

// ── Feature flag ─────────────────────────────────────────────────────────

// ELLUL_CROSS_PROJECT_SCOPE_CHECK=0 disables; read at module load (restart required).
export const SCOPE_CHECK_ENABLED: boolean = (() => {
  const raw = (process.env.ELLUL_CROSS_PROJECT_SCOPE_CHECK ?? '').toLowerCase().trim();
  if (raw === '') return true;
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
})();

// ── Denial counter (in-memory monitoring) ────────────────────────────────

let _denialCount = 0;
let _lastDenialAt: number | null = null;

/** Layer label for audit + metrics separation. L1 bridge, L2 enrichment-matched, L3 shield. */
export type DenialLayer = 'bridge_tool_call' | 'shield_gate_request' | 'shield_auto_grant';

const _denialsByLayer: Record<DenialLayer, number> = {
  bridge_tool_call: 0,
  shield_gate_request: 0,
  shield_auto_grant: 0,
};

export function recordScopeConfusionDenial(layer: DenialLayer): void {
  _denialCount++;
  _lastDenialAt = Date.now();
  _denialsByLayer[layer]++;
}

export function getScopeConfusionDenialStats(): {
  count: number;
  lastDenialAt: number | null;
  enabled: boolean;
  byLayer: Record<DenialLayer, number>;
} {
  return {
    count: _denialCount,
    lastDenialAt: _lastDenialAt,
    enabled: SCOPE_CHECK_ENABLED,
    byLayer: { ..._denialsByLayer },
  };
}

// ── Sandbox-scoped capability set ────────────────────────────────────────

/**
 * Capabilities whose semantics are categorically bound to the *calling*
 * sandbox's own resources. When an agent invokes one of these with args
 * that reference `.shared/<B>/` or another sandbox's project path, the
 * call is nonsensical by construction — no gate grant in A's scope could
 * ever give access to B's data — and is structurally denied by the
 * bridge without ever reaching the gate-request path.
 *
 * Capabilities NOT in this set (filesystem, network, execution, financial)
 * may legitimately touch `.shared/*` paths (e.g. reading a file, grepping,
 * running a read-only analysis) so are not auto-denied here; for those,
 * reason-based scope confusion is still caught at the shield routes.
 */
const SANDBOX_SCOPED_CAPABILITIES: ReadonlySet<string> = new Set<string>([
  'database:read',
  'database:write',
  'database:migrate',
  'secrets:env_read',
  'secrets:env_inject',
  'secrets:vault_read',
  'deployment:git_read',
  'deployment:git_write',
  'deployment:deploy_trigger',
  'observability:logs_read',
  'observability:metrics_read',
]);

export function isSandboxScopedCapability(cap: string): boolean {
  return SANDBOX_SCOPED_CAPABILITIES.has(cap);
}

// ── Reason matcher ───────────────────────────────────────────────────────

export function matchScopeConfusionInReason(
  sharedSlugs: readonly SandboxId[],
  reason: string,
): { sharedSandbox: SandboxId; matchedToken: string } | null {
  if (!reason || sharedSlugs.length === 0) return null;

  // Pattern 1: `.shared/<slug>[/…]` relative path reference.
  const sharedPathMatch = reason.match(/\.shared\/([a-z0-9][a-z0-9._-]{0,63})/i);
  if (sharedPathMatch) {
    const slug = sharedPathMatch[1]!.toLowerCase();
    const hit = sharedSlugs.find((s) => s === slug);
    if (hit) return { sharedSandbox: hit, matchedToken: sharedPathMatch[0] };
  }

  // Pattern 2: `/projects/<sbx-xxxxxxx>[/…]` absolute path reference.
  const absPathMatch = reason.match(/\/projects\/(sbx-[a-z0-9]{7})(?=[/\s",;:)\]}]|$)/i);
  if (absPathMatch) {
    const slug = absPathMatch[1]!.toLowerCase() as SandboxId;
    const hit = sharedSlugs.find((s) => s === slug);
    if (hit) return { sharedSandbox: hit, matchedToken: absPathMatch[0] };
  }

  // Pattern 3: bare slug token with non-identifier boundaries.
  for (const slug of sharedSlugs) {
    const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(^|[^a-z0-9._-])${escaped}([^a-z0-9._-]|$)`, 'i');
    if (re.test(reason)) return { sharedSandbox: slug, matchedToken: slug };
  }

  return null;
}

// ── Tool-arg hint extraction ─────────────────────────────────────────────

/**
 * Walk an arbitrary serialisable value (typically MCP tool args) and
 * extract any substrings that look like cross-sandbox path references.
 *
 * Returns only the MATCHED substrings (cap: 5). Does NOT leak arbitrary
 * arg contents — if a tool arg contains a secret as a sibling field, we
 * never touch it. Extraction is purely regex-scoped to path patterns.
 */
export function extractSharedPathHintsFromJson(value: unknown): string[] {
  let str: string;
  try {
    str = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return [];
  }
  if (!str) return [];

  const hints = new Set<string>();

  for (const m of str.matchAll(/\.shared\/[a-z0-9][a-z0-9._-]{0,63}/gi)) {
    hints.add(m[0]);
    if (hints.size >= 5) break;
  }
  if (hints.size < 5) {
    for (const m of str.matchAll(/\/projects\/sbx-[a-z0-9]{7}(?=[/\s",;:)\]}]|$)/gi)) {
      hints.add(m[0]);
      if (hints.size >= 5) break;
    }
  }

  return Array.from(hints);
}

/**
 * Enrich a generic reason string with extracted path hints so the
 * downstream matcher has something to match on. Safe to call with empty
 * hints; returns the original reason unchanged.
 */
export function enrichReasonWithHints(reason: string, hints: readonly string[]): string {
  if (hints.length === 0) return reason;
  return `${reason} [tool args reference: ${hints.join(', ')}]`;
}
