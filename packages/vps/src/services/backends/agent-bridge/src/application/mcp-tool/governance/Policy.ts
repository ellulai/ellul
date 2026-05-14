// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Policy Engine
 *
 * Pure function that takes classifier output + runtime context and
 * returns a binding policy decision: lifecycle status, exposure,
 * gate mapping, and execution constraints.
 *
 * SECURITY: This is the decision-maker. The classifier proposes;
 * the policy engine disposes. User overrides can only TIGHTEN
 * (never loosen) the system classification.
 */

import type {
  ToolCapability,
  ClassifierOutput,
  ExecutionConstraints,
  ToolExposureStatus,
  GateType,
  PolicyDecision,
  PolicyInput,
  ResponsePolicy,
  ToolLifecycleStatus,
  TransportPolicy,
} from './Types';

import {
  CAPABILITY_GATE,
  FAMILY_STRICTNESS,
  GATEWAY_VERSION,
  canTighten,
  getFamily,
} from './Types';

// ── Duration Constants (internal to policy engine) ──

const DEFAULT_MAX_DURATION_MS = 30_000;
const STDIO_MAX_DURATION_MS = 15_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

// ── Response Policy Mapping ──

/**
 * Determine the default response policy based on capability family.
 * Secret-family tools get redacted responses; everything else gets full.
 */
function defaultResponsePolicy(capability: ToolCapability): ResponsePolicy {
  const family = getFamily(capability);
  switch (family) {
    case 'secrets': return 'redacted';
    case 'financial': return 'summary';
    default: return 'full';
  }
}

// ── Transport Policy Mapping ──

/**
 * Determine the default transport policy based on the provider transport.
 */
function defaultTransportPolicy(transport: PolicyInput['transport']): TransportPolicy {
  switch (transport) {
    case 'stdio': return 'local_only';
    case 'sse':
    case 'streamable-http':
    case 'websocket': return 'tls_required';
    default: return 'tls_required';
  }
}

// ── Constraint Builder ──

function buildConstraints(
  capability: ToolCapability,
  target: PolicyInput['target'],
  transport: PolicyInput['transport'],
  orgPolicy: PolicyInput['orgPolicy'],
): ExecutionConstraints {
  const isStdio = transport === 'stdio';
  const family = getFamily(capability);
  const strictness = FAMILY_STRICTNESS[family];

  // Base max duration — tighten for stdio
  let maxDurationMs = DEFAULT_MAX_DURATION_MS;
  if (isStdio) maxDurationMs = Math.min(maxDurationMs, STDIO_MAX_DURATION_MS);

  // Apply org-level duration cap if present and lower
  if (orgPolicy?.maxDurationMs != null) {
    maxDurationMs = Math.min(maxDurationMs, orgPolicy.maxDurationMs);
  }

  // Passkey requirement: strict capabilities always require passkey
  const HIGH_RISK_CAPABILITIES: ReadonlySet<ToolCapability> = new Set([
    'database:migrate', 'database:write', 'deployment:deploy_trigger',
    'deployment:git_write', 'secrets:env_inject', 'secrets:vault_read',
    'execution:shell', 'financial:wallet_spend',
  ]);
  let requirePasskey = strictness === 'strict' || HIGH_RISK_CAPABILITIES.has(capability);
  if (orgPolicy?.requirePasskey) requirePasskey = true;

  // Transport policy
  let transportPolicy = defaultTransportPolicy(transport);
  if (orgPolicy?.transportPolicy != null) {
    transportPolicy = orgPolicy.transportPolicy;
  }

  return {
    maxDurationMs,
    maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
    allowedTargetPatterns: [{
      resourceType: target.resourceType,
      resourceIdPattern: '**',
      environments: [target.environment],
    }],
    networkPolicy: {
      allowOutbound: !isStdio,
      allowedHosts: [],
      allowedPorts: [],
      blockedCidrs: [],
    },
    responsePolicy: defaultResponsePolicy(capability),
    requirePasskey,
    transportPolicy,
  };
}

// ── Reasoning Builder ──

function buildPolicyReasoning(
  classifierOutput: ClassifierOutput,
  effectiveCapability: ToolCapability | null,
  toolLifecycleStatus: ToolLifecycleStatus,
  userOverride: ToolCapability | null,
): string {
  const parts: string[] = [];

  if (toolLifecycleStatus === 'quarantined') {
    parts.push('Tool quarantined: classifier found no clear capability signals or low confidence.');
    if (classifierOutput.signals.length > 0) {
      parts.push(`${classifierOutput.signals.length} ambiguous signal(s) recorded for manual review.`);
    }
    return parts.join(' ');
  }

  // For high/medium confidence, capability is on the classifier output
  if (classifierOutput.confidence !== 'low') {
    parts.push(`Classifier proposed ${classifierOutput.capability} (${classifierOutput.confidence}).`);
  }

  if (userOverride && classifierOutput.confidence !== 'low' && effectiveCapability !== classifierOutput.capability) {
    parts.push(`User override tightened to ${effectiveCapability}.`);
  }

  if (effectiveCapability) {
    const gate = CAPABILITY_GATE[effectiveCapability];
    parts.push(`Mapped to gate: ${gate}.`);
  }

  return parts.join(' ');
}

// ── Public API ──

/**
 * Evaluate policy for a classified tool and return a binding decision.
 *
 * Pure function — same inputs always produce the same output.
 * No side effects, no I/O, no state mutation.
 *
 * Decision flow:
 * 1. Quarantined classifier output -> quarantined decision (hidden from agent)
 * 2. Apply user override (validate with canTighten -- reject if loosening)
 * 3. Map effective capability to Sovereign Gate
 * 4. Build execution constraints based on target + transport
 * 5. Determine exposure status
 */
export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const { classifierOutput, userOverride, target, transport, orgPolicy } = input;

  // ── Step 1: Quarantine check ──
  if (classifierOutput.confidence === 'low') {
    return {
      toolLifecycleStatus: 'quarantined',
      exposureStatus: 'hidden',
      effectiveCapability: classifierOutput.suggestedCapability ?? ('execution:shell' as ToolCapability),
      effectiveGate: 'exec',
      executionConstraints: {
        maxDurationMs: 0, // cannot execute
        maxPayloadBytes: 0,
        allowedTargetPatterns: [],
        networkPolicy: {
          allowOutbound: false,
          allowedHosts: [],
          allowedPorts: [],
          blockedCidrs: [],
        },
        responsePolicy: 'none',
        requirePasskey: true,
        transportPolicy: 'local_only',
      },
      decisionReason: buildPolicyReasoning(classifierOutput, null, 'quarantined', userOverride),
      policyVersion: GATEWAY_VERSION,
    };
  }

  const systemCapability = classifierOutput.capability;

  // ── Step 2: Apply user override ──
  let effectiveCapability: ToolCapability = systemCapability;

  if (userOverride) {
    if (canTighten(systemCapability, userOverride)) {
      effectiveCapability = userOverride;
    }
    // If canTighten returns false, we silently ignore the override
    // (it would loosen the classification — security violation).
    // The reasoning will show the system capability was kept.
  }

  // ── Step 3: Check org-level blocks ──
  if (orgPolicy?.blockedCapabilities.includes(effectiveCapability)) {
    return {
      toolLifecycleStatus: 'rejected',
      exposureStatus: 'hidden',
      effectiveCapability,
      effectiveGate: CAPABILITY_GATE[effectiveCapability],
      executionConstraints: {
        maxDurationMs: 0,
        maxPayloadBytes: 0,
        allowedTargetPatterns: [],
        networkPolicy: {
          allowOutbound: false,
          allowedHosts: [],
          allowedPorts: [],
          blockedCidrs: [],
        },
        responsePolicy: 'none',
        requirePasskey: true,
        transportPolicy: 'local_only',
      },
      decisionReason: `Capability ${effectiveCapability} is blocked by org policy (${orgPolicy.orgScope}).`,
      policyVersion: GATEWAY_VERSION,
    };
  }

  // ── Step 4: Map to gate ──
  const effectiveGate: GateType = CAPABILITY_GATE[effectiveCapability];

  // ── Step 5: Build constraints ──
  const executionConstraints = buildConstraints(effectiveCapability, target, transport, orgPolicy);

  // ── Step 6: Exposure status ──
  const exposureStatus: ToolExposureStatus = 'agent_visible';

  // ── Step 7: Lifecycle status ──
  const toolLifecycleStatus: ToolLifecycleStatus = 'approved';

  return {
    toolLifecycleStatus,
    exposureStatus,
    effectiveCapability,
    effectiveGate,
    executionConstraints,
    decisionReason: buildPolicyReasoning(classifierOutput, effectiveCapability, toolLifecycleStatus, userOverride),
    policyVersion: GATEWAY_VERSION,
  };
}

/**
 * Determine if a tool can be auto-approved (no human-in-the-loop needed).
 *
 * Auto-approval requires ALL of:
 * 1. Classifier confidence is high or medium with a capability
 * 2. Capability ends in `:read` (read-only operation)
 * 3. Target environment is "sandbox" (not host or namespace)
 * 4. Transport is NOT "stdio" (no local subprocess risk)
 * 5. Provider type is in approved allowlist (not yet implemented — always false)
 *
 * This is intentionally conservative — every tool requires explicit approval
 * until the allowlist infrastructure is built.
 */
export function canAutoApprove(input: PolicyInput): boolean {
  const { classifierOutput, target, transport, providerIdentity } = input;

  // Must be classified (not quarantined) with a capability
  if (classifierOutput.confidence === 'low') {
    return false;
  }

  const capability = classifierOutput.capability;

  // 1. Only read-only capabilities
  if (!capability.endsWith(':read') && !capability.endsWith('_read')) {
    return false;
  }

  // 2. Only sandbox environments
  if (target.environment !== 'sandbox') {
    return false;
  }

  // 3. Not stdio transport
  if (transport === 'stdio') {
    return false;
  }

  // 4. Provider must be in approved allowlist (builtin only for now)
  if (providerIdentity.providerType !== 'builtin') {
    return false;
  }

  return true;
}
