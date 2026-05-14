// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Audit log entry shape — domain definition. The infrastructure layer
 * persists this; here we just describe the contract.
 */

export type ClaudeOatAuditEntryType =
  | "save"
  | "issue"
  | "redeem"
  | "report-401"
  | "probe"
  | "transition"
  | "revoke"
  | "tamper-detected";

export type ClaudeOatAuditActor =
  | "user"
  | "bridge"
  | "launcher"
  | "shield-probe"
  | "shield-internal";

export interface ClaudeOatAuditEntry {
  readonly seq: number;
  readonly ts: string;
  readonly type: ClaudeOatAuditEntryType;
  readonly actor: ClaudeOatAuditActor;
  readonly details: Record<string, unknown>;
  readonly prevHash: string;
  /** SHA-256(prevHash || JSON(entry-without-hash)). */
  readonly hash: string;
}

export interface AuditEntryDraft {
  readonly type: ClaudeOatAuditEntryType;
  readonly actor: ClaudeOatAuditActor;
  readonly details: Record<string, unknown>;
}
