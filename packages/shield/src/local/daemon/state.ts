// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Daemon State — Types, constants, utilities, and shared helpers
 *
 * Extracted from the monolithic daemon/index.ts to provide a clean
 * foundation that all other daemon modules import from.
 */

import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline';

import { StreamingRedactionEngine, type SecretEntry } from '@ellul.ai/shield-proxy';
import type { OperatorKeyPair } from '@ellul.ai/shield-proxy';

import { getPeerCredentials } from '../infra/peercred';
import type { DerivedKeys } from '../crypto/index';
import { LocalProjectRegistry, type LocalRegisteredProject } from '../infra/project-registry';
import { LocalSecretStore } from '../secrets/index';
import { LocalGateManager } from '../gates/index';
import { LocalRuleStore } from '../guardrails/rule-store';
import { LocalLogger } from '../infra/logger';
import { AuditLogger } from '../infra/audit';
import type { ExecMode } from '../gates/capability-allowlist';

// ── Constants ──

export const CONFIG_DIR = path.join(process.env.HOME || '~', '.ellul');
export const SOCKET_PATH = path.join(CONFIG_DIR, 'daemon.sock');
export const PORT_FILE = path.join(CONFIG_DIR, 'proxy.port');
export const NONCE_FILE = path.join(CONFIG_DIR, 'daemon.nonce');
export const GUARDRAILS_DIR = path.join(CONFIG_DIR, 'guardrails');
export const LOGS_DIR = path.join(CONFIG_DIR, 'logs');

// ── Types ──

export interface LocalDaemonState {
  operatorKey: OperatorKeyPair;
  derivedKeys: DerivedKeys;
  registry: LocalProjectRegistry;
  cachedSecretEntries: SecretEntry[];
  secretStores: Map<string, LocalSecretStore>;
  gateManager: LocalGateManager;
  ruleStore: LocalRuleStore | null;
  logger: LocalLogger;
  audit: AuditLogger;
  execMode: ExecMode;
  server: http.Server;
  socketPath: string | null;
  port: number | null;
  nonce: string | null;
  rl: readline.Interface | null;
  activeRequests: Set<http.ServerResponse>;
  shuttingDown: boolean;
}

/** Per-route body size limits. */
export const BODY_LIMITS: Record<string, number> = {
  '/_local/secrets/import': 5 * 1024 * 1024,
  '/_local/exec/run': 4096,
  '/_local/exec/scan': 1024,
  '/_local/gates/request': 4096,
  '/_local/gates/approve': 4096,
  '/_local/gates/deny': 4096,
  '/_local/guardrails/propose': 16384,
  '/_local/secrets': 65536,
  default: 65536,
};

// ── Utilities ──

export function getBodyLimit(urlPath: string): number {
  for (const [route, limit] of Object.entries(BODY_LIMITS)) {
    if (route !== 'default' && urlPath.startsWith(route)) return limit;
  }
  return BODY_LIMITS.default;
}

export function readBody(req: http.IncomingMessage, maxSize = 65536): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) { req.destroy(); reject(new Error('Body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function jsonWithCorrelation(res: http.ServerResponse, status: number, body: unknown, correlationId: string): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Correlation-Id': correlationId });
  const out = typeof body === 'object' && body !== null
    ? { ...(body as Record<string, unknown>), correlationId }
    : { data: body, correlationId };
  res.end(JSON.stringify(out));
}

export function parseJson(buf: Buffer): unknown | null {
  try { return JSON.parse(buf.toString()); } catch { return null; }
}

export function parseUrl(urlPath: string): URL {
  return new URL(urlPath, 'http://localhost');
}

export function resolveRequestProject(
  req: http.IncomingMessage,
  body: { project?: string } | null | undefined,
  urlPath: string,
  defaultSlug: string | null,
): string | null {
  const verified = (req as unknown as { _verifiedProject?: string })._verifiedProject;
  if (verified) return verified;
  if (body?.project) return body.project;
  const url = parseUrl(urlPath);
  const fromQuery = url.searchParams.get('project');
  if (fromQuery) return fromQuery;
  return defaultSlug;
}

// ── Rate Limiter ──

export class RateLimiter {
  private counts = new Map<string, { count: number; resetAt: number }>();
  private maxPerSecond: number;

  constructor(maxPerSecond: number) { this.maxPerSecond = maxPerSecond; }

  check(key: string): boolean {
    const now = Date.now();
    const entry = this.counts.get(key);
    if (!entry || now >= entry.resetAt) {
      this.counts.set(key, { count: 1, resetAt: now + 1000 });
      return true;
    }
    entry.count++;
    return entry.count <= this.maxPerSecond;
  }
}

// ── Peer Credential Verification ──

export function verifyPeer(socket: net.Socket, logger: LocalLogger): boolean {
  const creds = getPeerCredentials(socket);
  if (creds) {
    if (creds.uid !== process.getuid!()) {
      logger.security('peer_rejected', `Rejected connection from UID ${creds.uid}`, {
        details: { expected: process.getuid!(), actual: creds.uid, pid: creds.pid },
      });
      return false;
    }
    return true;
  }
  return true;
}

export function verifyNonce(req: http.IncomingMessage, expectedNonce: string | null): boolean {
  if (!expectedNonce) return true;
  const header = req.headers['x-daemon-nonce'];
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(expectedNonce, 'utf8');
  const actual = Buffer.from(header, 'utf8');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

// ── Secret Store Resolution ──

export function getSecretStore(state: LocalDaemonState, projectSlug: string): LocalSecretStore | null {
  let store = state.secretStores.get(projectSlug);
  if (store) return store;

  const project = state.registry.getProject(projectSlug);
  if (!project) return null;

  const dbPath = path.join(project.directory, '.ellul', 'secrets.db');
  try {
    store = new LocalSecretStore(dbPath, state.derivedKeys.secretsEncKey);
    state.secretStores.set(projectSlug, store);
    return store;
  } catch {
    return null;
  }
}

export function reloadSecretEntries(state: LocalDaemonState): void {
  const allSecrets: SecretEntry[] = [];
  for (const project of state.registry.getAllProjects()) {
    const store = getSecretStore(state, project.projectSlug);
    if (store) {
      allSecrets.push(...store.getAllForRedaction());
    }
  }
  state.cachedSecretEntries = allSecrets;
  state.logger.info('redaction_loaded', `Cached ${allSecrets.length} secret entries for per-request redaction`);
}

export function createRedactionEngine(state: LocalDaemonState): StreamingRedactionEngine {
  return new StreamingRedactionEngine(state.cachedSecretEntries);
}
