// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * CLI Host — IHostEnvironment implementation for terminal/CLI users
 *
 * Bridges the pure proxy engine to OS-level APIs:
 * - OS keychain via spawnSync with argv arrays (no shell, no injection)
 * - Terminal prompts (stdin/stderr) for gate approval
 * - stderr for logging (stdout reserved for eval-able output)
 *
 * Designed for: Neovim + Claude Code, terminal workflows, CI/CD.
 * Same security model as VS Code adapter — sessions in encrypted storage,
 * secrets in RAM only, biometric/passkey gate approval.
 */

import { spawnSync } from 'child_process';
import * as readline from 'readline';
import type { IHostEnvironment, AuthSession, ProjectConfig, GateApproval } from './ports';
import type { PopHmacKey } from './pop-signer';

const KEYCHAIN_SERVICE = 'ai.ellul.sovereign-ide';
const CONFIG_DIR = `${process.env.HOME}/.ellul`;

// ── OS Keychain Abstraction ──
// All calls use spawnSync with argv arrays — arguments are never interpreted
// by a shell, so account names and values cannot trigger injection.

function keychainGet(account: string): string | null {
  if (process.platform === 'darwin') {
    const result = spawnSync('security', [
      'find-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', account,
      '-w',
    ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return result.status === 0 ? result.stdout.trim() : null;
  }

  // Linux: secret-tool
  const result = spawnSync('secret-tool', [
    'lookup',
    'service', KEYCHAIN_SERVICE,
    'account', account,
  ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  return result.status === 0 ? result.stdout.trim() : null;
}

function keychainSet(account: string, value: string): void {
  if (process.platform === 'darwin') {
    // Delete first (update not supported atomically)
    spawnSync('security', [
      'delete-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', account,
    ], { stdio: 'pipe' });

    const result = spawnSync('security', [
      'add-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', account,
      '-w', value,
    ], { stdio: 'pipe' });

    if (result.status !== 0) {
      throw new Error(`Keychain write failed: ${result.stderr?.toString() ?? `exit ${result.status}`}`);
    }
    return;
  }

  // Linux: secret-tool reads the secret from stdin
  const result = spawnSync('secret-tool', [
    'store',
    '--label', `ellul session: ${account}`,
    'service', KEYCHAIN_SERVICE,
    'account', account,
  ], { input: value, stdio: ['pipe', 'pipe', 'pipe'] });

  if (result.status !== 0) {
    throw new Error(`secret-tool store failed: ${result.stderr?.toString() ?? `exit ${result.status}`}`);
  }
}

function keychainDelete(account: string): void {
  if (process.platform === 'darwin') {
    spawnSync('security', [
      'delete-generic-password',
      '-s', KEYCHAIN_SERVICE,
      '-a', account,
    ], { stdio: 'pipe' });
    return;
  }

  spawnSync('secret-tool', [
    'clear',
    'service', KEYCHAIN_SERVICE,
    'account', account,
  ], { stdio: 'pipe' });
}

// ── Device Credential Storage (long-lived, survives session expiry) ──

export interface StoredDeviceCredential {
  deviceId: string;
  /** ML-KEM-derived HMAC key for device challenge signing */
  popHmacKeyBase64: string;
  trustExpiresAt: number;
  domain: string;
}

// ── Session Storage (short-lived, disposable) ──

export interface StoredCliSession {
  sessionId: string;
  tier: 'standard' | 'web_locked';
  domain: string;
  expiresAt: number;
  /** ML-KEM-derived HMAC key for session PoP */
  popHmacKeyBase64?: string;
}

// ── Local Project State (.ellul/project.json in cwd) ──

interface LocalProjectState {
  projectId?: string;
  projectSlug?: string;
  projectName?: string;
}

function readLocalProject(): LocalProjectState {
  try {
    const fs = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    return JSON.parse(fs.readFileSync(join(process.cwd(), '.ellul', 'project.json'), 'utf8'));
  } catch {
    return {};
  }
}

// ── Global CLI Config (~/.ellul/config.json — domain only, no project binding) ──

interface GlobalConfig {
  domain?: string;
}

function readGlobalConfig(): GlobalConfig {
  try {
    const fs = require('fs') as typeof import('fs');
    return JSON.parse(fs.readFileSync(`${CONFIG_DIR}/config.json`, 'utf8'));
  } catch {
    return {};
  }
}

// ── CLI Host Implementation ──

export class CliHost implements IHostEnvironment {
  private domain: string;
  private projectName: string | null;

  constructor(opts?: { domain?: string; projectName?: string }) {
    const globalConfig = readGlobalConfig();
    const localProject = readLocalProject();
    this.domain = opts?.domain || globalConfig.domain || '';
    this.projectName = opts?.projectName || localProject.projectSlug || null;
  }

  getDomain(): string {
    return this.domain;
  }

  async getAuthSession(): Promise<AuthSession | null> {
    if (!this.domain) return null;

    const raw = keychainGet(`session.${this.domain}`);
    if (!raw) return null;

    try {
      const session: StoredCliSession = JSON.parse(raw);
      if (session.expiresAt < Date.now()) {
        keychainDelete(`session.${this.domain}`);
        return null;
      }

      // PoP key: device credential is authoritative, fall back to session.
      const deviceCred = await this.getDeviceCredential();
      const hmacKeyBase64 = deviceCred?.popHmacKeyBase64 ?? session.popHmacKeyBase64;

      return {
        sessionId: session.sessionId,
        tier: session.tier,
        domain: session.domain,
        popHmacKey: hmacKeyBase64 ? { hmacKeyBase64 } : undefined,
      };
    } catch {
      return null;
    }
  }

  notifyUser(message: string, level: 'info' | 'warning' | 'error' = 'info'): void {
    const prefix = level === 'error' ? '\x1b[31m[error]\x1b[0m'
      : level === 'warning' ? '\x1b[33m[warn]\x1b[0m'
      : '\x1b[36m[info]\x1b[0m';
    process.stderr.write(`${prefix} ${message}\n`);
  }

  async requestGateApproval(gate: string, reason: string): Promise<GateApproval> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    return new Promise((resolve) => {
      process.stderr.write(`\n\x1b[33m[gate]\x1b[0m ${gate}: ${reason}\n`);
      process.stderr.write('  1) Approve (5 min)\n');
      process.stderr.write('  2) Approve Session\n');
      process.stderr.write('  3) Always Allow\n');
      process.stderr.write('  4) Deny\n');
      rl.question('  Choice [1-4]: ', (answer) => {
        rl.close();
        switch (answer.trim()) {
          case '1': resolve({ action: 'grant_timed' }); break;
          case '2': resolve({ action: 'grant_session' }); break;
          case '3': resolve({ action: 'grant_always' }); break;
          default: resolve({ action: 'deny' }); break;
        }
      });
    });
  }

  getProjectConfig(): ProjectConfig | null {
    if (!this.projectName || !this.domain) return null;
    return { projectName: this.projectName, domain: this.domain };
  }

  log(message: string): void {
    process.stderr.write(`${message}\n`);
  }

  // ── Session management (for proxy-daemon and connect flow) ──

  async storeSession(session: StoredCliSession): Promise<void> {
    keychainSet(`session.${session.domain}`, JSON.stringify(session));
    this.domain = session.domain;
  }

  async deleteSession(): Promise<void> {
    if (this.domain) {
      keychainDelete(`session.${this.domain}`);
    }
  }

  // ── Device credential management (long-lived, survives session expiry) ──

  async getDeviceCredential(): Promise<StoredDeviceCredential | null> {
    if (!this.domain) return null;

    const raw = keychainGet(`device.${this.domain}`);
    if (!raw) return null;

    try {
      return JSON.parse(raw) as StoredDeviceCredential;
    } catch {
      return null;
    }
  }

  async storeDeviceCredential(cred: StoredDeviceCredential): Promise<void> {
    keychainSet(`device.${cred.domain}`, JSON.stringify(cred));
  }

  async deleteDeviceCredential(): Promise<void> {
    if (this.domain) {
      keychainDelete(`device.${this.domain}`);
    }
  }
}
