// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * @ellul.ai/shield-proxy — Host-agnostic auth proxy engine
 *
 * Pure Node.js proxy that injects session + PoP headers.
 * Depends on IHostEnvironment for all host-specific concerns.
 */

export { AuthProxyEngine, type InternalRequestHandler } from './engine';
export {
  StreamingRedactionEngine,
  type SecretEntry,
  type RedactionMetrics,
  type ConfinementViolation,
} from './streaming-redaction';
export type {
  IHostEnvironment,
  AuthSession,
  ProjectConfig,
  GateApproval,
} from './ports';
export {
  signRequest,
  performMlKemBind,
  signDeviceChallenge,
  generateOperatorKeyPair,
  signOperatorAction,
} from './pop-signer';
export type {
  PopHmacKey,
  PopHeaders,
  OperatorKeyPair,
} from './pop-signer';
export { CliHost } from './cli-host';
export { StsManager } from './sts-manager';
