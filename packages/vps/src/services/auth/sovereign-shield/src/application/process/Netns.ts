// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Network Namespace Service
 *
 * TypeScript wrapper around /usr/local/bin/ellul-netns-helper.
 * Manages the lifecycle of shielded app namespaces:
 *   - Create namespace + veth pair
 *   - Apply nftables egress whitelist
 *   - Execute process inside namespace (network + mount isolation)
 *   - Destroy namespace + cleanup
 *   - Status queries
 *
 * All data passed to the helper via stdin pipe (NEVER CLI args)
 * to prevent ps aux from leaking secrets.
 */

import { spawn, spawnSync, ChildProcess } from 'child_process';
import { createRedactor } from '../audit/LogRedaction';
import { capabilities } from '@vps/shared/platform';

const HELPER = '/usr/local/bin/ellul-netns-helper';

// ── Types ──

export interface AllowedDestination {
  host: string;   // hostname or IP
  port: number;   // 0 = all ports
  protocol: 'tcp' | 'udp';
}

export interface ExecConfig {
  command: string;
  cwd: string;
  env: Record<string, string>;
  /** Relative paths from cwd that get private writable tmpfs mounts inside the namespace.
   *  Used for dev server build caches (.next/, node_modules/.vite/, etc.) so that
   *  source can be mounted R/O while the dev server can still write build artifacts. */
  writableDirs?: string[];
}

export interface ShieldedProcess {
  nsName: string;
  sandboxId: string;
  child: ChildProcess;
  startedAt: number;
}

export interface ShieldStatus {
  exists: boolean;
  alive: boolean;
  pidCount: number;
  ruleCount: number;
}

// ── Active shielded processes ──

const activeShields = new Map<string, ShieldedProcess>();

/** Convert app name to namespace name (max 15 chars for veth interface). */
export function toNsName(sandboxId: string): string {
  // shield- prefix (7 chars) + up to 8 chars of app name
  const cleaned = sandboxId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 8);
  return `shield-${cleaned}`;
}

// ── Log Store ──

interface LogEntry {
  timestamp: number;
  text: string;
  raw?: string;
}

class AppLogStore {
  private logs = new Map<string, LogEntry[]>();
  private maxEntries = 1000;

  append(sandboxId: string, redacted: string, raw?: string): void {
    if (!this.logs.has(sandboxId)) {
      this.logs.set(sandboxId, []);
    }
    const entries = this.logs.get(sandboxId)!;
    entries.push({ timestamp: Date.now(), text: redacted, raw });
    // Evict old entries
    if (entries.length > this.maxEntries) {
      entries.splice(0, entries.length - this.maxEntries);
    }
  }

  getRedacted(sandboxId: string, since?: number): string[] {
    const entries = this.logs.get(sandboxId) || [];
    return entries
      .filter(e => !since || e.timestamp > since)
      .map(e => e.text);
  }

  getRaw(sandboxId: string, since?: number): string[] {
    const entries = this.logs.get(sandboxId) || [];
    return entries
      .filter(e => !since || e.timestamp > since)
      .map(e => e.raw || e.text);
  }

  clear(sandboxId: string): void {
    this.logs.delete(sandboxId);
  }
}

export const logStore = new AppLogStore();

// ── Helper Execution ──

function runHelper(action: string, nsName: string, extraArgs: string[] = [], stdin?: string): { success: boolean; output: string } {
  const args = [HELPER, action, nsName, ...extraArgs];
  const result = spawnSync('sudo', args, {
    input: stdin,
    encoding: 'utf8',
    timeout: 30_000,
  });

  if (result.status !== 0) {
    const error = result.stderr || result.stdout || `Helper exited with code ${result.status}`;
    console.error(`[netns] ${action} ${nsName} failed:`, error);
    return { success: false, output: error };
  }

  return { success: true, output: result.stdout.trim() };
}

// ── Public API ──

/**
 * Create a shielded network namespace with veth pair.
 * IP scheme: 10.200.{port%256}.{1,2}/30
 */
export function createShieldedNamespace(sandboxId: string, port: number): { nsIp: string; hostIp: string } {
  if (!capabilities.namespaces) {
    return { nsIp: '127.0.0.1', hostIp: '127.0.0.1' };
  }

  const nsName = toNsName(sandboxId);
  const result = runHelper('create', nsName, [String(port)]);

  if (!result.success) {
    throw new Error(`Failed to create namespace ${nsName}: ${result.output}`);
  }

  try {
    const parsed = JSON.parse(result.output);
    if (!parsed.success) throw new Error(parsed.error || 'Unknown error');
    return { nsIp: parsed.nsIp, hostIp: parsed.hostIp };
  } catch (err: any) {
    throw new Error(`Failed to parse namespace creation result: ${err.message}`);
  }
}

/**
 * Apply nftables egress whitelist to a shielded namespace.
 * Destinations are passed via stdin pipe (not CLI args).
 */
export function applyWhitelist(sandboxId: string, destinations: AllowedDestination[]): void {
  if (!capabilities.nftables) return;

  const nsName = toNsName(sandboxId);
  const result = runHelper('apply-whitelist', nsName, [], JSON.stringify(destinations));

  if (!result.success) {
    throw new Error(`Failed to apply whitelist for ${nsName}: ${result.output}`);
  }

  try {
    const parsed = JSON.parse(result.output);
    if (!parsed.success) throw new Error(parsed.error || 'Unknown error');
    console.log(`[netns] Applied ${parsed.ruleCount} whitelist rules to ${nsName}`);
  } catch (err: any) {
    throw new Error(`Failed to parse whitelist result: ${err.message}`);
  }
}

/**
 * Execute a process inside a shielded namespace with:
 *   - Network namespace (nftables egress whitelist)
 *   - Mount namespace (read-only source, private /data, private /tmp)
 *
 * Secrets passed via stdin pipe (invisible to ps aux).
 * Returns a ShieldedProcess handle for lifecycle management.
 *
 * Stdout/stderr are captured through a trusted redaction pipe:
 * secret values are replaced with [REDACTED] before being stored
 * in the log store (accessible to the agent only in redacted form).
 */
export function execInNamespace(
  sandboxId: string,
  config: ExecConfig,
  secretValues: string[] = [],
): ShieldedProcess {
  const nsName = toNsName(sandboxId);
  const redact = createRedactor(secretValues);

  let child: ChildProcess;

  if (capabilities.namespaces) {
    child = spawn('sudo', [HELPER, 'exec', nsName], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin!.write(JSON.stringify(config));
    child.stdin!.end();
  } else {
    child = spawn('bash', ['-c', config.command], {
      cwd: config.cwd,
      env: { ...process.env, ...config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  child.stdout!.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    logStore.append(sandboxId, redact(text), text);
  });

  child.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    logStore.append(sandboxId, redact(text), text);
  });

  child.on('close', (code) => {
    console.log(`[netns] Process in ${nsName} exited with code ${code}`);
    activeShields.delete(sandboxId);
  });

  child.on('error', (err) => {
    console.error(`[netns] Process in ${nsName} error:`, err.message);
    activeShields.delete(sandboxId);
  });

  const shielded: ShieldedProcess = {
    nsName,
    sandboxId,
    child,
    startedAt: Date.now(),
  };

  activeShields.set(sandboxId, shielded);
  return shielded;
}

/**
 * Destroy a shielded namespace and all its resources.
 */
export function destroyNamespace(sandboxId: string): void {
  const nsName = toNsName(sandboxId);

  // Remove from active shields
  const existing = activeShields.get(sandboxId);
  if (existing?.child) {
    try { existing.child.kill('SIGTERM'); } catch {}
  }
  activeShields.delete(sandboxId);

  // Clean up logs
  logStore.clear(sandboxId);

  if (capabilities.namespaces) {
    const result = runHelper('destroy', nsName);
    if (!result.success) {
      console.warn(`[netns] Destroy ${nsName} warning:`, result.output);
    }
  }
}

/**
 * Get the status of a shielded namespace.
 */
export function getShieldStatus(sandboxId: string): ShieldStatus {
  if (!capabilities.namespaces) {
    const active = activeShields.has(sandboxId);
    return { exists: active, alive: active, pidCount: active ? 1 : 0, ruleCount: 0 };
  }

  const nsName = toNsName(sandboxId);
  const result = runHelper('status', nsName);

  if (!result.success) {
    return { exists: false, alive: false, pidCount: 0, ruleCount: 0 };
  }

  try {
    return JSON.parse(result.output);
  } catch {
    return { exists: false, alive: false, pidCount: 0, ruleCount: 0 };
  }
}

/**
 * Refresh a shielded namespace's firewall rules.
 * Re-resolves DNS for all whitelisted domains and re-applies nftables.
 * Handles CDN IP rotation (Stripe, Supabase, etc.).
 */
export function refreshShield(sandboxId: string, destinations: AllowedDestination[]): void {
  if (!capabilities.nftables) return;

  const nsName = toNsName(sandboxId);
  const status = getShieldStatus(sandboxId);
  if (!status.exists) return;

  applyWhitelist(sandboxId, destinations);
  console.log(`[netns] Refreshed firewall for ${nsName}`);
}

/**
 * Check if an app is currently shielded.
 */
export function isShielded(sandboxId: string): boolean {
  return activeShields.has(sandboxId);
}

/**
 * Get all active shielded app names.
 */
export function getActiveShieldedApps(): string[] {
  return Array.from(activeShields.keys());
}
