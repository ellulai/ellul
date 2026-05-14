// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * @ellul.ai/shield local tier — barrel exports
 *
 * Single stable import point for the local governance daemon and its subsystems.
 * CLI commands and external consumers import from here rather than reaching
 * into internal module paths.
 */

// Daemon
export { startLocalDaemon } from './daemon/index';
export type { LocalDaemonState } from './daemon/state';

// Crypto
export {
  initMasterSecret,
  deriveKeys,
  signLocalSts,
  verifyLocalSts,
  computeWorkspaceFingerprint,
  verifyOperatorSignature,
  gateApprovePayload,
  gateDenyPayload,
  ruleApprovePayload,
  ruleDenyPayload,
  ruleCreatePayload,
  ruleTogglePayload,
  ruleDeletePayload,
  policySetPayload,
  secretRevealPayload,
} from './crypto/index';
export type { DerivedKeys, LocalStsPayload } from './crypto/index';

// Secrets
export { LocalSecretStore } from './secrets/index';

// Gates
export { LocalGateManager } from './gates/index';
export type { GatePolicy, GateState, GateRequest } from './gates/index';
export { matchCapability, isAllowlisted, getRequiredGate, getAllCapabilities } from './gates/capability-allowlist';
export type { GateType, ExecMode, Capability } from './gates/capability-allowlist';

// Guardrails
export { LocalRuleStore } from './guardrails/rule-store';
export type { RuleRow, ProposalRow } from './guardrails/rule-store';
export { scanWorkspace, resolveGuardrailBinary, verifyAndRestoreIntegrity } from './guardrails/scanner';
export { recordStrike, clearStrikes, isHardStopped, MAX_STRIKES } from './guardrails/strikes';

// Infrastructure
export { LocalLogger } from './infra/logger';
export { AuditLogger } from './infra/audit';
export { loadConfig, loadMergedConfig } from './infra/config';
export { LocalProjectRegistry } from './infra/project-registry';
export { getPeerCredentials, getAvailableTier } from './infra/peercred';
