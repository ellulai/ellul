// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Governed tool execution types. Capability taxonomy → gate; user overrides
// only TIGHTEN. Classifier is a discriminated union (high/med proceed, low → quarantine).

// ── Version Constants ──

export const TAXONOMY_VERSION = "1.0.0";
export const CLASSIFIER_VERSION = "1.0.0";
export const GATEWAY_VERSION = "1.0.0";

// ── Gate Type (canonical, matches Sovereign Shield) ──

// Reused from sovereign-shield/gate.service.ts.
export type GateType =
  | 'logs'
  | 'env'
  | 'db_read'
  | 'db_write'
  | 'db_migrate'
  | 'git'
  | 'deploy'
  | 'exec'
  | 'wallet_spend'
  | 'vault_read';

// ── Capability Taxonomy ──

// Families group capabilities by risk domain; each has its own strictness level.
export type CapabilityFamily =
  | 'filesystem'
  | 'network'
  | 'database'
  | 'secrets'
  | 'execution'
  | 'deployment'
  | 'financial'
  | 'observability';

// Format: `{family}:{action}`; family prefix always present.
export type ToolCapability =
  // filesystem
  | 'filesystem:read'
  | 'filesystem:write'
  | 'filesystem:delete'
  // network
  | 'network:http_read'
  | 'network:http_write'
  | 'network:websocket'
  | 'network:dns'
  // database
  | 'database:read'
  | 'database:write'
  | 'database:migrate'
  // secrets
  | 'secrets:env_read'
  | 'secrets:env_inject'
  | 'secrets:vault_read'
  // execution
  | 'execution:shell'
  | 'execution:process_spawn'
  | 'execution:code_eval'
  // deployment
  | 'deployment:git_read'
  | 'deployment:git_write'
  | 'deployment:deploy_trigger'
  // financial
  | 'financial:wallet_read'
  | 'financial:wallet_spend'
  // observability
  | 'observability:logs_read'
  | 'observability:metrics_read';

// strict = passkey required; moderate = auto with gate; relaxed = sandbox auto.
export type StrictnessLevel = 'strict' | 'moderate' | 'relaxed';

// Per-tool permission level (used by gateway + manifest defaults).
export type ToolPermissionLevel = 'ask' | 'allow_session' | 'allow_always' | 'never';

// Manifest entry for known providers: capability + default permission posture.
// Known (platform-installed) providers declare per-tool defaults that take
// effect on connect. Users can override via the console at any time.
export interface ToolManifestEntry {
  capability: ToolCapability;
  defaultPermission: ToolPermissionLevel;
}

// Policy engine floor per family; user overrides can only tighten.
export const FAMILY_STRICTNESS: Readonly<Record<CapabilityFamily, StrictnessLevel>> = {
  filesystem:     'relaxed',
  network:        'moderate',
  database:       'moderate',
  secrets:        'strict',
  execution:      'moderate',
  deployment:     'strict',
  financial:      'strict',
  observability:  'relaxed',
} as const;

export function getFamily(cap: ToolCapability): CapabilityFamily {
  const colonIdx = cap.indexOf(':');
  if (colonIdx === -1) {
    throw new Error(`Invalid capability format (missing family prefix): ${cap}`);
  }
  return cap.slice(0, colonIdx) as CapabilityFamily;
}

// Higher number = stricter; user overrides can only move UP.
const STRICTNESS_RANK: Readonly<Record<StrictnessLevel, number>> = {
  relaxed:  0,
  moderate: 1,
  strict:   2,
} as const;

export function canTighten(systemCap: ToolCapability, userCap: ToolCapability): boolean {
  const systemFamily = getFamily(systemCap);
  const userFamily = getFamily(userCap);
  const systemStrictness = FAMILY_STRICTNESS[systemFamily];
  const userStrictness = FAMILY_STRICTNESS[userFamily];
  return STRICTNESS_RANK[userStrictness] >= STRICTNESS_RANK[systemStrictness];
}

// Capability → Sovereign Gate that must be open to exercise it.
export const CAPABILITY_GATE: Readonly<Record<ToolCapability, GateType>> = {
  'filesystem:read':           'exec',
  'filesystem:write':          'exec',
  'filesystem:delete':         'exec',
  'network:http_read':         'exec',
  'network:http_write':        'exec',
  'network:websocket':         'exec',
  'network:dns':               'exec',
  'database:read':             'db_read',
  'database:write':            'db_write',
  'database:migrate':          'db_migrate',
  'secrets:env_read':          'env',
  'secrets:env_inject':        'env',
  'secrets:vault_read':        'vault_read',
  'execution:shell':           'exec',
  'execution:process_spawn':   'exec',
  'execution:code_eval':       'exec',
  'deployment:git_read':       'git',
  'deployment:git_write':      'git',
  'deployment:deploy_trigger': 'deploy',
  'financial:wallet_read':     'wallet_spend',
  'financial:wallet_spend':    'wallet_spend',
  'observability:logs_read':   'logs',
  'observability:metrics_read': 'logs',
} as const;

// ── Target & Provider Identity ──

export interface GovernedToolTarget {
  resourceType: string;
  resourceId: string;
  environment: 'sandbox' | 'namespace' | 'host';
  scope: string;
}

export type ProviderTransport = 'stdio' | 'sse' | 'streamable-http' | 'websocket';

export interface ProviderIdentity {
  providerId: string;
  providerType: 'mcp' | 'openapi' | 'custom' | 'builtin';
  endpoint: string;
  transport: ProviderTransport;
  tlsFingerprint: string | null;
  manifestFingerprint: string | null;
  // SHA-256 of tool list at discovery — detects injection/drift.
  toolListHash: string;
}

// ── Authorization Artifacts ──

// consumed = single-use, spent; revoked = user action; expired = TTL.
export type ArtifactRevocationStatus = 'active' | 'revoked' | 'expired' | 'consumed';

// Full record stored in shield's SQLite; proof of user consent for a capability.
export interface AuthorizationArtifactRecord {
  artifactId: string;
  threadId: string;
  sandboxId: string;
  orgScope: string | null;
  providerId: string;
  toolName: string;
  capability: ToolCapability;
  gateType: GateType;
  constraints: ExecutionConstraints;
  status: ArtifactRevocationStatus;
  issuedAt: string;
  expiresAt: string;
  // Hex, prevents replay.
  nonce: string;
  issuer: string;
  audience: string;
  subject: string;
  keyVersion: number;
  // Ed25519 of the compact token.
  signature: string;
  revokedAt: string | null;
  revokedReason: string | null;
  updatedAt: string;
}

// Compact signed token passed to execution; bound to the full record.
export interface AuthorizationArtifactToken {
  artifactId: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  issuer: string;
  audience: string;
  subject: string;
  providerId: string;
  keyVersion: number;
  signature: string;
}

// ── Execution Constraints ──

// Structured (not regex) to prevent injection; parseable.
export interface TargetPattern {
  resourceType: string;
  // Glob (e.g., '/home/coder/project/**').
  resourceIdPattern: string;
  environments: Array<GovernedToolTarget['environment']>;
}

export interface NetworkPolicy {
  allowOutbound: boolean;
  allowedHosts: string[];
  allowedPorts: number[];
  // Deny list; takes priority over allowedHosts.
  blockedCidrs: string[];
}

// summary = structured summary only; none = fire-and-forget.
export type ResponsePolicy = 'full' | 'redacted' | 'summary' | 'none';

// tls_pinned requires tlsFingerprint match; any = unrestricted (trusted builtins).
export type TransportPolicy = 'tls_required' | 'tls_pinned' | 'local_only' | 'any';

export interface ExecutionConstraints {
  maxDurationMs: number;
  maxPayloadBytes: number;
  allowedTargetPatterns: TargetPattern[];
  networkPolicy: NetworkPolicy;
  responsePolicy: ResponsePolicy;
  requirePasskey: boolean;
  transportPolicy: TransportPolicy;
}

// ── Tool Definition & Lifecycle ──

// quarantined = low classifier confidence; approved = ready to exec.
export type ToolLifecycleStatus =
  | 'discovered'
  | 'classified'
  | 'quarantined'
  | 'pending_review'
  | 'approved'
  | 'disabled'
  | 'rejected'
  | 'error';

export type ToolExposureStatus =
  | 'hidden'
  | 'review_only'
  | 'agent_visible'
  | 'admin_only'
  | 'revoked';

// Normalized tool from any provider (MCP/OpenAPI/custom).
export interface GovernedToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  provider: ProviderIdentity;
  capability: ToolCapability | null;
  lifecycleStatus: ToolLifecycleStatus;
  exposureStatus: ToolExposureStatus;
  // SHA-256 of (name + description + inputSchema).
  definitionHash: string;
  discoveredAt: string;
  classifiedAt: string | null;
  taxonomyVersion: string;
}

// ── Classifier Output ──

export interface ClassifierSignal {
  source: string;
  matched: string;
  // 0.0 to 1.0.
  weight: number;
}

export type ClassifierConfidence = 'high' | 'medium' | 'low';

// low → quarantine for manual review.
export type ClassifierOutput =
  | {
      confidence: 'high' | 'medium';
      capability: ToolCapability;
      signals: ClassifierSignal[];
      classifierVersion: string;
      taxonomyVersion: string;
    }
  | {
      confidence: 'low';
      suggestedCapability: ToolCapability | null;
      signals: ClassifierSignal[];
      quarantineReason: string;
      classifierVersion: string;
      taxonomyVersion: string;
    };

// ── Policy Engine ──

// Org-wide rules; can't be loosened by individuals.
export interface OrgPolicyConstraints {
  orgScope: string;
  blockedCapabilities: ToolCapability[];
  maxDurationMs: number | null;
  requirePasskey: boolean;
  allowedProviderTypes: Array<ProviderIdentity['providerType']> | null;
  transportPolicy: TransportPolicy | null;
}

export interface PolicyInput {
  classifierOutput: ClassifierOutput;
  providerIdentity: ProviderIdentity;
  target: GovernedToolTarget;
  // Can only tighten; validated by canTighten.
  userOverride: ToolCapability | null;
  orgPolicy: OrgPolicyConstraints | null;
  transport: ProviderTransport;
}

export interface PolicyDecision {
  effectiveCapability: ToolCapability;
  effectiveGate: GateType;
  executionConstraints: ExecutionConstraints;
  decisionReason: string;
  policyVersion: string;
  toolLifecycleStatus: ToolLifecycleStatus;
  exposureStatus: ToolExposureStatus;
}

// ── Tool Call Result ──

export type ToolCallResult =
  | {
      status: 'success';
      output: unknown;
      durationMs: number;
      artifactId: string;
      providerId: string;
    }
  | {
      status: 'approval_required';
      requiredGate: GateType;
      requiredCapability: ToolCapability;
      reason: string;
      pendingArtifactId: string;
    }
  | {
      status: 'denied';
      deniedCapability: ToolCapability;
      reason: string;
      policyVersion: string;
    }
  | {
      status: 'error';
      errorCode: string;
      message: string;
      retryable: boolean;
      // null if pre-execution.
      providerId: string | null;
    };

// ── Audit Trail ──

// Immutable provenance record: who/what/where/authority/constraints/decision/result/when.
export interface ToolExecutionAudit {
  auditId: string;

  // ── Who ──
  threadId: string;
  sandboxId: string;
  orgScope: string | null;
  sessionId: string;
  project: string | null;

  // ── What ──
  toolName: string;
  capability: ToolCapability;
  gateType: GateType;
  inputHash: string;
  outputHash: string | null;

  // ── Of Whom ──
  provider: ProviderIdentity;

  // ── Targeting What ──
  target: GovernedToolTarget;

  // ── With What Authority ──
  artifactId: string | null;
  artifactStatus: ArtifactRevocationStatus | null;

  // ── Constrained How ──
  constraints: ExecutionConstraints | null;

  // ── Decided By ──
  classifierOutput: ClassifierOutput;
  policyDecision: PolicyDecision | null;

  // ── Resulting In ──
  resultStatus: ToolCallResult['status'];
  errorCode: string | null;
  durationMs: number | null;

  // ── When ──
  createdAt: string;
  executionStartedAt: string | null;
  executionCompletedAt: string | null;

  // ── Provenance ──
  taxonomyVersion: string;
  classifierVersion: string;
  gatewayVersion: string;
}
