// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Interactive REPL — control plane for the ellul CLI daemon. HTTP via local auth proxy;
// all output to stderr (stdout reserved for eval-able output like `ellul env`).

import * as crypto from 'crypto';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { AuthProxyEngine } from '@ellul.ai/shield-proxy';
import type { StsManager } from '@ellul.ai/shield-proxy';
import { signOperatorAction } from '@ellul.ai/shield-proxy';
import type { OperatorKeyPair } from '@ellul.ai/shield-proxy';
import type { CliHost } from '@ellul.ai/shield-proxy/cli-host';
import { parseEnvContent, detectEnvironmentFromFilename, isEnvFile } from '../shared/env-parser';
import { fetchPublicKey, encryptAndUploadBulk } from './cli-crypto';
import { syncAllInstructionFiles } from './instructions';
import { openBrowser, createCallbackServer } from './browser-callback';

// ── Types ──

export interface ProjectInfo {
  projectSlug: string;
  projectName: string;
  directory: string;
  connected: boolean;
}

export interface ReplDeps {
  engine: AuthProxyEngine;
  stsManager: StsManager;
  host: CliHost;
  getProjects: () => ProjectInfo[];
  getDefaultProject: () => string | null;
  domain: string;
  /** SLH-DSA-SHA2-128s operator key (volatile RAM only) — signs gate control operations. */
  operatorKey: OperatorKeyPair;
}

export interface GateRequestEvent {
  requestId: string;
  gate: string;
  reason: string;
  project: string;
}

interface ReplState {
  rl: readline.Interface;
  deps: ReplDeps;
  /** True when handling a gate event — suppresses the normal prompt. */
  gatePromptActive: boolean;
  /** Explicitly selected active project (overrides single-project default). */
  activeProjectSlug: string | null;
}

// ── ANSI Colors ──
// Brand: #7c3aed (purple) → ANSI 256-color 135

const PURPLE = '\x1b[38;5;135m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const WHITE = '\x1b[37m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// ── Branding ──

const LOGO = `  ${PURPLE}${BOLD}ellul${RESET}${DIM}.${RESET}${PURPLE}${BOLD}ai${RESET}`;

const VERSION = '0.1.0';

// ── Output helpers (all to stderr) ──

function write(msg: string): void {
  process.stderr.write(msg);
}

function writeLn(msg: string = ''): void {
  process.stderr.write(msg + '\n');
}

function info(msg: string): void {
  writeLn(`${CYAN}${msg}${RESET}`);
}

function success(msg: string): void {
  writeLn(`${GREEN}${msg}${RESET}`);
}

function warn(msg: string): void {
  writeLn(`${YELLOW}${msg}${RESET}`);
}

function error(msg: string): void {
  writeLn(`${RED}${msg}${RESET}`);
}

// ── Duration parsing ──

function parseDuration(input: string): number | null {
  const match = input.match(/^(\d+)(s|m|h)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    default: return null;
  }
}

function formatDuration(ms: number): string {
  if (ms <= 0) return 'expired';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── Table rendering ──

function renderTable(headers: string[], rows: string[][]): void {
  const colWidths = headers.map((h, i) => {
    let max = h.length;
    for (const row of rows) {
      if (row[i] && row[i].length > max) max = row[i].length;
    }
    return max;
  });

  const pad = (str: string, width: number) => str + ' '.repeat(Math.max(0, width - str.length));

  // Header
  writeLn('  ' + headers.map((h, i) => `${BOLD}${pad(h, colWidths[i])}${RESET}`).join('  '));
  // Separator
  writeLn('  ' + colWidths.map(w => '\u2500'.repeat(w)).join('  '));
  // Rows
  for (const row of rows) {
    writeLn('  ' + row.map((cell, i) => pad(cell || '', colWidths[i])).join('  '));
  }
}

// ── Project resolution ──

// Set once in startRepl(); handlers mutate activeProjectSlug in place, never reassign.
let _replState: ReplState | null = null;

function resolveProject(deps: ReplDeps, explicit?: string): string | null {
  if (explicit) return explicit;

  const projects = deps.getProjects();

  // Active project from /project-switch takes priority
  if (_replState?.activeProjectSlug) {
    if (projects.some(p => p.projectSlug === _replState!.activeProjectSlug)) {
      return _replState.activeProjectSlug;
    }
    // Active project was removed — clear stale ref
    _replState.activeProjectSlug = null;
  }

  if (projects.length === 1) return projects[0].projectSlug;
  const defaultProject = deps.getDefaultProject();
  if (defaultProject) return defaultProject;
  if (projects.length === 0) {
    error('No projects registered. Run `ellul init` in a project directory.');
  } else {
    error('Multiple projects — use /project-switch or specify: /command <project>');
    for (const p of projects) {
      writeLn(`  ${p.projectName} [${p.projectSlug}] (${p.directory})`);
    }
  }
  return null;
}

// ── Proxy fetch helper ──

async function proxyFetch(
  engine: AuthProxyEngine,
  path: string,
  opts?: RequestInit,
): Promise<Response> {
  const url = `http://127.0.0.1:${engine.getPort()}${path}`;
  return fetch(url, opts);
}

// ── Command handlers ──

interface GateInfo {
  gate: string;
  status: string;
  expiresAt?: number | null;
  policy?: string;
}

async function fetchGateData(deps: ReplDeps, project: string): Promise<GateInfo[] | null> {
  try {
    const res = await proxyFetch(deps.engine, `/_auth/gates/active?project=${encodeURIComponent(project)}`);
    if (!res.ok) {
      error(`Failed to fetch gates: ${res.status} ${await res.text().catch(() => '')}`);
      return null;
    }
    const data = await res.json() as { gates?: GateInfo[] };
    return data.gates ?? [];
  } catch (err) {
    error(`Failed to fetch gates: ${err}`);
    return null;
  }
}

// ── Shared helpers for interactive commands ──

// ── Modal Prompt ──
// All interactive prompts go through the main readline to avoid
// multiple readline interfaces fighting for stdin.

let modalRl: readline.Interface | null = null;

function modalQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  modalRl = rl;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      modalRl = null;
      resolve(answer.trim());
    });
  });
}

function formatPolicy(policy: string): string {
  if (policy === 'never') return `${RED}deny${RESET}`;
  if (policy === 'allow_always') return `${GREEN}allow_always${RESET}`;
  if (policy === 'allow_session') return `${CYAN}allow_session${RESET}`;
  return `${DIM}ask${RESET}`;
}

function formatScopeStatus(g: GateInfo): string {
  if (g.status === 'open') {
    const ttl = g.expiresAt ? ` ${DIM}${formatDuration(g.expiresAt - Date.now())}${RESET}` : '';
    return `${GREEN}\u25cf open${RESET}${ttl}`;
  }
  return `${DIM}\u25cb closed${RESET}`;
}

// ── Flat scope commands ──

async function cmdListScopes(deps: ReplDeps, args: string[]): Promise<void> {
  const project = resolveProject(deps, args[0]);
  if (!project) return;

  const gates = await fetchGateData(deps, project);
  if (!gates || gates.length === 0) return;

  writeLn();
  writeLn(`  ${PURPLE}${BOLD}Scopes${RESET}  ${DIM}${project}${RESET}`);
  writeLn(`  ${'─'.repeat(40)}`);

  const maxLen = Math.max(...gates.map(g => g.gate.length));
  for (const g of gates) {
    writeLn(`  ${g.gate.padEnd(maxLen)}  ${formatScopeStatus(g)}`);
  }
  writeLn();
}

async function cmdEnableScope(deps: ReplDeps, args: string[]): Promise<void> {
  let gate: string;
  let duration: string | undefined;

  const projects = deps.getProjects();
  if (projects.length === 1 && args.length >= 1) {
    gate = args[0]!;
    duration = args[1];
  } else if (args.length >= 2) {
    gate = args[1]!;
    duration = args[2];
  } else {
    error('Usage: /enable-scope <gate> [duration]');
    return;
  }

  const project = resolveProject(deps, projects.length === 1 ? undefined : args[0]);
  if (!project) return;

  const ttlMs = parseDuration(duration || '5m');
  if (ttlMs === null) {
    error(`Invalid duration: ${duration}`);
    return;
  }

  const { signature: operatorSignature, timestamp: operatorTimestamp } =
    await signOperatorAction(deps.operatorKey, `gate-respond|DIRECT_GRANT|grant_timed`);

  try {
    const res = await proxyFetch(deps.engine, '/_auth/gates/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, gate, action: 'grant_timed', ttlMs, operatorSignature, operatorTimestamp }),
    });
    if (res.ok) {
      success(`  ${gate} enabled (${formatDuration(ttlMs)}).`);
    } else {
      error(`  Failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
  } catch (err) {
    error(`  Failed: ${err}`);
  }
}

async function cmdDenyScope(deps: ReplDeps, args: string[]): Promise<void> {
  let gate: string;

  const projects = deps.getProjects();
  if (projects.length === 1 && args.length >= 1) {
    gate = args[0]!;
  } else if (args.length >= 2) {
    gate = args[1]!;
  } else {
    error('Usage: /deny-scope <gate>');
    return;
  }

  const project = resolveProject(deps, projects.length === 1 ? undefined : args[0]);
  if (!project) return;

  const { signature: operatorSignature, timestamp: operatorTimestamp } =
    await signOperatorAction(deps.operatorKey, `gate-revoke|${gate}|${project}`);

  try {
    const res = await proxyFetch(deps.engine, '/_auth/gates/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, gate, operatorSignature, operatorTimestamp }),
    });
    if (res.ok) {
      success(`  ${gate} denied.`);
    } else {
      error(`  Failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
  } catch (err) {
    error(`  Failed: ${err}`);
  }
}

// ── Flat policy commands ──

async function cmdListPolicies(deps: ReplDeps, args: string[]): Promise<void> {
  const project = resolveProject(deps, args[0]);
  if (!project) return;

  const gates = await fetchGateData(deps, project);
  if (!gates || gates.length === 0) return;

  writeLn();
  writeLn(`  ${PURPLE}${BOLD}Policies${RESET}  ${DIM}${project}${RESET}`);
  writeLn(`  ${'─'.repeat(40)}`);

  const maxLen = Math.max(...gates.map(g => g.gate.length));
  for (const g of gates) {
    writeLn(`  ${g.gate.padEnd(maxLen)}  ${formatPolicy(g.policy ?? 'ask')}`);
  }
  writeLn();
}

async function cmdSetPolicy(deps: ReplDeps, args: string[]): Promise<void> {
  let gate: string;
  let policy: string;

  const projects = deps.getProjects();
  if (projects.length === 1 && args.length >= 2) {
    gate = args[0]!;
    policy = args[1]!;
  } else if (args.length >= 3) {
    gate = args[1]!;
    policy = args[2]!;
  } else {
    error('Usage: /set-policy <gate> <ask|allow_always|deny>');
    return;
  }

  const project = resolveProject(deps, projects.length === 1 ? undefined : args[0]);
  if (!project) return;

  // Normalize user-friendly "deny" to internal "never"
  const normalizedPolicy = policy === 'deny' ? 'never' : policy;
  const validPolicies = ['ask', 'allow_always', 'never'];
  if (!validPolicies.includes(normalizedPolicy)) {
    error(`Invalid policy: ${policy}. Must be: ask, allow_always, deny`);
    return;
  }

  const { signature: operatorSignature, timestamp: operatorTimestamp } =
    await signOperatorAction(deps.operatorKey, `gate-permission|${gate}|${project}|${normalizedPolicy}`);

  try {
    const res = await proxyFetch(deps.engine, '/_auth/gates/permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, gate, policy: normalizedPolicy, operatorSignature, operatorTimestamp }),
    });
    if (res.ok) {
      success(`  ${gate} set to ${normalizedPolicy === 'never' ? 'deny' : normalizedPolicy}.`);
    } else {
      error(`  Failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
  } catch (err) {
    error(`  Failed: ${err}`);
  }
}

async function cmdRmPolicy(deps: ReplDeps, args: string[]): Promise<void> {
  let gate: string;

  const projects = deps.getProjects();
  if (projects.length === 1 && args.length >= 1) {
    gate = args[0]!;
  } else if (args.length >= 2) {
    gate = args[1]!;
  } else {
    error('Usage: /rm-policy <gate>');
    return;
  }

  const project = resolveProject(deps, projects.length === 1 ? undefined : args[0]);
  if (!project) return;

  // Reset to 'ask' (the default — removes the custom policy)
  const { signature: operatorSignature, timestamp: operatorTimestamp } =
    await signOperatorAction(deps.operatorKey, `gate-permission|${gate}|${project}|ask`);

  try {
    const res = await proxyFetch(deps.engine, '/_auth/gates/permissions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, gate, policy: 'ask', operatorSignature, operatorTimestamp }),
    });
    if (res.ok) {
      success(`  ${gate} reset to ask (default).`);
    } else {
      error(`  Failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
  } catch (err) {
    error(`  Failed: ${err}`);
  }
}

const ALL_GATE_TYPES = ['logs', 'env', 'db_read', 'db_write', 'db_migrate', 'git', 'deploy', 'exec'];

// ── Secret paste helpers ──

function maskValue(value: string): string {
  if (value.length <= 6) return '*'.repeat(value.length); // fully mask short secrets
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

// Special case: multiline input requires a temporary readline because Ctrl+D
// (EOF) triggers the 'close' event, which would kill the main readline.
// The caller MUST pause the main rl before calling this.
function readMultilineInput(): Promise<string> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    const tmpRl = readline.createInterface({ input: process.stdin, output: process.stderr });
    tmpRl.on('line', (line) => lines.push(line));
    tmpRl.on('close', () => {
      // Wipe plaintext paste from terminal scrollback immediately.
      // Move cursor up N+1 lines (pasted lines + ^D line),
      // then clear from cursor to end of screen.
      const linesToClear = lines.length + 1;
      process.stderr.write(`\x1b[${linesToClear}A\x1b[J`);
      resolve(lines.join('\n'));
    });
  });
}

async function cmdSecretsPaste(deps: ReplDeps, project: string, mainRl: readline.Interface): Promise<void> {
  writeLn();
  info('Paste KEY=VALUE pairs (one per line). Ctrl+D when done.');
  writeLn();

  // Pause main REPL, read paste input
  mainRl.pause();
  const rawInput = await readMultilineInput();

  if (!rawInput.trim()) {
    warn('No input received.');
    mainRl.resume();
    return;
  }

  // Parse with production-grade env parser (handles quotes, multiline, export prefix, etc.)
  const result = parseEnvContent(rawInput);

  // Show warnings for skipped lines
  for (const w of result.warnings) {
    warn(w);
  }

  if (result.entries.length === 0) {
    error('No valid secrets detected.');
    mainRl.resume();
    return;
  }

  // Preview with masked values
  writeLn();
  info(`${result.entries.length} secret${result.entries.length === 1 ? '' : 's'} detected:`);
  const maxKeyLen = Math.max(...result.entries.map(e => e.key.length));
  for (const entry of result.entries) {
    const paddedKey = entry.key.padEnd(maxKeyLen);
    writeLn(`  ${paddedKey}  = ${DIM}${maskValue(entry.value)}${RESET}`);
  }
  writeLn();

  // Confirm before upload (default No — enterprise safety)
  // Resume main rl briefly for the confirm prompt, then re-pause if needed
  mainRl.resume();
  const answer = (await modalQuestion(mainRl, `  Upload to ${CYAN}${project}${RESET}? [y/N]: `)).toLowerCase();
  mainRl.pause();

  if (answer !== 'y' && answer !== 'yes') {
    warn('Aborted — no secrets uploaded.');
    mainRl.resume();
    return;
  }

  // Encrypt and upload
  try {
    const proxyPort = deps.engine.getPort();
    info('Encrypting secrets...');
    const publicKey = await fetchPublicKey(proxyPort);
    const entries = result.entries.map(e => ({ key: e.key, value: e.value }));
    const count = await encryptAndUploadBulk(proxyPort, publicKey, entries, project);
    success(`${count} production secret${count === 1 ? '' : 's'} uploaded for ${project}.`);
  } catch (err) {
    error(`Upload failed: ${err}`);
  }

  mainRl.resume();
}

async function cmdLockdown(deps: ReplDeps, args: string[]): Promise<void> {
  const isOff = args[0]?.toLowerCase() === 'off';
  const policy = isOff ? 'ask' : 'never';

  const project = resolveProject(deps, isOff ? args[1] : args[0]);
  if (!project) return;

  // Fire all 8 gate types in parallel (each individually operator-signed)
  const results = await Promise.all(ALL_GATE_TYPES.map(async (gate) => {
    const { signature: operatorSignature, timestamp: operatorTimestamp } =
      await signOperatorAction(deps.operatorKey, `gate-permission|${gate}|${project}|${policy}`);
    try {
      const res = await proxyFetch(deps.engine, '/_auth/gates/permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, gate, policy, operatorSignature, operatorTimestamp }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }));
  const failed = results.filter(ok => !ok).length;

  if (failed > 0) {
    error(`${failed} gate(s) failed to update.`);
  }

  if (isOff) {
    success(`All scopes reset to ask for ${project}.`);
  } else {
    success(`All scopes set to deny for ${project}.`);
    writeLn(`  ${DIM}Use /policy <gate> <value> to selectively grant access.${RESET}`);
  }
}

function cmdVault(deps: ReplDeps, args: string[]): void {
  const project = resolveProject(deps, args[0]);
  const baseUrl = `http://127.0.0.1:${deps.engine.getPort()}/_vault`;
  const url = project ? `${baseUrl}?project=${encodeURIComponent(project)}` : baseUrl;

  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawnSync(cmd, [url], { stdio: 'pipe' });
  info(`Opened vault in browser.`);
}

async function cmdSecrets(deps: ReplDeps, args: string[], rl: readline.Interface): Promise<void> {
  if (args.length === 0) {
    error('Usage: /secrets, /set-secret, /paste-secrets, /rm-secret, /import-secrets');
    return;
  }

  const subcommand = args[0];

  switch (subcommand) {
    case 'list': {
      const project = resolveProject(deps, args[1]);
      if (!project) return;

      try {
        const res = await proxyFetch(deps.engine, `/_auth/secrets/list?app=${encodeURIComponent(project)}`);
        if (!res.ok) {
          error(`Failed to list secrets: ${res.status} ${await res.text().catch(() => '')}`);
          return;
        }

        const data = await res.json() as { keys?: string[] };
        const keys = data.keys ?? [];
        if (keys.length === 0) {
          info(`No secrets for ${project}.`);
          return;
        }

        writeLn();
        info(`Secrets for ${project}:`);
        for (const key of keys) {
          writeLn(`  ${key}`);
        }
        writeLn();
      } catch (err) {
        error(`Failed to list secrets: ${err}`);
      }
      break;
    }

    case 'set': {
      if (args.length < 2) {
        error('Usage: /set-secret <KEY>');
        return;
      }
      const key = args[1]!;
      const project = resolveProject(deps, args[2]);
      if (!project) return;

      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        error(`Invalid key "${key}". Must match [A-Z_][A-Z0-9_]*.`);
        return;
      }

      // Read secret value with masked input
      const value = await readMaskedInput(rl, `  Value for ${key}: `);
      if (!value) {
        warn('Empty value — skipped.');
        return;
      }

      try {
        const proxyPort = deps.engine.getPort();
        const publicKey = await fetchPublicKey(proxyPort);
        const count = await encryptAndUploadBulk(proxyPort, publicKey, [{ key, value }], project);
        success(`Secret ${key} set for ${project} (${count} encrypted).`);
      } catch (err) {
        error(`Failed to set secret: ${err}`);
      }
      break;
    }

    case 'rm': {
      if (args.length < 2) {
        error('Usage: /rm-secret <KEY>');
        return;
      }
      const key = args[1];
      const project = resolveProject(deps, args[2]);
      if (!project) return;

      try {
        const res = await proxyFetch(deps.engine, `/_auth/secrets/${encodeURIComponent(key)}?app=${encodeURIComponent(project)}`, {
          method: 'DELETE',
        });

        if (!res.ok) {
          error(`Failed to remove secret: ${res.status} ${await res.text().catch(() => '')}`);
          return;
        }

        success(`Secret ${key} removed from ${project}.`);
      } catch (err) {
        error(`Failed to remove secret: ${err}`);
      }
      break;
    }

    case 'import': {
      // /secrets import .env [.env.local ...] [project]
      // /secrets import --auto [project]
      if (args.length < 2) {
        error('Usage: /import-secrets <file|--auto>');
        return;
      }

      const proxyPort = deps.engine.getPort();
      let files: string[] = [];
      let projectArg: string | undefined;
      let autoDiscover = false;

      // Parse args: collect files and detect --auto / project name
      for (let i = 1; i < args.length; i++) {
        const a = args[i]!;
        if (a === '--auto') {
          autoDiscover = true;
        } else if (isEnvFile(a) || a.startsWith('.env') || a.startsWith('/')) {
          files.push(a);
        } else {
          // Last non-file argument is the project
          projectArg = a;
        }
      }

      const project = resolveProject(deps, projectArg);
      if (!project) return;

      // Auto-discover .env files
      if (autoDiscover) {
        const cwd = process.cwd();
        try {
          for (const entry of fs.readdirSync(cwd)) {
            if (!isEnvFile(entry)) continue;
            const fullPath = path.join(cwd, entry);
            try {
              const stat = fs.lstatSync(fullPath);
              if (!stat.isFile() || stat.isSymbolicLink()) continue;
            } catch { continue; }
            if (detectEnvironmentFromFilename(entry) === null) continue;
            files.push(fullPath);
          }
        } catch (err) {
          error(`Failed to scan directory: ${err}`);
          return;
        }
      }

      if (files.length === 0) {
        error('No .env files specified or found.');
        return;
      }

      // Parse all files
      interface ImportEntry { key: string; value: string; env: 'production' | 'development'; source: string }
      const allEntries: ImportEntry[] = [];
      let hasErrors = false;

      for (const filePath of files) {
        const resolved = path.resolve(filePath);
        try {
          const stat = fs.lstatSync(resolved);
          if (stat.isSymbolicLink()) { warn(`Skipping symlink: ${filePath}`); continue; }
          if (!stat.isFile()) { warn(`Skipping non-file: ${filePath}`); continue; }
        } catch {
          error(`File not found: ${filePath}`);
          hasErrors = true;
          continue;
        }

        const content = fs.readFileSync(resolved, 'utf8');
        const result = parseEnvContent(content);
        const env = detectEnvironmentFromFilename(path.basename(resolved)) || 'production';
        const displayName = path.relative(process.cwd(), resolved) || path.basename(resolved);

        for (const w of result.warnings) { warn(`${displayName}: ${w}`); }

        for (const entry of result.entries) {
          allEntries.push({ key: entry.key, value: entry.value, env, source: displayName });
        }

        info(`${displayName}: ${result.entries.length} entries → ${env}`);
      }

      if (allEntries.length === 0) {
        error('No valid entries found.');
        return;
      }

      // Group by environment and dedup
      const byEnv: Record<string, Array<{ key: string; value: string }>> = { production: [], development: [] };
      for (const env of ['production', 'development'] as const) {
        const entries = allEntries.filter(e => e.env === env);
        const deduped = new Map<string, { key: string; value: string }>();
        for (const e of entries) deduped.set(e.key, { key: e.key, value: e.value });
        byEnv[env] = [...deduped.values()];
      }

      // Fetch public key and upload
      try {
        info('Fetching VPS public key...');
        const publicKey = await fetchPublicKey(proxyPort);

        for (const env of ['production', 'development'] as const) {
          const entries = byEnv[env]!;
          if (entries.length === 0) continue;

          info(`Encrypting ${entries.length} ${env} secrets...`);
          const count = await encryptAndUploadBulk(proxyPort, publicKey, entries, project, env);
          success(`${count} ${env} secrets imported for ${project}.`);
        }
      } catch (err) {
        error(`Import failed: ${err}`);
      }
      break;
    }

    case 'paste': {
      const project = resolveProject(deps, args[1]);
      if (!project) break;
      await cmdSecretsPaste(deps, project, rl);
      break;
    }

    default:
      error(`Unknown subcommand: ${subcommand}. Use list, set, rm, paste, or import.`);
  }
}

function cmdConnect(): void {
  writeLn();
  info('To authenticate the CLI daemon:');
  writeLn();
  writeLn('  1. Run in another terminal:');
  writeLn(`     ${BOLD}ellul login${RESET}`);
  writeLn();
  writeLn('  2. Complete the passkey authentication in your browser.');
  writeLn('     The daemon will pick up the session automatically.');
  writeLn();
}

async function cmdStatus(deps: ReplDeps): Promise<void> {
  writeLn();
  writeLn(`${BOLD}ellul daemon${RESET}`);
  writeLn(`${'─'.repeat(40)}`);
  writeLn(`  Domain:    ${deps.domain || `${DIM}(not set)${RESET}`}`);
  writeLn(`  Proxy:     http://127.0.0.1:${deps.engine.getPort()}`);
  writeLn(`  PID:       ${process.pid}`);

  // Check VPS reachability + session
  try {
    const res = await proxyFetch(deps.engine, '/health');
    if (res.ok) {
      writeLn(`  VPS:       ${GREEN}\u25cf awake${RESET}`);
    } else {
      writeLn(`  VPS:       ${YELLOW}\u25cb unreachable (${res.status})${RESET}`);
    }
  } catch {
    writeLn(`  VPS:       ${RED}\u25cb hibernated or unreachable${RESET}`);
  }

  try {
    const res = await proxyFetch(deps.engine, '/_auth/session/status');
    if (res.ok) {
      const data = await res.json() as { authenticated?: boolean; tier?: string };
      if (data.authenticated) {
        writeLn(`  Session:   ${GREEN}authenticated${RESET}${data.tier ? ` (${data.tier})` : ''}`);
      } else {
        writeLn(`  Session:   ${YELLOW}not authenticated${RESET}`);
      }
    } else {
      writeLn(`  Session:   ${YELLOW}unknown (${res.status})${RESET}`);
    }
  } catch {
    writeLn(`  Session:   ${RED}unreachable${RESET}`);
  }

  // Operator key
  writeLn(`  Operator:  ${deps.operatorKey ? `${GREEN}bound${RESET}` : `${RED}not bound${RESET}`}`);

  // Projects
  const projects = deps.getProjects();
  const defaultProject = deps.getDefaultProject();
  writeLn();
  writeLn(`${BOLD}Projects${RESET} (${projects.length})`);
  writeLn(`${'─'.repeat(40)}`);
  if (projects.length === 0) {
    writeLn(`  ${DIM}(none)${RESET}`);
  } else {
    for (const p of projects) {
      const isDefault = p.projectSlug === defaultProject ? ` ${CYAN}(default)${RESET}` : '';
      const connStatus = p.connected ? `${GREEN}connected${RESET}` : `${DIM}disconnected${RESET}`;
      writeLn(`  ${p.projectName} [${p.projectSlug}]  ${connStatus}  ${DIM}${p.directory}${RESET}${isDefault}`);
    }
  }

  // STS tokens
  const stsProjects = deps.stsManager.getRegisteredProjects();
  if (stsProjects.length > 0) {
    writeLn();
    writeLn(`${BOLD}STS Tokens${RESET}`);
    writeLn(`${'─'.repeat(40)}`);
    for (const name of stsProjects) {
      const hasToken = deps.stsManager.getToken(name) !== null;
      writeLn(`  ${name}: ${hasToken ? `${GREEN}valid${RESET}` : `${DIM}expired${RESET}`}`);
    }
  }

  writeLn();
}

// ── /whoami — identity at a glance ──

async function cmdWhoami(deps: ReplDeps): Promise<void> {
  writeLn();

  // Domain + tier
  writeLn(`  ${DIM}domain${RESET}     ${WHITE}${deps.domain}${RESET}`);

  // Session info from keychain
  const session = await deps.host.getAuthSession();
  if (session) {
    writeLn(`  ${DIM}tier${RESET}       ${WHITE}${session.tier}${RESET}`);
    // We don't have expiresAt in AuthSession, check via keychain raw
    const rawSession = await deps.host.getAuthSession();
    if (rawSession) {
      writeLn(`  ${DIM}session${RESET}    ${GREEN}active${RESET}`);
    }
  } else {
    writeLn(`  ${DIM}session${RESET}    ${RED}expired${RESET}`);
  }

  // Device info from keychain
  const deviceCred = await deps.host.getDeviceCredential();
  if (deviceCred) {
    const remaining = deviceCred.trustExpiresAt - Date.now();
    if (remaining > 0) {
      writeLn(`  ${DIM}device${RESET}     ${GREEN}trusted${RESET} ${DIM}(${formatDuration(remaining)} remaining)${RESET}`);
    } else {
      writeLn(`  ${DIM}device${RESET}     ${YELLOW}expired${RESET}`);
    }
  } else {
    writeLn(`  ${DIM}device${RESET}     ${DIM}not registered${RESET}`);
  }

  // Operator key
  writeLn(`  ${DIM}operator${RESET}   ${deps.operatorKey ? `${GREEN}bound${RESET}` : `${RED}not bound${RESET}`}`);

  // Projects
  const projects = deps.getProjects();
  if (projects.length > 0) {
    writeLn(`  ${DIM}projects${RESET}   ${WHITE}${projects.map(p => p.projectName).join(', ')}${RESET}`);
  }

  writeLn();
}

// ── /logout — clean session teardown ──

async function cmdLogout(deps: ReplDeps): Promise<void> {
  writeLn();

  await deps.host.deleteSession();
  success('  Session cleared.');

  writeLn(`  ${DIM}Device credential preserved. Run "ellul login" to re-authenticate.${RESET}`);
  writeLn();
}

// ── /devices — manage trusted CLI devices ──

async function cmdDevices(deps: ReplDeps, args: string[]): Promise<void> {
  const subcommand = args[0]?.toLowerCase();

  if (subcommand === 'revoke') {
    const deviceId = args[1];
    if (!deviceId) {
      error('Usage: /revoke-device <device-id>');
      return;
    }

    // Operator signature required for device revocation
    const { signature: operatorSignature, timestamp: operatorTimestamp } =
      await signOperatorAction(deps.operatorKey, `device-revoke|${deviceId}`);

    try {
      const res = await proxyFetch(deps.engine, `/_auth/device/${encodeURIComponent(deviceId)}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operatorSignature, operatorTimestamp }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
        error(`Revoke failed: ${body.error ?? res.status}`);
        return;
      }

      success('  Device revoked.');
    } catch (err) {
      error(`Revoke failed: ${err}`);
    }
    return;
  }

  // Default: list devices
  try {
    const res = await proxyFetch(deps.engine, '/_auth/device/list');
    if (!res.ok) {
      error(`Failed to fetch devices: ${res.status}`);
      return;
    }

    const data = await res.json() as {
      devices?: Array<{
        id: string;
        deviceName: string;
        lastUsedAt: number;
        expiresAt: number;
        revokedAt: number | null;
      }>;
    };

    const devices = data.devices ?? [];
    if (devices.length === 0) {
      writeLn();
      writeLn(`  ${DIM}No registered devices.${RESET}`);
      writeLn();
      return;
    }

    writeLn();
    writeLn(`  ${PURPLE}${BOLD}Trusted Devices${RESET}`);
    writeLn(`  ${'─'.repeat(40)}`);

    const maxNameLen = Math.max(...devices.map(d => d.deviceName.length));

    for (const d of devices) {
      const isRevoked = d.revokedAt !== null;
      const isExpired = !isRevoked && d.expiresAt < Date.now();
      const lastUsed = formatDuration(Date.now() - d.lastUsedAt);
      const remaining = isRevoked ? '' : isExpired ? '' : formatDuration(d.expiresAt - Date.now());

      let status: string;
      if (isRevoked) {
        status = `${RED}revoked${RESET}`;
      } else if (isExpired) {
        status = `${YELLOW}expired${RESET}`;
      } else {
        status = `${GREEN}trusted${RESET}`;
      }

      const paddedName = d.deviceName.padEnd(maxNameLen);
      writeLn(`  ${paddedName}  ${status}  ${DIM}used ${lastUsed} ago${RESET}${remaining ? `  ${DIM}expires ${remaining}${RESET}` : ''}`);
      writeLn(`  ${DIM}${d.id}${RESET}`);
    }

    writeLn();
  } catch (err) {
    error(`Failed to fetch devices: ${err}`);
  }
}

// ── Active project persistence ──

const ACTIVE_PROJECT_FILE = path.join(process.env.HOME || '', '.ellul', 'active-project');

function readPersistedActiveProject(): string | null {
  try {
    return fs.readFileSync(ACTIVE_PROJECT_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function persistActiveProject(slug: string | null): void {
  try {
    if (slug) {
      fs.mkdirSync(path.dirname(ACTIVE_PROJECT_FILE), { recursive: true });
      fs.writeFileSync(ACTIVE_PROJECT_FILE, slug + '\n');
    } else {
      fs.unlinkSync(ACTIVE_PROJECT_FILE);
    }
  } catch {
    // Non-fatal — persistence is convenience, not security
  }
}

// ── Project commands ──

async function cmdProjects(deps: ReplDeps): Promise<void> {
  const projects = deps.getProjects();
  const activeSlug = _replState?.activeProjectSlug;

  writeLn();
  writeLn(`  ${PURPLE}${BOLD}Projects${RESET}`);
  writeLn(`  ${'─'.repeat(50)}`);

  if (projects.length === 0) {
    writeLn(`  ${DIM}No projects registered.${RESET}`);
    writeLn(`  ${DIM}Run \`ellul init\` in a project directory, or use /project-add${RESET}`);
    writeLn();
    return;
  }

  for (const p of projects) {
    const isActive = p.projectSlug === activeSlug || (projects.length === 1);
    const marker = isActive ? `${CYAN}\u25b6${RESET} ` : '  ';
    const conn = p.connected ? `${GREEN}connected${RESET}` : `${DIM}disconnected${RESET}`;
    writeLn(`${marker}${WHITE}${p.projectName}${RESET}  ${DIM}[${p.projectSlug}]${RESET}  ${conn}`);
    writeLn(`    ${DIM}${p.directory}${RESET}`);
  }
  writeLn();
}

async function cmdProjectAdd(deps: ReplDeps, args: string[], rl: readline.Interface): Promise<void> {
  let directory = args[0];
  if (!directory) {
    directory = await modalQuestion(rl, '  Directory path: ');
    if (!directory) { error('  No directory provided.'); return; }
  }

  // Resolve to absolute path
  const absDir = path.resolve(directory);

  // Validate directory exists (async — avoids blocking event loop on slow mounts)
  try {
    const stat = await fs.promises.stat(absDir);
    if (!stat.isDirectory()) {
      error(`  Not a directory: ${absDir}`);
      return;
    }
  } catch {
    error(`  Directory not found: ${absDir}`);
    return;
  }

  // Read and validate .ellul/project.json (async)
  const projectFile = path.join(absDir, '.ellul', 'project.json');
  let projectName: string;
  let projectSlug: string;
  try {
    const raw = await fs.promises.readFile(projectFile, 'utf8');
    const config = JSON.parse(raw);
    if (!config.projectSlug || typeof config.projectSlug !== 'string') {
      error(`  Invalid .ellul/project.json in ${absDir} — missing projectSlug`);
      return;
    }
    projectName = config.projectName || config.projectSlug || path.basename(absDir);
    projectSlug = config.projectSlug;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      error(`  No .ellul/project.json found in ${absDir}`);
      writeLn(`  ${DIM}Run \`ellul init\` in that directory first.${RESET}`);
    } else {
      error(`  Failed to read .ellul/project.json: ${(e as Error).message}`);
    }
    return;
  }

  // Check if already registered
  const existing = deps.getProjects().find(p => p.projectSlug === projectSlug);
  if (existing) {
    info(`  ${projectName} is already registered (${existing.directory}).`);
    return;
  }

  try {
    const res = await proxyFetch(deps.engine, '/_internal/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: absDir }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      error(`  Failed to add project: ${errData.error}`);
      return;
    }

    success(`  Added ${projectName} [${projectSlug}]`);
    writeLn(`  ${DIM}Sync + gate stream started.${RESET}`);
  } catch (e) {
    error(`  Failed: ${(e as Error).message}`);
  }
  writeLn();
}

async function cmdProjectRemove(deps: ReplDeps, args: string[], rl: readline.Interface): Promise<void> {
  const projects = deps.getProjects();
  if (projects.length === 0) {
    info('  No projects registered.');
    return;
  }

  let target: typeof projects[0];
  if (args[0]) {
    const match = projects.find(p => p.projectName === args[0] || p.projectSlug === args[0]);
    if (!match) { error(`  Project "${args[0]}" not found.`); return; }
    target = match;
  } else if (projects.length > 1) {
    writeLn();
    writeLn(`  Remove which project?`);
    writeLn();
    projects.forEach((p, i) => {
      writeLn(`  ${GREEN}${i + 1}${RESET}) ${p.projectName} ${DIM}[${p.projectSlug}]${RESET}`);
    });
    writeLn();
    const choice = await modalQuestion(rl, '  Choice: ');
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= projects.length) { error('  Invalid choice.'); return; }
    target = projects[idx];
  } else {
    target = projects[0];
  }

  const answer = await modalQuestion(rl, `  Remove ${target.projectName} [${target.projectSlug}] from daemon? VPS data is preserved. (y/N): `);
  if (answer.toLowerCase() !== 'y') return;

  // Sign with operator key — consistent with git mutation hardening
  const { signature: removeSig, timestamp: removeTs } =
    await signOperatorAction(deps.operatorKey, `project-remove|${target.projectSlug}`);

  try {
    const res = await proxyFetch(deps.engine, '/_internal/disconnect', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Operator-Signature': removeSig,
        'X-Operator-Timestamp': removeTs,
      },
      body: JSON.stringify({ projectSlug: target.projectSlug }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      error(`  Failed: ${errData.error}`);
      return;
    }

    // Clear active project if it was the one removed
    if (_replState?.activeProjectSlug === target.projectSlug) {
      _replState.activeProjectSlug = null;
      persistActiveProject(null);
      // Reset prompt to default
      _replState.rl.setPrompt(`${PURPLE}ellul${RESET} ${DIM}>${RESET} `);
    }

    success(`  Removed ${target.projectName}.`);
  } catch (e) {
    error(`  Failed: ${(e as Error).message}`);
  }
  writeLn();
}

async function cmdProjectSwitch(deps: ReplDeps, args: string[], rl: readline.Interface): Promise<void> {
  const projects = deps.getProjects();
  if (projects.length === 0) {
    info('  No projects registered.');
    return;
  }
  if (projects.length === 1) {
    info(`  Only one project registered: ${projects[0].projectName}`);
    return;
  }

  let target: typeof projects[0];
  if (args[0]) {
    const match = projects.find(p => p.projectName === args[0] || p.projectSlug === args[0]);
    if (!match) { error(`  Project "${args[0]}" not found.`); return; }
    target = match;
  } else {
    writeLn();
    writeLn(`  Switch to:`);
    writeLn();
    projects.forEach((p, i) => {
      const active = _replState?.activeProjectSlug === p.projectSlug ? ` ${CYAN}(active)${RESET}` : '';
      writeLn(`  ${GREEN}${i + 1}${RESET}) ${p.projectName} ${DIM}[${p.projectSlug}]${RESET}${active}`);
    });
    writeLn();
    const choice = await modalQuestion(rl, '  Choice: ');
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= projects.length) { error('  Invalid choice.'); return; }
    target = projects[idx];
  }

  if (_replState) {
    _replState.activeProjectSlug = target.projectSlug;
    persistActiveProject(target.projectSlug);
    // Update prompt to show active project
    const newPrompt = `${PURPLE}ellul${RESET} ${DIM}${target.projectName} >${RESET} `;
    _replState.rl.setPrompt(newPrompt);
  }
  success(`  Switched to ${target.projectName}.`);
  writeLn(`  ${DIM}REPL commands now target this project. Agent operations are unaffected (cwd-locked).${RESET}`);
  writeLn();
}

// ── Git commands ──

const PROVIDER_LABELS: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
};

async function cmdGitStatus(deps: ReplDeps, args: string[]): Promise<void> {
  const project = resolveProject(deps, args[0]);
  if (!project) return;

  // Fetch connections
  try {
    const connRes = await proxyFetch(deps.engine, '/_auth/bridge/git-connections');
    if (connRes.ok) {
      const connData = await connRes.json() as { connections?: any[] };
      const conns = connData.connections || [];
      if (conns.length > 0) {
        writeLn();
        writeLn(`  ${PURPLE}${BOLD}Providers${RESET}`);
        for (const c of conns) {
          writeLn(`  ${GREEN}\u2713${RESET} ${PROVIDER_LABELS[c.provider] || c.provider} ${DIM}(${c.providerUsername})${RESET}`);
        }
      } else {
        writeLn();
        writeLn(`  ${DIM}No providers connected. Use /git-connect${RESET}`);
      }
    }
  } catch {
    error('  Failed to fetch provider connections.');
  }

  // Fetch linked repos
  try {
    const linkRes = await proxyFetch(deps.engine, '/_auth/bridge/git-links');
    if (linkRes.ok) {
      const linkData = await linkRes.json() as { links?: any[] };
      const links = linkData.links || [];
      const current = links.find((l: any) => l.appName === project);

      writeLn();
      writeLn(`  ${PURPLE}${BOLD}Linked Repo${RESET}  ${DIM}(${project})${RESET}`);
      if (current) {
        writeLn(`  ${DIM}provider${RESET}  ${PROVIDER_LABELS[current.provider] || current.provider}`);
        writeLn(`  ${DIM}repo${RESET}      ${current.repoFullName}`);
        writeLn(`  ${DIM}branch${RESET}    ${current.defaultBranch || 'main'}`);
      } else {
        writeLn(`  ${DIM}No repo linked. Use /git-link${RESET}`);
      }
    }
  } catch {
    error('  Failed to fetch linked repos.');
  }
  writeLn();
}

async function cmdGitConnect(deps: ReplDeps, rl: readline.Interface): Promise<void> {
  const PROVIDERS = ['github', 'gitlab', 'bitbucket'] as const;

  writeLn();
  writeLn(`  Connect a git provider:`);
  writeLn();
  for (let i = 0; i < PROVIDERS.length; i++) {
    writeLn(`  ${GREEN}${i + 1}${RESET}) ${PROVIDER_LABELS[PROVIDERS[i]]}`);
  }
  writeLn();

  const choice = await modalQuestion(rl, '  Choice [1-3]: ');
  const idx = parseInt(choice, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= PROVIDERS.length) {
    error('  Invalid choice.');
    return;
  }
  const provider = PROVIDERS[idx];

  // Get API URL — requires operator signature to prevent agent from initiating OAuth
  const { signature: configSig, timestamp: configTs } =
    await signOperatorAction(deps.operatorKey, 'git-config');

  let apiUrl: string;
  try {
    const configRes = await proxyFetch(deps.engine, '/_auth/bridge/git-config', {
      headers: {
        'X-Operator-Signature': configSig,
        'X-Operator-Timestamp': configTs,
      },
    });
    if (!configRes.ok) {
      error('  Failed to get API config.');
      return;
    }
    const configData = await configRes.json() as { apiUrl: string };
    apiUrl = configData.apiUrl;
  } catch {
    error('  Failed to get API config.');
    return;
  }

  // Create callback server
  const nonce = crypto.randomBytes(16).toString('hex');
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 5 * 60 * 1000);

  try {
    const callback = createCallbackServer(nonce, abortController.signal, {
      successTitle: 'Provider connected',
      successMessage: 'You can close this tab and return to the terminal.',
    });

    const oauthUrl = `${apiUrl}/api/git/connect/${provider}?cli_callback_port=${callback.port}&cli_nonce=${encodeURIComponent(nonce)}`;

    writeLn();
    info(`  Opening browser to connect ${PROVIDER_LABELS[provider]}...`);
    writeLn(`  ${DIM}If prompted to log in, sign in with your passkey (one-time step).${RESET}`);
    writeLn();
    openBrowser(oauthUrl);

    info(`  Waiting for callback...`);

    const result = await callback.resultPromise;

    const err = result.params.get('error');
    if (err) {
      error(`  Connection failed: ${err}`);
      return;
    }

    const connected = result.params.get('connected');
    success(`  Connected to ${PROVIDER_LABELS[connected as string] || connected}.`);
    writeLn();
  } catch (e) {
    error(`  ${(e as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function cmdGitLink(deps: ReplDeps, args: string[], rl: readline.Interface): Promise<void> {
  const project = resolveProject(deps, args[0]);
  if (!project) return;

  // Pick provider
  let connections: any[];
  try {
    const connRes = await proxyFetch(deps.engine, '/_auth/bridge/git-connections');
    if (!connRes.ok) { error('  Failed to fetch connections.'); return; }
    const connData = await connRes.json() as { connections?: any[] };
    connections = connData.connections || [];
  } catch { error('  Failed to fetch connections.'); return; }

  if (connections.length === 0) {
    error('  No providers connected. Use /git-connect first.');
    return;
  }

  let provider: string;
  if (connections.length === 1) {
    provider = connections[0].provider;
  } else {
    writeLn();
    writeLn(`  Select provider:`);
    writeLn();
    connections.forEach((c: any, i: number) => {
      writeLn(`  ${GREEN}${i + 1}${RESET}) ${PROVIDER_LABELS[c.provider] || c.provider} ${DIM}(${c.providerUsername})${RESET}`);
    });
    writeLn();
    const choice = await modalQuestion(rl, '  Choice: ');
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= connections.length) { error('  Invalid choice.'); return; }
    provider = connections[idx].provider;
  }

  // Fetch repos
  let repos: any[];
  try {
    const repoRes = await proxyFetch(deps.engine, `/_auth/bridge/git-repos?provider=${provider}`);
    if (!repoRes.ok) { error('  Failed to fetch repos.'); return; }
    const repoData = await repoRes.json() as { repos?: any[] };
    repos = repoData.repos || [];
  } catch { error('  Failed to fetch repos.'); return; }

  if (repos.length === 0) {
    error('  No repos found. Check provider permissions.');
    return;
  }

  writeLn();
  writeLn(`  Select a repo:`);
  writeLn();
  repos.forEach((r: any, i: number) => {
    const vis = r.isPrivate ? `${YELLOW}private${RESET}` : `${GREEN}public${RESET}`;
    writeLn(`  ${String(i + 1).padStart(3)}) ${r.fullName || r.name} (${vis})`);
  });
  writeLn();

  const choice = await modalQuestion(rl, '  Choice: ');
  const idx = parseInt(choice, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= repos.length) { error('  Invalid choice.'); return; }

  const repo = repos[idx];
  const repoFullName = repo.fullName || repo.name;
  info(`  Linking ${repoFullName} to ${project}...`);

  // Sign with operator key — VPS rejects unsigned link requests
  const { signature: linkSig, timestamp: linkTs } =
    await signOperatorAction(deps.operatorKey, `git-link|${project}|${repoFullName}`);

  try {
    const linkRes = await proxyFetch(deps.engine, '/_auth/bridge/git-link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Operator-Signature': linkSig,
        'X-Operator-Timestamp': linkTs,
      },
      body: JSON.stringify({
        provider,
        repoFullName,
        repoUrl: repo.url || repo.htmlUrl || repo.cloneUrl || '',
        defaultBranch: repo.defaultBranch || 'main',
        isPrivate: !!repo.isPrivate,
        appName: project,
      }),
    });

    if (!linkRes.ok) {
      const errData = await linkRes.json().catch(() => ({ error: `HTTP ${linkRes.status}` })) as { error?: string };
      error(`  Link failed: ${errData.error}`);
      return;
    }

    const data = await linkRes.json() as { setupWarning?: string };
    if (data.setupWarning) {
      success(`  Linked ${repoFullName} \u2192 ${project}`);
      warn(`  Git setup warning: ${data.setupWarning}`);
    } else {
      success(`  Linked ${repoFullName} \u2192 ${project}`);
      writeLn(`  ${DIM}Git push/pull now available via agent.${RESET}`);
    }
  } catch (e) {
    error(`  Link failed: ${(e as Error).message}`);
  }
  writeLn();
}

async function cmdGitUnlink(deps: ReplDeps, args: string[], rl: readline.Interface): Promise<void> {
  const project = resolveProject(deps, args[0]);
  if (!project) return;

  // Check current link
  let current: any;
  try {
    const linkRes = await proxyFetch(deps.engine, '/_auth/bridge/git-links');
    if (!linkRes.ok) { error('  Failed to check links.'); return; }
    const linkData = await linkRes.json() as { links?: any[] };
    current = (linkData.links || []).find((l: any) => l.appName === project);
  } catch { error('  Failed to check links.'); return; }

  if (!current) {
    info('  No repo linked to this project.');
    return;
  }

  const answer = await modalQuestion(rl, `  Unlink ${current.repoFullName} from ${project}? (y/N): `);
  if (answer.toLowerCase() !== 'y') return;

  // Sign with operator key — VPS rejects unsigned unlink requests
  const { signature: unlinkSig, timestamp: unlinkTs } =
    await signOperatorAction(deps.operatorKey, `git-unlink|${project}`);

  try {
    const res = await proxyFetch(deps.engine, `/_auth/bridge/git-link?app=${encodeURIComponent(project)}`, {
      method: 'DELETE',
      headers: {
        'X-Operator-Signature': unlinkSig,
        'X-Operator-Timestamp': unlinkTs,
      },
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      error(`  Unlink failed: ${errData.error}`);
      return;
    }
    success(`  Unlinked ${current.repoFullName} from ${project}.`);
  } catch (e) {
    error(`  Unlink failed: ${(e as Error).message}`);
  }
  writeLn();
}

async function cmdGitDisconnect(deps: ReplDeps, rl: readline.Interface): Promise<void> {
  let connections: any[];
  try {
    const connRes = await proxyFetch(deps.engine, '/_auth/bridge/git-connections');
    if (!connRes.ok) { error('  Failed to fetch connections.'); return; }
    const connData = await connRes.json() as { connections?: any[] };
    connections = connData.connections || [];
  } catch { error('  Failed to fetch connections.'); return; }

  if (connections.length === 0) {
    info('  No providers connected.');
    return;
  }

  let provider: string;
  if (connections.length === 1) {
    provider = connections[0].provider;
  } else {
    writeLn();
    writeLn(`  Disconnect provider:`);
    writeLn();
    connections.forEach((c: any, i: number) => {
      writeLn(`  ${GREEN}${i + 1}${RESET}) ${PROVIDER_LABELS[c.provider] || c.provider} ${DIM}(${c.providerUsername})${RESET}`);
    });
    writeLn();
    const choice = await modalQuestion(rl, '  Choice: ');
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= connections.length) { error('  Invalid choice.'); return; }
    provider = connections[idx].provider;
  }

  const answer = await modalQuestion(rl, `  Disconnect ${PROVIDER_LABELS[provider] || provider}? This unlinks all repos. (y/N): `);
  if (answer.toLowerCase() !== 'y') return;

  // Sign with operator key — VPS rejects unsigned disconnect requests
  const { signature: disconnectSig, timestamp: disconnectTs } =
    await signOperatorAction(deps.operatorKey, `git-disconnect|${provider}`);

  try {
    const res = await proxyFetch(deps.engine, `/_auth/bridge/git-disconnect/${provider}`, {
      method: 'DELETE',
      headers: {
        'X-Operator-Signature': disconnectSig,
        'X-Operator-Timestamp': disconnectTs,
      },
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      error(`  Disconnect failed: ${errData.error}`);
      return;
    }
    success(`  Disconnected ${PROVIDER_LABELS[provider] || provider}.`);
  } catch (e) {
    error(`  Disconnect failed: ${(e as Error).message}`);
  }
  writeLn();
}

async function cmdGitPush(deps: ReplDeps, args: string[], rl: readline.Interface): Promise<void> {
  const project = resolveProject(deps, args[0]);
  if (!project) return;

  const force = args.includes('--force');

  if (force) {
    const answer = await modalQuestion(rl, `  Force push ${project}? This rewrites remote history. (y/N): `);
    if (answer.toLowerCase() !== 'y') return;
  }

  const action = force ? 'force-push' : 'push';
  info(`  ${force ? 'Force pushing' : 'Pushing'} ${project}...`);

  try {
    const res = await proxyFetch(deps.engine, '/_auth/bridge/git-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, appName: project }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      error(`  Push failed: ${errData.error}`);
      return;
    }

    const data = await res.json() as { output?: string };
    success(`  Push complete.`);
    if (data.output) {
      writeLn(`  ${DIM}${data.output.trim().split('\n').join(`\n  `)}${RESET}`);
    }
  } catch (e) {
    error(`  Push failed: ${(e as Error).message}`);
  }
  writeLn();
}

async function cmdGitPull(deps: ReplDeps, args: string[]): Promise<void> {
  const project = resolveProject(deps, args[0]);
  if (!project) return;

  info(`  Pulling ${project}...`);

  try {
    const res = await proxyFetch(deps.engine, '/_auth/bridge/git-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pull', appName: project }),
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      error(`  Pull failed: ${errData.error}`);
      return;
    }

    const data = await res.json() as { output?: string };
    success(`  Pull complete.`);
    if (data.output) {
      writeLn(`  ${DIM}${data.output.trim().split('\n').join(`\n  `)}${RESET}`);
    }
  } catch (e) {
    error(`  Pull failed: ${(e as Error).message}`);
  }
  writeLn();
}

// ── /update — trigger platform update ──

async function cmdUpdate(deps: ReplDeps): Promise<void> {
  // Check current status via VPS proxy (operation replaces legacy updateStatus)
  info('Checking for updates...');

  let operationType: string | null = null;
  let operationStep: string | null = null;
  let currentVersion: string | null = null;
  let latestVersion: string | null = null;

  try {
    const res = await proxyFetch(deps.engine, '/_auth/platform/status');
    if (res.ok) {
      const data = await res.json() as {
        operation?: { type: string | null; step: string | null };
        currentVersion?: string;
        latestVersion?: string;
      };
      operationType = data.operation?.type ?? null;
      operationStep = data.operation?.step ?? null;
      currentVersion = data.currentVersion ?? null;
      latestVersion = data.latestVersion ?? null;
    } else {
      error(`Failed to check status: ${res.status}`);
      return;
    }
  } catch (err) {
    error(`Failed to check status: ${err}`);
    return;
  }

  // No active operation and versions match — already current
  if (!operationType && currentVersion === latestVersion) {
    writeLn();
    success(`  Already on the latest version${currentVersion ? ` (${currentVersion})` : ''}.`);
    writeLn();
    return;
  }

  // Active update operation in progress
  if (operationType === 'update' && operationStep && ['snapshotting', 'updating', 'swapping', 'verifying'].includes(operationStep)) {
    writeLn();
    info(`  Update already in progress (${operationStep}).`);
    writeLn(`  ${DIM}Check the dashboard for real-time progress.${RESET}`);
    writeLn();
    return;
  }

  // Can only start/retry if: no op + version mismatch, or failed update states
  const isVersionMismatch = !operationType && currentVersion !== latestVersion;
  const isSnapshotFailed = operationType === 'update' && operationStep === 'snapshot_failed';
  const isUpdateFailed = operationType === 'update' && operationStep === 'update_failed';

  if (!isVersionMismatch && !isSnapshotFailed && !isUpdateFailed) {
    writeLn();
    info(`  No update available${currentVersion ? ` (${currentVersion})` : ''}.`);
    writeLn();
    return;
  }

  // Show update info
  writeLn();
  writeLn(`  ${CYAN}Platform update available${RESET}`);
  if (currentVersion) writeLn(`  ${DIM}Current:${RESET}  ${currentVersion}`);
  if (latestVersion) writeLn(`  ${DIM}Latest:${RESET}   ${latestVersion}`);
  writeLn();
  writeLn(`  ${GREEN}Your project files and databases are preserved.${RESET}`);
  writeLn(`  ${DIM}A safety snapshot is created before updating.${RESET}`);
  writeLn();

  // Trigger the update
  try {
    const res = await proxyFetch(deps.engine, '/_auth/platform/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
      error(`  ${body.error ?? 'Failed to start update'}`);
      return;
    }

    success('  Update initiated.');
    writeLn(`  ${DIM}Monitor progress in the dashboard or run /status.${RESET}`);
  } catch (err) {
    error(`  Failed to start update: ${err}`);
  }
  writeLn();
}

function cmdHelp(): void {
  writeLn();
  writeLn(`  ${PURPLE}${BOLD}Projects${RESET}`);
  writeLn(`  ${WHITE}/projects${RESET}              List registered projects`);
  writeLn(`  ${WHITE}/project-add${RESET}           Register a project directory`);
  writeLn(`  ${WHITE}/project-remove${RESET}        Unregister a project`);
  writeLn(`  ${WHITE}/project-switch${RESET}        Switch active project context`);
  writeLn();
  writeLn(`  ${PURPLE}${BOLD}Scopes${RESET}`);
  writeLn(`  ${WHITE}/scopes${RESET}                List scopes`);
  writeLn(`  ${WHITE}/enable-scope${RESET}          Enable a scope`);
  writeLn(`  ${WHITE}/deny-scope${RESET}            Deny a scope`);
  writeLn(`  ${WHITE}/deny-all-scopes${RESET}       Deny all scopes`);
  writeLn();
  writeLn(`  ${PURPLE}${BOLD}Policies${RESET}`);
  writeLn(`  ${WHITE}/policies${RESET}              List policies`);
  writeLn(`  ${WHITE}/set-policy${RESET}            Set a policy`);
  writeLn(`  ${WHITE}/rm-policy${RESET}             Reset a policy to default`);
  writeLn();
  writeLn(`  ${PURPLE}${BOLD}Secrets${RESET}`);
  writeLn(`  ${WHITE}/secrets${RESET}               List secrets`);
  writeLn(`  ${WHITE}/set-secret${RESET}            Set a secret`);
  writeLn(`  ${WHITE}/paste-secrets${RESET}         Paste & upload secrets`);
  writeLn(`  ${WHITE}/rm-secret${RESET}             Remove a secret`);
  writeLn();
  writeLn(`  ${PURPLE}${BOLD}Identity${RESET}`);
  writeLn(`  ${WHITE}/me${RESET}                    Session & device info`);
  writeLn(`  ${WHITE}/devices${RESET}               List trusted devices`);
  writeLn(`  ${WHITE}/revoke-device${RESET}         Revoke a device`);
  writeLn(`  ${WHITE}/vault${RESET}                 Open web vault`);
  writeLn(`  ${WHITE}/logout${RESET}                Clear session`);
  writeLn();
  writeLn(`  ${PURPLE}${BOLD}Git${RESET}`);
  writeLn(`  ${WHITE}/git${RESET}                   Show linked repo & provider status`);
  writeLn(`  ${WHITE}/git-connect${RESET}            Connect GitHub/GitLab/Bitbucket`);
  writeLn(`  ${WHITE}/git-link${RESET}               Link a repo to this project`);
  writeLn(`  ${WHITE}/git-unlink${RESET}             Unlink repo from this project`);
  writeLn(`  ${WHITE}/git-push${RESET}               Commit & push to remote`);
  writeLn(`  ${WHITE}/git-pull${RESET}               Pull & rebase from remote`);
  writeLn(`  ${WHITE}/git-disconnect${RESET}         Disconnect a git provider`);
  writeLn();
  writeLn(`  ${PURPLE}${BOLD}System${RESET}`);
  writeLn(`  ${WHITE}/update${RESET}                Update to latest platform version`);
  writeLn(`  ${WHITE}/sync${RESET}                  Reinject agent instructions & MCP config`);
  writeLn(`  ${WHITE}/status${RESET}                Daemon status`);
  writeLn(`  ${WHITE}/help${RESET}                  Show all commands`);
  writeLn();
  writeLn(`  ${DIM}Scopes: exec, env, db_read, db_write, db_migrate, git, deploy, logs${RESET}`);
  writeLn(`  ${DIM}Policy values: ask, allow_always, deny  |  Duration: 30s, 5m, 1h${RESET}`);
  writeLn();
}

// ── Masked input for secrets ──

function readMaskedInput(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    let value = '';
    const wasTerminal = (process.stdin as NodeJS.ReadStream).isRaw;

    write(prompt);

    // Enable raw mode to intercept keystrokes
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const onData = (buf: Buffer): void => {
      for (const byte of buf) {
        // Enter
        if (byte === 13 || byte === 10) {
          process.stdin.removeListener('data', onData);
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(wasTerminal ?? false);
          }
          write('\n');
          resolve(value);
          return;
        }

        // Ctrl+C
        if (byte === 3) {
          process.stdin.removeListener('data', onData);
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(wasTerminal ?? false);
          }
          write('\n');
          resolve('');
          return;
        }

        // Backspace / Delete
        if (byte === 127 || byte === 8) {
          if (value.length > 0) {
            value = value.slice(0, -1);
            write('\b \b');
          }
          continue;
        }

        // Printable ASCII
        if (byte >= 32 && byte < 127) {
          value += String.fromCharCode(byte);
          write('*');
        }
      }
    };

    process.stdin.on('data', onData);
  });
}

// ── Gate event handler ──

// Pause REPL, prompt decision for gate event, POST response, resume.
export async function handleGateRequest(state: ReplState, request: GateRequestEvent): Promise<void> {
  if (state.gatePromptActive) {
    // Queue would be complex — for now, auto-deny overlapping requests.
    // This is rare in practice (gates are sequential per project).
    warn(`Gate request for ${request.gate} on ${request.project} auto-denied (another gate prompt is active).`);
    proxyFetch(state.deps.engine, '/_auth/gates/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: request.requestId,
        action: 'deny',
      }),
    }).catch(() => {});
    return;
  }

  state.gatePromptActive = true;

  // Clear current line and pause readline
  write('\r\x1b[K');
  state.rl.pause();

  writeLn();
  writeLn(`  ${PURPLE}${BOLD}\u25a0 Scope Request${RESET}  ${WHITE}${request.gate}${RESET}  ${DIM}on ${request.project}${RESET}`);
  if (request.reason) {
    writeLn(`  ${DIM}${request.reason}${RESET}`);
  }
  writeLn();
  writeLn(`  ${GREEN}1${RESET}) Approve ${DIM}(5 min)${RESET}`);
  writeLn(`  ${CYAN}2${RESET}) Approve Session`);
  writeLn(`  ${PURPLE}3${RESET}) Always Allow`);
  writeLn(`  ${RED}4${RESET}) Deny`);
  writeLn();

  // Use the main readline for the gate choice (no temporary readline)
  const answer = await modalQuestion(state.rl, '  Choice [1-4]: ');

  let action: string;
  let ttlMs: number | undefined;

  switch (answer) {
    case '1':
      action = 'grant_timed';
      ttlMs = 5 * 60 * 1000;
      break;
    case '2':
      action = 'grant_session';
      break;
    case '3':
      action = 'grant_always';
      break;
    default:
      action = 'deny';
      break;
  }

  try {
    const { signature: operatorSignature, timestamp: operatorTimestamp } =
      await signOperatorAction(state.deps.operatorKey, `gate-respond|${request.requestId}|${action}`);

    const body: Record<string, unknown> = {
      requestId: request.requestId,
      action,
      operatorSignature,
      operatorTimestamp,
    };
    if (ttlMs !== undefined) body.ttlMs = ttlMs;

    const res = await proxyFetch(state.deps.engine, '/_auth/gates/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      const label = action === 'deny' ? 'Denied' : 'Approved';
      success(`  ${label} ${request.gate} for ${request.project}.`);
    } else {
      error(`  Gate response failed: ${res.status}`);
    }
  } catch (err) {
    error(`  Gate response error: ${err}`);
  }

  writeLn();
  state.gatePromptActive = false;
  state.rl.prompt();
}

// ── Command dispatch ──

async function dispatch(state: ReplState, line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  if (!trimmed.startsWith('/')) {
    writeLn(`${DIM}Type /help for commands.${RESET}`);
    return;
  }

  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (!command) return; // bare "/" — handled by typeahead menu

  switch (command) {
    // ── Projects ──
    case 'projects':
      await cmdProjects(state.deps);
      break;
    case 'project-add':
      await cmdProjectAdd(state.deps, args, state.rl);
      break;
    case 'project-remove':
      await cmdProjectRemove(state.deps, args, state.rl);
      break;
    case 'project-switch':
      await cmdProjectSwitch(state.deps, args, state.rl);
      break;

    // ── Scopes ──
    case 'scopes':
      await cmdListScopes(state.deps, args);
      break;
    case 'enable-scope':
      await cmdEnableScope(state.deps, args);
      break;
    case 'deny-scope':
      await cmdDenyScope(state.deps, args);
      break;
    case 'deny-all-scopes':
      await cmdLockdown(state.deps, args);
      break;

    // ── Policies ──
    case 'policies':
      await cmdListPolicies(state.deps, args);
      break;
    case 'set-policy':
      await cmdSetPolicy(state.deps, args);
      break;
    case 'rm-policy':
      await cmdRmPolicy(state.deps, args);
      break;

    // ── Secrets ──
    case 'secrets':
      await cmdSecrets(state.deps, ['list', ...args], state.rl);
      break;
    case 'set-secret':
      await cmdSecrets(state.deps, ['set', ...args], state.rl);
      break;
    case 'paste-secrets':
      await cmdSecrets(state.deps, ['paste', ...args], state.rl);
      break;
    case 'rm-secret':
      await cmdSecrets(state.deps, ['rm', ...args], state.rl);
      break;
    case 'import-secrets':
      // Hidden power-user alias (not in typeahead, but still works)
      await cmdSecrets(state.deps, ['import', ...args], state.rl);
      break;

    // ── Identity ──
    case 'me':
      await cmdWhoami(state.deps);
      break;
    case 'devices':
      await cmdDevices(state.deps, args);
      break;
    case 'revoke-device':
      await cmdDevices(state.deps, ['revoke', ...args]);
      break;
    case 'vault':
      cmdVault(state.deps, args);
      break;
    case 'logout':
      await cmdLogout(state.deps);
      break;

    // ── Git ──
    case 'git':
      await cmdGitStatus(state.deps, args);
      break;
    case 'git-connect':
      await cmdGitConnect(state.deps, state.rl);
      break;
    case 'git-link':
      await cmdGitLink(state.deps, args, state.rl);
      break;
    case 'git-unlink':
      await cmdGitUnlink(state.deps, args, state.rl);
      break;
    case 'git-push':
      await cmdGitPush(state.deps, args, state.rl);
      break;
    case 'git-pull':
      await cmdGitPull(state.deps, args);
      break;
    case 'git-disconnect':
      await cmdGitDisconnect(state.deps, state.rl);
      break;

    // ── System ──
    case 'update':
      await cmdUpdate(state.deps);
      break;
    case 'sync': {
      const syncProject = state.deps.getProjects()[0];
      if (!syncProject) {
        error('No project registered.');
        break;
      }
      try {
        const written = await syncAllInstructionFiles(syncProject.projectName);
        if (written.length > 0) {
          success(`  ${written.length} file${written.length === 1 ? '' : 's'} updated:`);
          for (const f of written) writeLn(`  ${DIM}${f}${RESET}`);
        } else {
          info('  All instruction files up to date.');
        }
      } catch (err) {
        error(`  Sync failed: ${err}`);
      }
      break;
    }
    case 'status':
      await cmdStatus(state.deps);
      break;
    case 'help':
      cmdHelp();
      break;

    default:
      error(`Unknown command: /${command}`);
      writeLn(`${DIM}Type / to see commands.${RESET}`);
  }
}

// ── REPL entry point ──

// ── Command Registry ──

const COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: '/projects',           desc: 'List registered projects' },
  { cmd: '/project-add',       desc: 'Register a project directory' },
  { cmd: '/project-remove',    desc: 'Unregister a project' },
  { cmd: '/project-switch',    desc: 'Switch active project' },
  { cmd: '/scopes',            desc: 'List scopes' },
  { cmd: '/enable-scope',      desc: 'Enable a scope' },
  { cmd: '/deny-scope',        desc: 'Deny a scope' },
  { cmd: '/deny-all-scopes',   desc: 'Deny all scopes' },
  { cmd: '/policies',          desc: 'List policies' },
  { cmd: '/set-policy',        desc: 'Set a policy' },
  { cmd: '/rm-policy',         desc: 'Reset a policy to default' },
  { cmd: '/secrets',           desc: 'List secrets' },
  { cmd: '/set-secret',        desc: 'Set a secret' },
  { cmd: '/paste-secrets',     desc: 'Paste & upload secrets' },
  { cmd: '/rm-secret',         desc: 'Remove a secret' },
  { cmd: '/git',                desc: 'Linked repo & provider status' },
  { cmd: '/git-connect',       desc: 'Connect a git provider' },
  { cmd: '/git-link',           desc: 'Link a repo to this project' },
  { cmd: '/git-unlink',         desc: 'Unlink repo from this project' },
  { cmd: '/git-push',           desc: 'Commit & push to remote' },
  { cmd: '/git-pull',           desc: 'Pull & rebase from remote' },
  { cmd: '/git-disconnect',    desc: 'Disconnect a git provider' },
  { cmd: '/me',                desc: 'Session & device info' },
  { cmd: '/devices',           desc: 'List trusted devices' },
  { cmd: '/revoke-device',     desc: 'Revoke a device' },
  { cmd: '/vault',             desc: 'Open web vault' },
  { cmd: '/logout',            desc: 'Clear session' },
  { cmd: '/update',            desc: 'Update to latest platform version' },
  { cmd: '/sync',              desc: 'Reinject agent instructions & MCP config' },
  { cmd: '/status',            desc: 'Daemon status' },
  { cmd: '/help',              desc: 'Show all commands' },
];

// ── Inline Typeahead Menu ──
// Renders a filtered command menu below the prompt as the user types.
// Arrow keys navigate, Enter selects, Escape dismisses.
//
// Architecture: The menu takes over stdin in raw mode when active.
// This prevents readline from processing arrow keys (which would move the
// cursor and corrupt the line buffer) and prevents Enter from firing both
// the menu select AND the readline 'line' event.
//
// When the menu is active:
//   - stdin is in raw mode, all keystrokes go to the menu handler
//   - printable characters are echoed manually and update the filter
//   - arrow keys navigate the selection (no readline interference)
//   - Enter selects, clears the menu, writes the command to readline, and returns control
//   - Escape/Ctrl+C dismisses and returns control to readline
//   - Backspace updates the filter (dismisses if backspaced past '/')

const MAX_VISIBLE_ITEMS = 10;

class TypeaheadMenu {
  private active = false;
  private inputBuffer = '/';
  private selectedIndex = 0;
  private renderedLines = 0;
  private scrollOffset = 0;
  private rl: readline.Interface;
  private onSelect: (cmd: string) => void;
  private onDismiss: () => void;
  private keypressHandler: ((buf: Buffer) => void) | null = null;

  constructor(
    rl: readline.Interface,
    onSelect: (cmd: string) => void,
    onDismiss: () => void,
  ) {
    this.rl = rl;
    this.onSelect = onSelect;
    this.onDismiss = onDismiss;
  }

  isActive(): boolean {
    return this.active;
  }

  private getFiltered(): Array<{ cmd: string; desc: string }> {
    const filter = this.inputBuffer.slice(1).toLowerCase();
    if (!filter) return COMMANDS;
    // Prefix matches first, then substring matches
    const prefix: typeof COMMANDS = [];
    const substring: typeof COMMANDS = [];
    for (const c of COMMANDS) {
      const lower = c.cmd.toLowerCase();
      if (lower.startsWith('/' + filter)) {
        prefix.push(c);
      } else if (lower.includes(filter)) {
        substring.push(c);
      }
    }
    return [...prefix, ...substring];
  }

  /** Activate the menu — takes over stdin in raw mode */
  activate(): void {
    if (this.active) return;

    // Clear the '/' that readline already processed and echoed
    // before we paused it. These are private APIs but every Node.js
    // REPL that does inline completion uses them (including Node's own).
    try {
      (this.rl as any).line = '';
      (this.rl as any).cursor = 0;
    } catch { /* readline internals unavailable — proceed anyway */ }

    this.active = true;
    this.inputBuffer = '/';
    this.selectedIndex = 0;
    this.scrollOffset = 0;

    // Pause readline and switch to raw mode
    this.rl.pause();
    try {
      if (process.stdin.isTTY && !process.stdin.isRaw) {
        process.stdin.setRawMode(true);
      }
    } catch {
      // stdin lost TTY (piped input, SSH disconnect) — can't use menu
      this.active = false;
      this.rl.resume();
      return;
    }
    process.stdin.resume();

    // Redraw prompt line with '/' (readline's echo is now stale)
    this.redrawPromptLine();

    this.keypressHandler = (buf: Buffer) => {
      try {
        this.handleRawKey(buf);
      } catch {
        // Catch-all: if anything throws in raw mode, deactivate to prevent
        // bricking the terminal with a stuck raw-mode stdin.
        this.deactivate();
        this.rl.prompt();
      }
    };
    process.stdin.on('data', this.keypressHandler);

    this.render();
  }

  /** Release stdin back to readline */
  private deactivate(): void {
    if (!this.active) return;
    this.clearOverlay();
    this.active = false;

    if (this.keypressHandler) {
      process.stdin.removeListener('data', this.keypressHandler);
      this.keypressHandler = null;
    }

    try {
      if (process.stdin.isTTY && process.stdin.isRaw) {
        process.stdin.setRawMode(false);
      }
    } catch { /* stdin lost TTY — already non-raw */ }
    this.rl.resume();
  }

  private handleRawKey(buf: Buffer): void {
    // Detect special keys from raw bytes
    const seq = buf.toString();

    // Ctrl+C — dismiss and potentially exit
    if (seq === '\x03') {
      this.deactivate();
      // Clear the prompt line
      process.stderr.write('\r\x1b[K');
      this.rl.prompt();
      this.onDismiss();
      return;
    }

    // Escape
    if (seq === '\x1b' || seq === '\x1b\x1b') {
      this.deactivate();
      process.stderr.write('\r\x1b[K');
      this.rl.prompt();
      this.onDismiss();
      return;
    }

    // Arrow Up: \x1b[A
    if (seq === '\x1b[A') {
      const filtered = this.getFiltered();
      if (filtered.length > 0) {
        this.selectedIndex = (this.selectedIndex - 1 + filtered.length) % filtered.length;
        this.adjustScroll(filtered.length);
        this.render();
      }
      return;
    }

    // Arrow Down: \x1b[B
    if (seq === '\x1b[B') {
      const filtered = this.getFiltered();
      if (filtered.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % filtered.length;
        this.adjustScroll(filtered.length);
        this.render();
      }
      return;
    }

    // Enter — select current item
    if (seq === '\r' || seq === '\n') {
      const filtered = this.getFiltered();
      if (filtered.length > 0 && this.selectedIndex < filtered.length) {
        const selected = filtered[this.selectedIndex]!.cmd;
        this.deactivate();
        // Clear prompt line, write selected command, show prompt
        process.stderr.write('\r\x1b[K');
        this.onSelect(selected);
      } else {
        this.deactivate();
        process.stderr.write('\r\x1b[K');
        this.rl.prompt();
        this.onDismiss();
      }
      return;
    }

    // Backspace (0x7f or 0x08)
    if (seq === '\x7f' || seq === '\x08') {
      if (this.inputBuffer.length <= 1) {
        // Backspaced past '/' — dismiss
        this.deactivate();
        process.stderr.write('\r\x1b[K');
        this.rl.prompt();
        this.onDismiss();
      } else {
        this.inputBuffer = this.inputBuffer.slice(0, -1);
        this.selectedIndex = 0;
        this.scrollOffset = 0;
        this.redrawPromptLine();
        this.render();
      }
      return;
    }

    // Tab — select like Enter
    if (seq === '\t') {
      const filtered = this.getFiltered();
      if (filtered.length > 0 && this.selectedIndex < filtered.length) {
        const selected = filtered[this.selectedIndex]!.cmd;
        this.deactivate();
        process.stderr.write('\r\x1b[K');
        this.onSelect(selected);
      }
      return;
    }

    // Printable ASCII characters
    const code = buf[0];
    if (code !== undefined && code >= 32 && code < 127) {
      this.inputBuffer += seq;
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.redrawPromptLine();
      this.render();
      return;
    }

    // Ignore everything else (other escape sequences, etc.)
  }

  private adjustScroll(totalItems: number): void {
    const visible = Math.min(totalItems, MAX_VISIBLE_ITEMS);
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + visible) {
      this.scrollOffset = this.selectedIndex - visible + 1;
    }
  }

  /** Redraw the prompt line with current input buffer */
  private redrawPromptLine(): void {
    const prompt = `${PURPLE}ellul${RESET} ${DIM}>${RESET} `;
    process.stderr.write(`\r\x1b[K${prompt}${this.inputBuffer}`);
  }

  private clearOverlay(): void {
    if (this.renderedLines === 0) return;
    process.stderr.write('\x1b[s'); // save cursor
    for (let i = 0; i < this.renderedLines; i++) {
      process.stderr.write('\n\x1b[2K');
    }
    process.stderr.write('\x1b[u'); // restore cursor
    this.renderedLines = 0;
  }

  private render(): void {
    this.clearOverlay();

    const filtered = this.getFiltered();
    if (filtered.length === 0) {
      this.renderedLines = 1;
      process.stderr.write('\x1b[s');
      process.stderr.write(`\n\x1b[2K  ${DIM}No matching commands${RESET}`);
      process.stderr.write('\x1b[u');
      return;
    }

    const visible = Math.min(filtered.length, MAX_VISIBLE_ITEMS);
    const maxCmdLen = Math.max(...filtered.map(c => c.cmd.length));
    const hasScrollUp = this.scrollOffset > 0;
    const hasScrollDown = this.scrollOffset + visible < filtered.length;

    // Calculate total lines we'll render (items + scroll indicators)
    let totalRendered = 0;

    process.stderr.write('\x1b[s'); // save cursor

    // Scroll-up indicator
    if (hasScrollUp) {
      process.stderr.write(`\n\x1b[2K  ${DIM}  \u2191 ${this.scrollOffset} more${RESET}`);
      totalRendered++;
    }

    // Menu items
    for (let i = 0; i < visible; i++) {
      const itemIdx = this.scrollOffset + i;
      const item = filtered[itemIdx]!;
      const isSelected = itemIdx === this.selectedIndex;

      const prefix = isSelected ? `${PURPLE}\u25b8${RESET}` : ' ';
      const cmdStr = isSelected
        ? `${WHITE}${BOLD}${item.cmd.padEnd(maxCmdLen)}${RESET}`
        : `${item.cmd.padEnd(maxCmdLen)}`;
      const descStr = `${DIM}${item.desc}${RESET}`;

      process.stderr.write(`\n\x1b[2K  ${prefix} ${cmdStr}  ${descStr}`);
      totalRendered++;
    }

    // Scroll-down indicator
    if (hasScrollDown) {
      const remaining = filtered.length - this.scrollOffset - visible;
      process.stderr.write(`\n\x1b[2K  ${DIM}  \u2193 ${remaining} more${RESET}`);
      totalRendered++;
    }

    process.stderr.write('\x1b[u'); // restore cursor
    this.renderedLines = totalRendered;
  }
}

export function startRepl(deps: ReplDeps): ReplState {
  const projects = deps.getProjects();
  const projectSuffix = projects.length === 1 ? ` ${projects[0].projectName}` : '';
  const promptStr = `${PURPLE}ellul${RESET} ${DIM}${projectSuffix} >${RESET} `;
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: promptStr,
    terminal: process.stdin.isTTY ?? false,
  });

  // Menu takes over stdin when active, calls onSelect or onDismiss when done
  const menu = new TypeaheadMenu(
    rl,
    // onSelect: write command to readline and execute
    (cmd: string) => {
      // Ensure readline buffer is clean before writing the selected command
      try {
        (rl as any).line = '';
        (rl as any).cursor = 0;
      } catch { /* proceed */ }
      rl.write(cmd + '\n');
    },
    // onDismiss: no-op, readline prompt already restored by deactivate()
    () => {},
  );

  // Restore persisted active project (survives daemon restart)
  const persistedSlug = readPersistedActiveProject();
  const restoredSlug = persistedSlug && projects.some(p => p.projectSlug === persistedSlug)
    ? persistedSlug
    : null;

  if (restoredSlug) {
    const restoredProject = projects.find(p => p.projectSlug === restoredSlug);
    if (restoredProject) {
      const restoredPrompt = `${PURPLE}ellul${RESET} ${DIM}${restoredProject.projectName} >${RESET} `;
      rl.setPrompt(restoredPrompt);
    }
  }

  const state: ReplState = {
    rl,
    deps,
    gatePromptActive: false,
    activeProjectSlug: restoredSlug,
  };
  _replState = state;

  writeLn();
  writeLn(LOGO);
  writeLn();

  // Status line
  const projectLabel = projects.length === 1
    ? `${WHITE}${projects[0].projectName}${RESET}`
    : `${WHITE}${projects.length} project${projects.length === 1 ? '' : 's'}${RESET}`;
  const tierLabel = `${PURPLE}sovereign${RESET}`;

  writeLn(`  ${DIM}v${VERSION}${RESET}  ${tierLabel}  ${projectLabel}  ${DIM}:${deps.engine.getPort()}${RESET}`);
  writeLn(`  ${DIM}Git credentials on VPS only. Push/pull gated via operator signature.${RESET}`);
  writeLn(`  ${DIM}Type / to see commands${RESET}`);
  writeLn();

  // Intercept '/' as first character to activate typeahead menu.
  // Uses keypress events (non-raw) just for detection — the menu itself
  // switches to raw mode and takes full control of stdin.
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin, rl);

    process.stdin.on('keypress', (_char: string | undefined, _key: readline.Key | undefined) => {
      if (state.gatePromptActive || menu.isActive()) return;

      // Detect '/' as first character on an empty line
      // readline hasn't added the char to its buffer yet at this point
      if (_char === '/' && !((rl as any).line ?? '')) {
        // Prevent readline from processing this '/' — we'll handle it
        // Activate the menu on next tick (after this keypress event completes)
        setImmediate(() => {
          if (!menu.isActive()) {
            menu.activate();
          }
        });
      }
    });
  }

  rl.prompt();

  rl.on('line', async (line) => {
    // Don't process input while a gate prompt is active
    if (state.gatePromptActive) return;

    try {
      await dispatch(state, line);
    } catch (err) {
      error(`Command error: ${err}`);
    }

    if (!state.gatePromptActive) {
      rl.prompt();
    }
  });

  rl.on('close', () => {
    writeLn(`\n${DIM}Bye.${RESET}`);
    // Signal shutdown to daemon instead of force-exiting.
    // The daemon's graceful shutdown handler (SIGINT/SIGTERM) will
    // flush sync state, close connections, and exit cleanly.
    process.kill(process.pid, 'SIGINT');
  });

  return state;
}
