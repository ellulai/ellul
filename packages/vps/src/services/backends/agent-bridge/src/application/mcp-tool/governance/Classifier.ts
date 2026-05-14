// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Tool Classifier
 *
 * Pure function that proposes a capability classification based on
 * untrusted MCP tool metadata. Analyzes tool name, description,
 * JSON schema, provider type, and transport to produce a classification
 * with confidence level and signal audit trail.
 *
 * SECURITY: This is a PROPOSAL only — the policy engine makes binding
 * decisions. The classifier never trusts metadata; it pattern-matches
 * and reports what it found.
 */

import type {
  ToolCapability,
  ClassifierOutput,
  ClassifierSignal,
  ClassifierConfidence,
} from './Types';

import {
  CLASSIFIER_VERSION,
  TAXONOMY_VERSION,
} from './Types';

// ── Pattern Definitions ──
// Each entry maps keyword patterns to their suggested capability and signal strength.

interface PatternRule {
  /** Regex pattern to match against (case-insensitive) */
  pattern: RegExp;
  /** The capability this pattern suggests */
  capability: ToolCapability;
  /** Strength of this signal */
  strength: 'strong' | 'moderate' | 'weak';
}

/** Internal working signal — extends ClassifierSignal with classifier-private fields. */
interface InternalSignal {
  /** What produced this signal (e.g., 'name_pattern', 'schema_analysis', 'description_nlp'). */
  source: string;
  /** What pattern or rule matched. */
  matched: string;
  /** Weight of this signal in the final confidence score (0.0 to 1.0). */
  weight: number;
  /** The capability this signal suggests (classifier-internal, not in ClassifierSignal). */
  suggestedCapability: ToolCapability;
  /** Strength label (classifier-internal, not in ClassifierSignal). */
  strength: 'strong' | 'moderate' | 'weak';
}

const STRENGTH_WEIGHT: Record<string, number> = { strong: 1.0, moderate: 0.6, weak: 0.3 };

/** Convert internal signals to the public ClassifierSignal type for output. */
function toClassifierSignals(signals: InternalSignal[]): ClassifierSignal[] {
  return signals.map(s => ({ source: s.source, matched: s.matched, weight: s.weight }));
}

// Database patterns — ordered from most specific (schema/migrate) to least specific (read)
const DB_SCHEMA_PATTERNS: PatternRule[] = [
  { pattern: /\b(create\s+table|alter\s+table|drop\s+table|migrate|migration|ddl)\b/, capability: 'database:migrate', strength: 'strong' },
  { pattern: /\b(create\s+index|drop\s+index|add\s+column|drop\s+column|truncate)\b/, capability: 'database:migrate', strength: 'strong' },
  { pattern: /\bschema\b/, capability: 'database:migrate', strength: 'moderate' },
];

const DB_WRITE_PATTERNS: PatternRule[] = [
  { pattern: /\b(insert|update|delete|upsert|write)\b/, capability: 'database:write', strength: 'strong' },
  { pattern: /\b(mutate|mutation|modify|put|patch|remove)\b/, capability: 'database:write', strength: 'moderate' },
];

const DB_READ_PATTERNS: PatternRule[] = [
  { pattern: /\b(sql|query|select|database|table|postgres|mysql|sqlite|supabase|prisma|drizzle)\b/, capability: 'database:read', strength: 'strong' },
  { pattern: /\b(db|rds|dynamo|mongo|redis|firestore|fauna)\b/, capability: 'database:read', strength: 'moderate' },
  { pattern: /\bdata(base|store|source)\b/, capability: 'database:read', strength: 'moderate' },
];

// Deploy patterns
const DEPLOY_PATTERNS: PatternRule[] = [
  { pattern: /\b(deploy|publish|release|ship)\b/, capability: 'deployment:deploy_trigger', strength: 'strong' },
  { pattern: /\b(rollback|canary|blue.?green|staging)\b/, capability: 'deployment:deploy_trigger', strength: 'moderate' },
  { pattern: /\b(vercel|netlify|fly\.io|heroku|cloudflare.?pages)\b/, capability: 'deployment:deploy_trigger', strength: 'moderate' },
];

// Git patterns — mutating vs read-only
const GIT_WRITE_PATTERNS: PatternRule[] = [
  { pattern: /\b(git\s*push|git\s*commit|git\s*merge|git\s*rebase|git\s*reset)\b/, capability: 'deployment:git_write', strength: 'strong' },
  { pattern: /\b(push|commit|merge)\b/, capability: 'deployment:git_write', strength: 'moderate' },
];

const GIT_READ_PATTERNS: PatternRule[] = [
  { pattern: /\b(git\s*log|git\s*diff|git\s*status|git\s*blame|git\s*show)\b/, capability: 'deployment:git_read', strength: 'strong' },
  { pattern: /\b(git\s*pull|git\s*fetch|git\s*clone)\b/, capability: 'deployment:git_read', strength: 'strong' },
  { pattern: /\bgit\b/, capability: 'deployment:git_read', strength: 'moderate' },
  { pattern: /\b(branch|repository|repo)\b/, capability: 'deployment:git_read', strength: 'weak' },
];

// Secret patterns
const SECRET_WRITE_PATTERNS: PatternRule[] = [
  { pattern: /\b(set\s*secret|write\s*secret|create\s*secret|store\s*secret|put\s*secret)\b/, capability: 'secrets:env_inject', strength: 'strong' },
  { pattern: /\b(set\s*(credential|password|token|api[_\s]?key))\b/, capability: 'secrets:env_inject', strength: 'strong' },
  { pattern: /\b(rotate\s*(secret|key|token|credential))\b/, capability: 'secrets:env_inject', strength: 'strong' },
];

const SECRET_READ_PATTERNS: PatternRule[] = [
  { pattern: /\b(secret|credential|password|token|api[_\s]?key)\b/, capability: 'secrets:env_read', strength: 'strong' },
  { pattern: /\b(vault|keychain|ssm|secrets?\s*manager)\b/, capability: 'secrets:vault_read', strength: 'strong' },
  { pattern: /\b(env(iron(ment)?)?[_\s]?var(iable)?s?)\b/, capability: 'secrets:env_read', strength: 'moderate' },
];

// Filesystem patterns
const FS_WRITE_PATTERNS: PatternRule[] = [
  { pattern: /\b(write[_\s]?file|create[_\s]?file|delete[_\s]?file|remove[_\s]?file|mkdir|rmdir|unlink)\b/, capability: 'filesystem:write', strength: 'strong' },
  { pattern: /\b(save|overwrite|append|truncate)\b/, capability: 'filesystem:write', strength: 'moderate' },
];

const FS_READ_PATTERNS: PatternRule[] = [
  { pattern: /\b(read[_\s]?file|list[_\s]?file|search[_\s]?file|find[_\s]?file|glob)\b/, capability: 'filesystem:read', strength: 'strong' },
  { pattern: /\b(file|directory|folder|path|filesystem)\b/, capability: 'filesystem:read', strength: 'moderate' },
  { pattern: /\b(ls|cat|head|tail|stat|readdir)\b/, capability: 'filesystem:read', strength: 'moderate' },
];

// Shell patterns
const SHELL_PATTERNS: PatternRule[] = [
  { pattern: /\b(exec|execute|run[_\s]?command|shell|bash|sh|zsh|terminal|subprocess)\b/, capability: 'execution:shell', strength: 'strong' },
  { pattern: /\b(cmd|command[_\s]?line|cli|process|spawn)\b/, capability: 'execution:shell', strength: 'moderate' },
];

// Financial patterns
const FINANCIAL_WRITE_PATTERNS: PatternRule[] = [
  { pattern: /\b(charge|refund|payout|transfer|payment|invoice|subscription|checkout)\b/, capability: 'financial:wallet_spend', strength: 'strong' },
  { pattern: /\b(create_price|create_product|create_customer|create_coupon|create_invoice|create_payment)\b/, capability: 'financial:wallet_spend', strength: 'strong' },
  { pattern: /\b(cancel_subscription|update_subscription|finalize_invoice)\b/, capability: 'financial:wallet_spend', strength: 'strong' },
];

const FINANCIAL_READ_PATTERNS: PatternRule[] = [
  { pattern: /\b(balance|revenue|billing|pricing|plan|tier)\b/, capability: 'financial:wallet_read', strength: 'strong' },
  { pattern: /\b(list_customers|list_products|list_prices|list_invoices|list_subscriptions|list_payment|list_disputes)\b/, capability: 'financial:wallet_read', strength: 'strong' },
  { pattern: /\b(stripe|paypal|braintree|square)\b/, capability: 'financial:wallet_read', strength: 'moderate' },
];

// Network patterns
const NETWORK_PATTERNS: PatternRule[] = [
  { pattern: /\b(http|https|request|fetch|curl|wget|api[_\s]?call)\b/, capability: 'network:http_read', strength: 'strong' },
  { pattern: /\b(webhook|endpoint|url|rest|graphql|grpc)\b/, capability: 'network:http_read', strength: 'moderate' },
  { pattern: /\b(send|post|get|put|patch|delete)\b/, capability: 'network:http_write', strength: 'weak' },
];

// ── Provider Type Hints ──
// Maps known provider type strings to their likely capability family.

const PROVIDER_HINTS: Readonly<Record<string, ToolCapability>> = {
  supabase: 'database:read',
  postgres: 'database:read',
  mysql: 'database:read',
  mongodb: 'database:read',
  redis: 'database:read',
  firebase: 'database:read',
  planetscale: 'database:read',
  neon: 'database:read',
  turso: 'database:read',
  github: 'deployment:git_read',
  gitlab: 'deployment:git_read',
  bitbucket: 'deployment:git_read',
  vercel: 'deployment:deploy_trigger',
  netlify: 'deployment:deploy_trigger',
  'fly.io': 'deployment:deploy_trigger',
  flyio: 'deployment:deploy_trigger',
  heroku: 'deployment:deploy_trigger',
  railway: 'deployment:deploy_trigger',
  render: 'deployment:deploy_trigger',
  cloudflare: 'network:http_read',
  stripe: 'financial:wallet_read',
  aws: 'execution:shell',
  gcp: 'execution:shell',
  azure: 'execution:shell',
  vault: 'secrets:vault_read',
  doppler: 'secrets:env_read',
  '1password': 'secrets:vault_read',
  infisical: 'secrets:env_read',
};

// ── Pattern Groups (ordered by specificity — most specific first) ──
// Within each family, more specific patterns (e.g., db.schema) must come
// before less specific ones (e.g., db.read) so the classifier picks the
// tightest match when scanning.

const ALL_PATTERN_GROUPS: PatternRule[][] = [
  DB_SCHEMA_PATTERNS,
  DB_WRITE_PATTERNS,
  DB_READ_PATTERNS,
  DEPLOY_PATTERNS,
  GIT_WRITE_PATTERNS,
  GIT_READ_PATTERNS,
  SECRET_WRITE_PATTERNS,
  SECRET_READ_PATTERNS,
  FINANCIAL_WRITE_PATTERNS,
  FINANCIAL_READ_PATTERNS,
  FS_WRITE_PATTERNS,
  FS_READ_PATTERNS,
  SHELL_PATTERNS,
  NETWORK_PATTERNS,
];

// ── Helpers ──

function matchPatterns(
  text: string,
  source: string,
  patterns: PatternRule[],
): InternalSignal[] {
  const signals: InternalSignal[] = [];
  const lower = text.toLowerCase();
  for (const rule of patterns) {
    const match = lower.match(rule.pattern);
    if (match) {
      signals.push({
        source,
        matched: match[0],
        weight: STRENGTH_WEIGHT[rule.strength] ?? 0.3,
        suggestedCapability: rule.capability,
        strength: rule.strength,
      });
    }
  }
  return signals;
}

/**
 * Scan a text source against all pattern groups and collect signals.
 */
function scanText(
  text: string,
  source: string,
): InternalSignal[] {
  const signals: InternalSignal[] = [];
  for (const group of ALL_PATTERN_GROUPS) {
    signals.push(...matchPatterns(text, source, group));
  }
  return signals;
}

/**
 * Extract searchable text from a JSON schema object.
 * Walks property names, descriptions, and enum values.
 */
function extractSchemaText(schema: Record<string, unknown>): string {
  const parts: string[] = [];

  function walk(obj: unknown): void {
    if (obj == null || typeof obj !== 'object') return;
    if (Array.isArray(obj)) {
      for (const item of obj) walk(item);
      return;
    }
    const rec = obj as Record<string, unknown>;
    for (const [key, value] of Object.entries(rec)) {
      parts.push(key);
      if (typeof value === 'string') {
        parts.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') parts.push(item);
          else walk(item);
        }
      } else {
        walk(value);
      }
    }
  }

  walk(schema);
  return parts.join(' ');
}

/**
 * Given a bag of signals, pick the winning capability.
 *
 * Strategy:
 * 1. Score each capability by summing signal strengths (strong=3, moderate=2, weak=1)
 *    weighted by source diversity bonus.
 * 2. Within the same family, prefer the most specific (tightest) capability
 *    when signals conflict (e.g., both db.read and db.write matched).
 * 3. Return the highest-scoring capability.
 */
function pickCapability(signals: InternalSignal[]): ToolCapability | null {
  if (signals.length === 0) return null;

  const STRENGTH_SCORE: Record<string, number> = { strong: 3, moderate: 2, weak: 1 };

  // Score each capability
  const scores = new Map<ToolCapability, number>();
  const sources = new Map<ToolCapability, Set<string>>();

  for (const sig of signals) {
    const base = STRENGTH_SCORE[sig.strength] ?? 1;
    scores.set(sig.suggestedCapability, (scores.get(sig.suggestedCapability) ?? 0) + base);
    if (!sources.has(sig.suggestedCapability)) sources.set(sig.suggestedCapability, new Set());
    sources.get(sig.suggestedCapability)!.add(sig.source);
  }

  // Apply source diversity bonus: each additional unique source adds +1
  for (const [cap, srcSet] of sources) {
    if (srcSet.size > 1) {
      scores.set(cap, (scores.get(cap) ?? 0) + (srcSet.size - 1));
    }
  }

  // Within the same family, the most specific (highest-index) capability wins
  // if it has ANY strong signal. This prevents a pile of weak db.read signals
  // from overriding a single strong db.schema signal.
  const FAMILY_SPECIFICITY: ToolCapability[][] = [
    ['database:read', 'database:write', 'database:migrate'],
    ['deployment:git_read', 'deployment:git_write'],
    ['secrets:env_read', 'secrets:env_inject', 'secrets:vault_read'],
    ['filesystem:read', 'filesystem:write', 'filesystem:delete'],
    ['financial:wallet_read', 'financial:wallet_spend'],
  ];

  for (const family of FAMILY_SPECIFICITY) {
    const present = family.filter(c => scores.has(c));
    if (present.length > 1) {
      // Find the most specific with at least one strong signal
      const withStrong = present.filter(c =>
        signals.some(s => s.suggestedCapability === c && s.strength === 'strong'),
      );
      const winner = withStrong.length > 0
        ? withStrong[withStrong.length - 1]  // most specific with strong signal
        : present[present.length - 1];        // most specific overall
      // Boost the winner, zero out others in the family
      for (const c of present) {
        if (c !== winner) scores.delete(c);
      }
    }
  }

  // Pick highest score
  let best: ToolCapability | null = null;
  let bestScore = 0;
  for (const [cap, score] of scores) {
    if (score > bestScore) {
      bestScore = score;
      best = cap;
    }
  }

  return best;
}

/**
 * Determine confidence level from the signal set.
 */
function determineClassifierConfidence(signals: InternalSignal[]): ClassifierConfidence {
  if (signals.length === 0) return 'low';

  const strongSignals = signals.filter(s => s.strength === 'strong');
  const uniqueSources = new Set(signals.map(s => s.source));

  // Check for conflicting families
  const families = new Set(signals.map(s => capabilityFamily(s.suggestedCapability)));
  const hasConflict = families.size > 2; // More than 2 families = ambiguous

  if (hasConflict && strongSignals.length < 2) return 'low';

  // Multiple strong signals from different sources = high confidence
  if (strongSignals.length >= 2 && uniqueSources.size >= 2) return 'high';

  // At least one strong signal or multiple moderate from different sources
  if (strongSignals.length >= 1 && uniqueSources.size >= 2) return 'high';
  if (strongSignals.length >= 1) return 'medium';

  // Only moderate/weak signals
  if (uniqueSources.size >= 2) return 'medium';

  return 'low';
}

function capabilityFamily(cap: ToolCapability): string {
  return cap.split(':')[0]!;
}

function buildReasoning(
  capability: ToolCapability | null,
  confidence: ClassifierConfidence,
  signals: InternalSignal[],
): string {
  if (!capability) {
    return 'No clear capability signals detected. Tool quarantined pending manual review.';
  }

  const uniqueSources = [...new Set(signals.map(s => s.source))];
  const strongCount = signals.filter(s => s.strength === 'strong').length;
  const sourceList = uniqueSources.join(', ');

  return `Classified as ${capability} (${confidence} confidence) based on ${signals.length} signal(s) from ${sourceList}. ${strongCount} strong match(es).`;
}

// ── Public API ──

/**
 * Classify an MCP tool by analyzing its metadata.
 *
 * Pure function — same inputs always produce the same output.
 * The classification is a PROPOSAL; the policy engine makes binding decisions.
 *
 * @param name - Tool name (e.g., "run_sql_query", "supabase_select")
 * @param description - Human-readable tool description
 * @param schema - JSON Schema of the tool's input parameters (optional)
 * @param providerType - Provider identifier hint (e.g., "supabase", "github")
 * @param transport - MCP transport type ("stdio" | "sse" | "streamable-http")
 */
export function classifyTool(
  name: string,
  description: string,
  schema: Record<string, unknown> | undefined,
  providerType?: string,
  transport?: string,
): ClassifierOutput {
  const signals: InternalSignal[] = [];

  // 1. Scan tool name
  signals.push(...scanText(name, 'name'));

  // 2. Scan description
  if (description) {
    signals.push(...scanText(description, 'description'));
  }

  // 3. Scan schema (property names, descriptions, enum values)
  if (schema) {
    const schemaText = extractSchemaText(schema);
    if (schemaText.trim().length > 0) {
      signals.push(...scanText(schemaText, 'schema'));
    }
  }

  // 4. Check provider type hints
  if (providerType) {
    const normalized = providerType.toLowerCase().trim();
    const hint = PROVIDER_HINTS[normalized];
    if (hint) {
      signals.push({
        source: 'provider',
        matched: normalized,
        weight: 0.6,
        suggestedCapability: hint,
        strength: 'moderate',
      });
    }
  }

  // 5. Transport signal: stdio elevates risk slightly
  if (transport === 'stdio') {
    // stdio tools run as local subprocesses — slightly higher risk surface.
    // This doesn't change the capability but is recorded for policy decisions.
    // If we already have shell/exec signals, strengthen them.
    const shellSignals = signals.filter(
      s => s.suggestedCapability === 'execution:shell' || s.suggestedCapability === 'filesystem:write',
    );
    if (shellSignals.length > 0) {
      signals.push({
        source: 'transport',
        matched: 'stdio',
        weight: 0.3,
        suggestedCapability: 'execution:shell',
        strength: 'weak',
      });
    }
  }

  // 6. Pick the winning capability
  const capability = pickCapability(signals);
  const confidence = determineClassifierConfidence(signals);

  // 7. Quarantine if no clear signal or low confidence
  if (!capability || confidence === 'low') {
    return {
      confidence: 'low',
      suggestedCapability: capability ?? null,
      signals: toClassifierSignals(signals),
      quarantineReason: buildReasoning(capability, 'low', signals),
      classifierVersion: CLASSIFIER_VERSION,
      taxonomyVersion: TAXONOMY_VERSION,
    };
  }

  return {
    capability,
    confidence,
    signals: toClassifierSignals(signals),
    classifierVersion: CLASSIFIER_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
  };
}
