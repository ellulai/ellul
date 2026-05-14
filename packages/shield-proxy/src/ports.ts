// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Host Environment Ports — Dependency Injection interfaces
 *
 * These interfaces define the contract between the pure Node.js proxy engine
 * and its host environment (VS Code extension, CLI daemon, etc.).
 *
 * The proxy engine depends ONLY on these interfaces — never on vscode,
 * OS keychain, or any host-specific API directly.
 */

import type { PopHmacKey } from './pop-signer';

/** Auth session data needed by the proxy to sign requests. */
export interface AuthSession {
  sessionId: string;
  tier: 'standard' | 'web_locked';
  domain: string;
  /** ML-KEM-derived HMAC key for PoP request signing */
  popHmacKey?: PopHmacKey;
}

/** Current project routing context. */
export interface ProjectConfig {
  projectName: string;
  domain: string;
}

/** User's response to a gate approval prompt. */
export interface GateApproval {
  action: 'grant_timed' | 'grant_session' | 'grant_always' | 'deny';
}

/**
 * IHostEnvironment — the abstraction the proxy engine relies on.
 *
 * Each host (VS Code, CLI, etc.) implements this interface to provide
 * session retrieval, user notifications, biometric approval, and
 * project config without the engine knowing HOW any of it works.
 */
export interface IHostEnvironment {
  /** Retrieve current auth session (from SecretStorage, OS keychain, etc.) */
  getAuthSession(): Promise<AuthSession | null>;

  /** Show a notification to the user (VS Code toast, macOS notification, terminal print) */
  notifyUser(message: string, level?: 'info' | 'warning' | 'error'): void;

  /** Request biometric/passkey approval for a gate operation */
  requestGateApproval(gate: string, reason: string): Promise<GateApproval>;

  /** Get current project config (from workspaceState, config file, etc.) */
  getProjectConfig(): ProjectConfig | null;

  /** Log a message (VS Code output channel, stderr, etc.) */
  log(message: string): void;
}
