// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Tool Authorization Service
 *
 * Mints, validates, signs, consumes, and revokes authorization artifacts.
 * Every governed tool call requires a valid artifact. Artifacts are bound
 * to capability + target + caller + TTL.
 *
 * Architecture:
 *   - In-memory artifact store (single-threaded Node.js guarantees atomicity)
 *   - HMAC-SHA256 signatures for compact tokens (per-VPS signing key)
 *   - Artifact lifecycle: active → consumed | revoked | expired
 *   - Compact tokens are derived from full records for execution-layer transport
 *
 * Security invariants:
 *   - "once" artifacts can only be consumed exactly once (atomic increment)
 *   - Artifact hash integrity check on every validation
 *   - Expired/revoked/consumed artifacts cannot be re-activated
 *   - Signing key is per-VPS, never leaves the process
 */

import { createHmac, randomUUID } from "crypto";

import type {
  AuthorizationArtifactRecord,
  AuthorizationArtifactToken,
  ToolCapability,
  GovernedToolTarget,
  GateType,
  ExecutionConstraints,
  ArtifactRevocationStatus,
} from "./Types";

import {
  TAXONOMY_VERSION,
  GATEWAY_VERSION,
} from "./Types";

// ── Signing Key ──
// Per-VPS key. Read from environment (for key rotation) or generated at startup.
// When generated at startup, artifacts do not survive process restarts — by design.

const SIGNING_KEY = process.env.TOOL_ARTIFACT_SIGNING_KEY || randomUUID();
const KEY_VERSION = 1;

// ── Extended Record ──
// The canonical AuthorizationArtifactRecord from types.ts is the storage-layer
// schema (SQLite in sovereign-shield). This service tracks additional in-memory
// fields for approval mode, invocation counting, and hash integrity that don't
// persist to the DB record but are critical for runtime authorization.

interface InMemoryArtifactState {
  /** The full artifact record (matches the DB schema). */
  record: AuthorizationArtifactRecord;
  /** Approval mode governing invocation limits. */
  approvalMode: "once" | "session" | "window";
  /** Number of times this artifact has been consumed. */
  invocationCount: number;
  /** Maximum invocations allowed (1 for "once", undefined for session/window). */
  maxInvocations: number | undefined;
  /** HMAC-SHA256 hash of the canonical artifact fields (integrity check). */
  artifactHash: string;
  /** Caller type that requested the authorization. */
  callerType: "human" | "agent" | "system";
  /** Method used to approve the authorization. */
  approvalMethod: "passkey" | "session" | "gate_token" | "policy_auto";
  /** Who approved the authorization. */
  approvedBy: string;
  /** Policy version at time of minting. */
  policyVersion: string;
  /** Classifier version at time of minting. */
  classifierVersion: string;
  /** Target the artifact is bound to. */
  target: GovernedToolTarget;
}

// ── Canonical JSON ──
// Deterministic serialization for hash integrity. Sorted keys ensure the
// same logical object always produces the same byte sequence.

function canonicalJson(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

// ── Hash Computation ──

function computeArtifactHash(record: AuthorizationArtifactRecord): string {
  const hashable: Record<string, unknown> = {
    artifactId: record.artifactId,
    threadId: record.threadId,
    sandboxId: record.sandboxId,
    orgScope: record.orgScope,
    providerId: record.providerId,
    toolName: record.toolName,
    capability: record.capability,
    gateType: record.gateType,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    nonce: record.nonce,
    issuer: record.issuer,
    audience: record.audience,
    subject: record.subject,
    keyVersion: record.keyVersion,
  };

  return createHmac("sha256", SIGNING_KEY)
    .update(canonicalJson(hashable))
    .digest("hex");
}

// ── Mint Parameters ──

interface MintParams {
  capability: ToolCapability;
  target: GovernedToolTarget;
  gateType: GateType;
  callerType: "human" | "agent" | "system";
  callerId: string;
  threadId: string;
  sandboxId: string;
  orgScope?: string | null;
  agentSessionId?: string;
  approvalMode: "once" | "session" | "window";
  ttlMs: number;
  constraints: ExecutionConstraints;
  approvedBy: string;
  approvalMethod: "passkey" | "session" | "gate_token" | "policy_auto";
  policyVersion: string;
  classifierVersion: string;
  toolProviderId?: string;
  toolName?: string;
}

// ── Service ──

class ToolAuthorizationService {
  private artifacts = new Map<string, InMemoryArtifactState>();

  /**
   * Mint a new authorization artifact.
   *
   * Creates a cryptographically signed artifact record bound to the
   * specified capability, target, and caller. The artifact is immediately
   * active and can be consumed by the execution layer.
   */
  mint(params: MintParams): AuthorizationArtifactRecord {
    const artifactId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + params.ttlMs);
    const nonce = randomUUID().replace(/-/g, "");

    const providerId = params.toolProviderId ?? "";
    const toolName = params.toolName ?? "";

    const record: AuthorizationArtifactRecord = {
      artifactId,
      threadId: params.threadId,
      sandboxId: params.sandboxId,
      orgScope: params.orgScope ?? null,
      providerId,
      toolName,
      capability: params.capability,
      gateType: params.gateType,
      constraints: params.constraints,
      status: "active",
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      nonce,
      issuer: "sovereign-shield",
      audience: providerId,
      subject: params.callerId,
      keyVersion: KEY_VERSION,
      signature: "", // computed after hash
      revokedAt: null,
      revokedReason: null,
      updatedAt: now.toISOString(),
    };

    // Compute integrity hash and sign the record
    const artifactHash = computeArtifactHash(record);
    record.signature = createHmac("sha256", SIGNING_KEY)
      .update(artifactHash)
      .digest("hex");

    const state: InMemoryArtifactState = {
      record,
      approvalMode: params.approvalMode,
      invocationCount: 0,
      maxInvocations: params.approvalMode === "once" ? 1 : undefined,
      artifactHash,
      callerType: params.callerType,
      approvalMethod: params.approvalMethod,
      approvedBy: params.approvedBy,
      policyVersion: params.policyVersion,
      classifierVersion: params.classifierVersion,
      target: params.target,
    };

    this.artifacts.set(artifactId, state);
    return record;
  }

  /**
   * Validate an artifact's current state.
   *
   * Checks: existence, status, expiry, invocation limit, hash integrity.
   * Does NOT consume an invocation — use consume() for that.
   */
  validate(artifactId: string): { valid: boolean; error?: string } {
    const state = this.artifacts.get(artifactId);
    if (!state) {
      return { valid: false, error: "Artifact not found" };
    }

    const { record } = state;

    // Status check
    if (record.status !== "active") {
      return { valid: false, error: `Artifact status is '${record.status}'` };
    }

    // Expiry check
    const now = Date.now();
    const expiresAtMs = new Date(record.expiresAt).getTime();
    if (expiresAtMs <= now) {
      record.status = "expired";
      record.updatedAt = new Date().toISOString();
      return { valid: false, error: "Artifact has expired" };
    }

    // Invocation limit check
    if (state.maxInvocations !== undefined && state.invocationCount >= state.maxInvocations) {
      record.status = "consumed";
      record.updatedAt = new Date().toISOString();
      return { valid: false, error: "Artifact invocation limit reached" };
    }

    // Integrity check — recompute hash and verify
    const recomputed = computeArtifactHash(record);
    if (recomputed !== state.artifactHash) {
      return { valid: false, error: "Artifact integrity check failed" };
    }

    return { valid: true };
  }

  /**
   * Consume one invocation of an artifact (atomic).
   *
   * In-memory, single-threaded Node.js guarantees that the read-check-increment
   * sequence cannot be interleaved by another call. Two parallel calls to
   * consume() on a "once" artifact will never both succeed.
   */
  consume(artifactId: string): { consumed: boolean; error?: string } {
    const state = this.artifacts.get(artifactId);
    if (!state) {
      return { consumed: false, error: "Artifact not found" };
    }

    // Validate first (checks status, expiry, limit, integrity)
    const validation = this.validate(artifactId);
    if (!validation.valid) {
      return { consumed: false, error: validation.error };
    }

    // Atomic increment (single-threaded Node.js guarantees no interleaving)
    state.invocationCount++;

    // If this was a "once" artifact, mark as consumed immediately
    if (state.approvalMode === "once") {
      state.record.status = "consumed";
      state.record.updatedAt = new Date().toISOString();
    }

    return { consumed: true };
  }

  /**
   * Revoke an artifact immediately.
   *
   * Revocation is permanent — a revoked artifact cannot be re-activated.
   * The reason is recorded for audit trail purposes.
   */
  revoke(artifactId: string, reason: string): void {
    const state = this.artifacts.get(artifactId);
    if (!state) return;

    // Only active artifacts can be revoked (already-terminal states are no-ops)
    if (state.record.status !== "active") return;

    const now = new Date().toISOString();
    state.record.status = "revoked";
    state.record.revokedAt = now;
    state.record.revokedReason = reason;
    state.record.updatedAt = now;
  }

  /**
   * Find a valid artifact matching the given capability + target + caller.
   *
   * Searches active artifacts for one that matches all criteria. Returns
   * the first valid match or null. Does not consume the artifact.
   *
   * Thread scoping: when threadId is provided, only artifacts minted for
   * that thread are considered (prevents cross-thread artifact leakage).
   */
  findValid(params: {
    capability: ToolCapability;
    target: GovernedToolTarget;
    callerId: string;
    threadId?: string;
  }): AuthorizationArtifactRecord | null {
    for (const state of this.artifacts.values()) {
      const { record } = state;

      // Must be active
      if (record.status !== "active") continue;

      // Capability match
      if (record.capability !== params.capability) continue;

      // Caller match
      if (record.subject !== params.callerId) continue;

      // Thread scoping (when specified)
      if (params.threadId !== undefined && record.threadId !== params.threadId) continue;

      // Target match — resource type and scope must align
      if (
        state.target.resourceType !== params.target.resourceType ||
        state.target.scope !== params.target.scope ||
        state.target.environment !== params.target.environment
      ) {
        continue;
      }

      // Must still be valid (expiry, invocation limit, integrity)
      const validation = this.validate(record.artifactId);
      if (!validation.valid) continue;

      return record;
    }

    return null;
  }

  /**
   * Create a signed compact token from an artifact record.
   *
   * The token carries the minimum fields needed for the execution layer
   * to verify authorization. It is HMAC-SHA256 signed with the per-VPS
   * signing key and includes a nonce to prevent replay.
   */
  createToken(artifact: AuthorizationArtifactRecord): AuthorizationArtifactToken {
    const issuedAtMs = Date.now();
    const expiresAtMs = new Date(artifact.expiresAt).getTime();

    const issuedAt = Math.floor(issuedAtMs / 1000);
    const expiresAt = Math.floor(expiresAtMs / 1000);
    const nonce = artifact.nonce;

    // Build the unsigned token
    const token: AuthorizationArtifactToken = {
      artifactId: artifact.artifactId,
      issuedAt,
      expiresAt,
      nonce,
      issuer: "ellul-gateway",
      audience: "ellul-shield",
      subject: artifact.subject,
      providerId: artifact.providerId,
      keyVersion: KEY_VERSION,
      signature: "",
    };

    // Sign over the deterministic payload (excludes signature field itself)
    const payload = JSON.stringify({
      artifactId: token.artifactId,
      issuedAt: token.issuedAt,
      expiresAt: token.expiresAt,
      nonce: token.nonce,
      issuer: token.issuer,
      audience: token.audience,
      subject: token.subject,
      providerId: token.providerId,
      keyVersion: token.keyVersion,
    });

    token.signature = createHmac("sha256", SIGNING_KEY)
      .update(payload)
      .digest("hex");

    return token;
  }

  /**
   * Validate a compact token.
   *
   * Verifies the HMAC signature, checks expiry, and confirms the
   * referenced artifact still exists and is valid.
   */
  validateToken(token: AuthorizationArtifactToken): { valid: boolean; error?: string } {
    // Recompute signature to verify integrity
    const payload = JSON.stringify({
      artifactId: token.artifactId,
      issuedAt: token.issuedAt,
      expiresAt: token.expiresAt,
      nonce: token.nonce,
      issuer: token.issuer,
      audience: token.audience,
      subject: token.subject,
      providerId: token.providerId,
      keyVersion: token.keyVersion,
    });

    const expectedSig = createHmac("sha256", SIGNING_KEY)
      .update(payload)
      .digest("hex");

    if (token.signature !== expectedSig) {
      return { valid: false, error: "Token signature mismatch" };
    }

    // Check key version
    if (token.keyVersion !== KEY_VERSION) {
      return { valid: false, error: `Unknown key version: ${token.keyVersion}` };
    }

    // Check token-level expiry (seconds since epoch)
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (token.expiresAt <= nowSeconds) {
      return { valid: false, error: "Token has expired" };
    }

    // Validate the underlying artifact is still good
    return this.validate(token.artifactId);
  }

  /**
   * Expire all artifacts past their TTL.
   *
   * Sweeps the in-memory store and transitions any active artifacts
   * whose expiresAt has passed to "expired" status. Returns the count
   * of newly expired artifacts.
   */
  expireStale(): number {
    const now = Date.now();
    let expiredCount = 0;

    for (const state of this.artifacts.values()) {
      if (state.record.status !== "active") continue;

      const expiresAtMs = new Date(state.record.expiresAt).getTime();
      if (expiresAtMs <= now) {
        state.record.status = "expired";
        state.record.updatedAt = new Date().toISOString();
        expiredCount++;
      }
    }

    return expiredCount;
  }

  /**
   * Get all active artifacts.
   *
   * Returns a snapshot of all artifacts with status "active".
   * Intended for debugging and admin inspection — not for
   * production authorization flow.
   */
  getActive(): AuthorizationArtifactRecord[] {
    const active: AuthorizationArtifactRecord[] = [];

    for (const state of this.artifacts.values()) {
      if (state.record.status === "active") {
        active.push(state.record);
      }
    }

    return active;
  }
}

export const toolAuthorization = new ToolAuthorizationService();
export { ToolAuthorizationService };
export type { MintParams, InMemoryArtifactState };
