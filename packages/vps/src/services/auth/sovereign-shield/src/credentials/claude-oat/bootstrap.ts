// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Composition root for the Claude OAT credential subsystem.
 *
 * Wires concrete infrastructure adapters into the application layer and
 * returns a "module" object — a single namespaced surface that the HTTP
 * routes and probe loop call into. This is the dependency-injection
 * boundary; the rest of shield references only this module and the
 * shared protocol types.
 *
 * Tests can build their own ClaudeOatPorts (in-memory store + audit,
 * mocked clock + RNG) and call buildClaudeOatModule directly without
 * touching the filesystem.
 */

import type { ProbeRecord, SafePeekResponse } from "@vps/shared/claude-oat";
import { saveToken, type SaveTokenInput, type SaveTokenResult } from "./application/save-token";
import { peek } from "./application/peek";
import { issueOat, type IssueOatInput, type IssueOatResult } from "./application/issue-oat";
import { redeemOat, type RedeemOatResult } from "./application/redeem-oat";
import { reportUnauth, type ReportUnauthInput, type ReportUnauthResult } from "./application/report-unauth";
import { revokeOat, type RevokeOatInput, type RevokeOatResult } from "./application/revoke-oat";
import { recordProbeOutcome } from "./application/record-probe-outcome";
import { getTokenForProbe } from "./application/get-token-for-probe";
import type { ClaudeOatPorts } from "./application/ports";

import { AesGcmCipher } from "./infrastructure/aes-gcm-cipher";
import { FilesystemStoreRepository } from "./infrastructure/filesystem-store";
import { JsonlAuditLog } from "./infrastructure/jsonl-audit-log";
import { InMemoryIssuanceStore } from "./infrastructure/in-memory-issuance";
import {
  CryptoRandomBytes,
  SystemClock,
} from "./infrastructure/system-clock";

export interface ClaudeOatModuleConfig {
  readonly dataDir: string;
  readonly serverIdPath: string;
}

/**
 * The application-layer surface exposed to interface adapters (HTTP,
 * probe loop). Each method delegates to a single command/query handler.
 */
export interface ClaudeOatModule {
  saveToken(input: SaveTokenInput): SaveTokenResult;
  peek(): SafePeekResponse;
  issueOat(input: IssueOatInput): IssueOatResult;
  redeemOat(input: { issuanceToken: string }): RedeemOatResult;
  reportUnauth(input: ReportUnauthInput): ReportUnauthResult;
  revokeOat(input: RevokeOatInput): RevokeOatResult;
  recordProbeOutcome(record: ProbeRecord): void;
  /** Probe-loop only: get the active token plaintext or null. */
  getTokenForProbe(): string | null;
  /** Probe-loop only: read-and-clear immediate-probe flag. */
  consumeImmediateProbeFlag(): boolean;
  /** Probe-loop only: sweep expired issuance tokens. */
  sweepExpiredIssuances(): void;
}

export function buildClaudeOatPorts(
  config: ClaudeOatModuleConfig,
): ClaudeOatPorts {
  const storePath = `${config.dataDir}/claude-oat.json`;
  const auditPath = `${config.dataDir}/claude-oat.audit.jsonl`;
  const wrapSecretPath = `${config.dataDir}/.claude-oat-wrap-secret`;

  const clock = new SystemClock();
  const random = new CryptoRandomBytes();
  const cipher = new AesGcmCipher({
    wrapSecretPath,
    serverIdPath: config.serverIdPath,
    dataDir: config.dataDir,
  });
  const store = new FilesystemStoreRepository(storePath, config.dataDir);
  const audit = new JsonlAuditLog(auditPath, config.dataDir, () => clock.iso());
  const issuance = new InMemoryIssuanceStore();

  return { store, audit, cipher, issuance, clock, random };
}

export function buildClaudeOatModule(ports: ClaudeOatPorts): ClaudeOatModule {
  let immediateProbeRequested = false;
  const signalImmediateProbe = (): void => {
    immediateProbeRequested = true;
  };

  // Resume audit chain head and seed store on first call.
  ports.audit.resume();
  ports.store.load();

  return {
    saveToken: (input) => saveToken(ports, input),
    peek: () => peek(ports),
    issueOat: (input) => issueOat(ports, input),
    redeemOat: (input) => redeemOat(ports, input),
    reportUnauth: (input) => reportUnauth(ports, input, signalImmediateProbe),
    revokeOat: (input) => revokeOat(ports, input),
    recordProbeOutcome: (record) => recordProbeOutcome(ports, record),
    getTokenForProbe: () => getTokenForProbe(ports),
    consumeImmediateProbeFlag: () => {
      const v = immediateProbeRequested;
      immediateProbeRequested = false;
      return v;
    },
    sweepExpiredIssuances: () => ports.issuance.sweepExpired(ports.clock.now()),
  };
}
