// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Workflow handlers (Caddy, PM2, service reloads). Runs as $SVC_USER.
// Thin clients POST here; all security logic runs server-side.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync, execFileSync, spawn } from 'child_process';
import { readRuntimeEnv, readEnvFile, writeEnvFile, listSecrets, buildNulDelimitedEnv } from '../application/vault/Secrets';
import { sandboxIdFromPath, sandboxIdFromCwd, tryParseSandboxId, parseSandboxId, isSandboxId, type SandboxId } from '@ellul.ai/types';
import { cleanupSandboxCrossProjectAccess } from '../application/organization/CrossProject';
import { runScopeCheck } from '../application/gates/GateScopeCheck';
import { getScopeConfusionDenialStats } from '@vps/shared/cross-project-scope';
import { recordExposure } from '../application/audit/Exposure';
import { CONSOLE_ORIGIN, APP_ZONE } from '../config';
import {
  createShieldedNamespace,
  applyWhitelist,
  execInNamespace,
  destroyNamespace,
  toNsName,
} from '../application/process/Netns';
import { resolveDestinations } from '../application/gates/Whitelist';
import { scanForEnvLeaks } from '../application/audit/EnvScanner';
import {
  verifySyncReceipt,
  getWorkspaceLock,
  type SyncReceipt,
} from '../application/platform/SyncReceipt';
import { SVC_USER, SVC_HOME } from '../config';
import {
  grantGate,
  revokeGate,
  isGateOpen,
  getGateGrant,
  getGateStatus,
  getGateRemainingMs,
  isGateOpenForApp,
  grantGateForApp,
  type GateType,
} from '../application/gates/Gate';
import {
  setPermission,
  shouldAutoGrant,
  shouldAutoDeny,
  getSandboxPermissions,
  getAllPermissions,
  setSessionPermission,
  validateGateType,
  VALID_GATE_TYPES,
  type GatePermission,
} from '../application/gates/GatePermissions';
import { logStore } from '../application/process/Netns';
import { createRedactor } from '../application/audit/LogRedaction';
import { logAuditEvent } from '../application/audit/Audit';
import { isWalletEnabled } from '../application/wallets/WalletFeature';
// Wallet service imports are LAZY — @solana/web3.js may not be installed.
// Use dynamic import() inside isWalletEnabled() guards only.
import {
  isPostgresAvailable,
  ensurePostgresAvailable,
  createAppDatabase,
  getAppDatabaseInfo,
  deleteAppDatabase,
  classifySql,
  requiredGateForSql,
  executeQuery,
  createTempMigrateRole,
  getActiveTempRole,
  backupAppDatabase,
  restoreAppDatabase,
  listAppBackups,
  validateConnectionUrl,
  loadDbConfig,
  saveDbConfig,
  resolveConnectionUrl,
} from '../application/database/Database';
import {
  testConnection as testExternalConnAsync,
  saveEncryptedUrl,
} from '../application/database/ExternalPg';
import { getCurrentTier } from '../application/gates/Tier';

// CRITICAL: use async exec (not execSync) for any git op that triggers the credential helper —
// the helper calls back to this server; execSync would deadlock the event loop.
// SECURITY: script arg must be a static literal; pass dynamic values via args ($1, $2, ...).

// $SVC_USER uid/gid cached at load. Git ops under /home/dev/projects/... must run as this user
// (shield-runner isn't in `dev` group → EACCES on worktree mkdir).
let SVC_UID_CACHE: number | null = null;
let SVC_GID_CACHE: number | null = null;
function getSvcIds(): { uid: number; gid: number } {
  if (SVC_UID_CACHE !== null && SVC_GID_CACHE !== null) {
    return { uid: SVC_UID_CACHE, gid: SVC_GID_CACHE };
  }
  const uid = parseInt(execFileSync('id', ['-u', SVC_USER], { encoding: 'utf8', timeout: 2000 }).trim(), 10);
  const gid = parseInt(execFileSync('id', ['-g', SVC_USER], { encoding: 'utf8', timeout: 2000 }).trim(), 10);
  if (!Number.isFinite(uid) || !Number.isFinite(gid)) {
    throw new Error(`Cannot resolve uid/gid for SVC_USER=${SVC_USER}`);
  }
  SVC_UID_CACHE = uid;
  SVC_GID_CACHE = gid;
  return { uid, gid };
}

function execAsync(
  script: string,
  args: string[],
  opts?: { timeout?: number; env?: NodeJS.ProcessEnv; uid?: number; gid?: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('bash', ['-c', script, '_', ...args], {
      env: opts?.env || process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // setuid/setgid via CAP_SETUID/CAP_SETGID ambient caps. Needed so git writes into
      // /home/dev/projects/sbx-*/ (root:dev 0775) as the dev user.
      ...(typeof opts?.uid === 'number' ? { uid: opts.uid } : {}),
      ...(typeof opts?.gid === 'number' ? { gid: opts.gid } : {}),
    });
    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = opts?.timeout ? setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
    }, opts.timeout) : null;

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (killed) {
        reject(new Error('Command timed out'));
      } else if (code === 0) {
        resolve(stdout);
      } else {
        const err = new Error(stderr || stdout || `Process exited with code ${code}`);
        (err as any).stdout = stdout;
        (err as any).stderr = stderr;
        reject(err);
      }
    });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}
import type { Context, Hono } from 'hono';
import { RESERVED_PORTS } from '@vps/shared/constants';
import { reloadCaddy } from '@vps/shared/caddy';
import { findAppRoot, detectFramework, detectPackageManager, getStartCommand, getInstallCommand, resolveModule } from '@vps/shared/framework';
import { validateCodeSession } from './token.routes';
import { parseCookies } from '../utils/cookie';
import { verifyPopSignature } from '../auth/pop';
import { db } from '../database';
import { POP_TIMESTAMP_TOLERANCE_MS, API_URL_FILE, SERVER_ID_FILE } from '../config';
import {
  resolveCredentialSession,
  createCredentialSession,
  deleteCredentialSession,
  resolveProjectDir,
  buildAppSuffix,
  safeGitCmd,
  stampCoAuthor,
  getGitCredential,
} from '../application/credentials/GitCredentials';

const DOMAIN_FILE = '/etc/ellul/domain';
const CADDYFILE = '/etc/caddy/Caddyfile';
const SITES_DIR = '/etc/caddy/sites-enabled';
const APP_ROUTES_DIR = '/etc/caddy/app-routes.d';
const CF_CA_FILE = '/etc/caddy/cf-origin-pull-ca.pem';
// Shielded PM2 home: root:shield 2770, hides deployed apps from agent's `pm2 jlist`.
const PM2_SHIELDED_HOME = '/etc/ellul/pm2-shielded';

function getUserInfo(): { user: string; home: string; appsDir: string } {
  return { user: SVC_USER, home: SVC_HOME, appsDir: `${SVC_HOME}/.ellul/apps` };
}

// Top-level project name from full path. /home/dev/projects/myapp/packages/web → "myapp".
function deriveProjectName(projectPath: string | null | undefined, home: string): string | null {
  if (!projectPath) return null;
  const projectsDir = `${home}/projects`;
  const rel = path.relative(projectsDir, projectPath);
  if (rel.startsWith('..') || rel === '.') return null;
  return rel.split('/')[0] || null;
}

function getServerDomain(): string {
  try {
    return fs.readFileSync(DOMAIN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

function isProxiedMode(): boolean {
  try {
    const caddyfile = fs.readFileSync(CADDYFILE, 'utf8');
    return caddyfile.includes('auto_https off');
  } catch {
    return false;
  }
}

function getCfCaBase64(): string {
  try {
    const pem = fs.readFileSync(CF_CA_FILE, 'utf8');
    return pem
      .split('\n')
      .filter(line => !line.startsWith('-----'))
      .join('');
  } catch {
    return '';
  }
}

// Any HTTP response (100-599) counts as alive.
function isHttpAlive(port: number, host: string = 'localhost'): boolean {
  try {
    const code = execFileSync(
      'curl',
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '3', `http://${host}:${port}`],
      { stdio: 'pipe', timeout: 5000, encoding: 'utf8' },
    ).trim();
    return /^[1-5]\d{2}$/.test(code);
  } catch {
    return false;
  }
}

// Healthy = 2xx/3xx only; 4xx/5xx error pages are not healthy.
function isHttpHealthy(port: number, host: string = 'localhost'): { alive: boolean; healthy: boolean; httpStatus: number } {
  try {
    const code = execFileSync(
      'curl',
      ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-m', '3', `http://${host}:${port}`],
      { stdio: 'pipe', timeout: 5000, encoding: 'utf8' },
    ).trim();
    const httpStatus = parseInt(code, 10);
    if (isNaN(httpStatus)) return { alive: false, healthy: false, httpStatus: 0 };
    return {
      alive: httpStatus >= 100 && httpStatus < 600,
      healthy: httpStatus >= 200 && httpStatus < 400,
      httpStatus,
    };
  } catch {
    return { alive: false, healthy: false, httpStatus: 0 };
  }
}

function isPortOccupied(p: number): boolean {
  try {
    const out = execFileSync('ss', ['-tlnH', 'sport', '=', `:${p}`], {
      stdio: 'pipe',
      timeout: 3000,
      encoding: 'utf8',
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// Walks process tree (bash → npm → node → server) and checks `ss -tlnp`.
function findProcessListeningPort(procName: string): number | null {
  try {
    const rootPid = execFileSync('bash', ['-lc',
      'PM2_HOME="$1" pm2 pid "$2"', '_', PM2_SHIELDED_HOME, procName,
    ], { stdio: 'pipe', timeout: 5000, encoding: 'utf8' }).trim();
    if (!rootPid || rootPid === '0') return null;

    // 3 levels deep: bash → npm → node.
    const pids = new Set<string>([rootPid]);
    const collectChildren = (parentPid: string) => {
      try {
        const children = execFileSync('pgrep', ['-P', parentPid], {
          stdio: 'pipe', timeout: 3000, encoding: 'utf8',
        }).trim();
        if (children) {
          for (const pid of children.split('\n')) {
            if (pid.trim()) pids.add(pid.trim());
          }
        }
      } catch {}
    };

    const level0 = [...pids];
    for (const pid of level0) collectChildren(pid);
    const level1 = [...pids].filter(p => !level0.includes(p));
    for (const pid of level1) collectChildren(pid);
    const level2 = [...pids].filter(p => !level0.includes(p) && !level1.includes(p));
    for (const pid of level2) collectChildren(pid);

    const ssOut = execSync('ss -tlnp', {
      stdio: 'pipe', timeout: 5000, encoding: 'utf8',
    });

    for (const line of ssOut.split('\n')) {
      for (const pid of pids) {
        if (line.includes(`pid=${pid},`) || line.includes(`pid=${pid})`)) {
          const match = line.match(/:(\d+)\s/);
          if (match?.[1]) {
            const port = parseInt(match[1], 10);
            if (port > 0 && port < 65536) return port;
          }
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}

// Returns suffix → {url, port, name} for same-project sibling packages.
function getSiblingDeployments(
  projectName: string,
  currentSandboxId: string,
  appsDir: string,
): Map<string, { url: string; port: number; name: string }> {
  const siblings = new Map<string, { url: string; port: number; name: string }>();
  try {
    const files = fs.readdirSync(appsDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const meta = JSON.parse(fs.readFileSync(`${appsDir}/${file}`, 'utf8'));
        if (meta.project === projectName && meta.name !== currentSandboxId && meta.url) {
          // "myapp-backend" → "backend".
          const prefix = `${projectName}-`;
          const suffix = meta.name.startsWith(prefix)
            ? meta.name.substring(prefix.length)
            : meta.name;
          siblings.set(suffix, { url: meta.url, port: meta.port, name: meta.name });
        }
      } catch {}
    }
  } catch {}
  return siblings;
}

// Framework-agnostic pm2 start via shared registry.
function startPm2Process(
  procName: string,
  port: number,
  projectPath: string,
  siblingUrls?: Map<string, { url: string; port: number; name: string }>,
): { started: boolean } {
  const appRoot = findAppRoot(projectPath);
  const fw = detectFramework(appRoot);

  if (!fw) {
    console.error(`[shield] No recognized framework in ${appRoot} — cannot start process`);
    return { started: false };
  }

  let { command, env } = getStartCommand(fw, port, 'production');
  if (fw.id === 'fastapi') {
    const mod = resolveModule(appRoot);
    command = command.replace(/\bmain:app\b/, `${mod}:app`);
  }

  // SIBLING_URL_*/SIBLING_PORT_* for inter-package communication.
  if (siblingUrls && siblingUrls.size > 0) {
    for (const [suffix, info] of siblingUrls) {
      const envKey = suffix.toUpperCase().replace(/-/g, '_');
      env[`SIBLING_URL_${envKey}`] = info.url;
      env[`SIBLING_PORT_${envKey}`] = String(info.port);
    }
  }

  // Protected log dir — agent must use the gate system to read.
  const safeLogName = procName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const logDir = `/var/log/ellul/apps/${safeLogName}`;
  try {
    execFileSync('bash', ['-c', 'mkdir -p "$1" && chown root:shield "$1" && chmod 2770 "$1"', '_', logDir], { stdio: 'pipe', timeout: 5000 });
  } catch {}

  // SECURITY: env-loader reads NUL-delimited KEY=VALUE pairs from stdin → exports → execs.
  // Secrets never appear in /proc/<pid>/cmdline or ps output. execFileSync array args avoid nested shell escaping.
  const envLoaderPath = '/usr/local/bin/ellul-env-loader.sh';
  const outLog = `${logDir}/out.log`;
  const errLog = `${logDir}/error.log`;

  try {
    console.log(`[shield] Starting "${procName}" on port ${port} (${fw.id}: ${command})`);
    const envBuf = buildNulDelimitedEnv(env);
    // bash -lc: PM2 needs nvm/rbenv/pyenv from login profile.
    execFileSync('bash', ['-lc',
      'PM2_HOME="$1" pm2 start "$2" --name "$3" --cwd "$4" --output "$5" --error "$6" --merge-logs -- bash -lc "$7"',
      '_', PM2_SHIELDED_HOME, envLoaderPath, procName, appRoot, outLog, errLog, command,
    ], { input: envBuf, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
    try {
      execFileSync('bash', ['-lc',
        'PM2_HOME="$1" pm2 save --force 2>/dev/null',
        '_', PM2_SHIELDED_HOME,
      ], { stdio: 'pipe', timeout: 5000 });
    } catch {}
    return { started: true };
  } catch {
    return { started: false };
  }
}

// Shielded process: nftables egress whitelist + read-only source + private /data /tmp + redaction pipe.
function startShieldedProcess(
  procName: string,
  port: number,
  projectPath: string,
  siblingUrls?: Map<string, { url: string; port: number; name: string }>,
): { started: boolean; nsIp: string } {
  const appRoot = findAppRoot(projectPath);
  const fw = detectFramework(appRoot);

  if (!fw) {
    console.error(`[shield] No recognized framework in ${appRoot} — cannot start shielded process`);
    return { started: false, nsIp: '' };
  }

  let { command, env } = getStartCommand(fw, port, 'production');
  if (fw.id === 'fastapi') {
    const mod = resolveModule(appRoot);
    command = command.replace(/\bmain:app\b/, `${mod}:app`);
  }

  if (siblingUrls && siblingUrls.size > 0) {
    for (const [suffix, info] of siblingUrls) {
      const envKey = suffix.toUpperCase().replace(/-/g, '_');
      env[`SIBLING_URL_${envKey}`] = info.url;
      env[`SIBLING_PORT_${envKey}`] = String(info.port);
    }
  }

  // Runtime secrets (org-overlay under sandbox env). projectPath is the
  // absolute project workspace root (e.g. /home/dev/projects/sbx-xyz/my-app);
  // sandboxIdFromCwd locates the slug embedded in the path.
  const sandboxForProc = sandboxIdFromCwd(projectPath);
  const secrets = readRuntimeEnv(sandboxForProc);
  const secretValues: string[] = [];
  for (const [k, v] of secrets) {
    env[k] = v;
    secretValues.push(v);
  }

  // env-shield-preload (defense-in-depth for Node).
  const preloadPath = '/usr/local/lib/ellul/env-shield-preload.cjs';
  const existingNodeOpts = env.NODE_OPTIONS || '';
  env.NODE_OPTIONS = `--require ${preloadPath}${existingNodeOpts ? ' ' + existingNodeOpts : ''}`;

  const destinations = resolveDestinations(secrets);

  // Advisory — does not block deploy.
  const warnings = scanForEnvLeaks(appRoot);
  if (warnings.length > 0) {
    console.warn(`[shield] Env leak scan found ${warnings.length} warning(s) in ${appRoot}:`);
    for (const w of warnings.slice(0, 5)) {
      console.warn(`  ${w.file}:${w.line} — ${w.pattern}`);
    }
  }

  try {
    // IP from port: 10.200.{port%256}.0/30.
    const { nsIp } = createShieldedNamespace(procName, port);
    applyWhitelist(procName, destinations);
    // Secrets flow via stdin, never CLI args.
    console.log(`[shield] Starting shielded "${procName}" on ${nsIp}:${port} (${fw.id}: ${command})`);
    execInNamespace(procName, { command, cwd: appRoot, env }, secretValues);

    return { started: true, nsIp };
  } catch (err) {
    console.error(`[shield] Shielded process start failed for "${procName}":`, (err as Error).message);
    try { destroyNamespace(procName); } catch {}
    return { started: false, nsIp: '' };
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitForHealthy(
  port: number,
  timeoutMs: number,
  intervalMs: number,
  host: string = 'localhost',
): Promise<{ healthy: boolean; httpStatus: number }> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;

  while (Date.now() < deadline) {
    const check = isHttpHealthy(port, host);
    lastStatus = check.httpStatus;

    if (check.healthy) return { healthy: true, httpStatus: lastStatus };

    // Alive with 5xx won't self-fix — bail.
    if (check.alive && check.httpStatus >= 500) {
      return { healthy: false, httpStatus: lastStatus };
    }

    // Don't poll a crashed PM2 process.
    try {
      const raw = execFileSync('bash', ['-lc',
        'PM2_HOME="$1" pm2 jlist 2>/dev/null', '_', PM2_SHIELDED_HOME,
      ], { stdio: 'pipe', timeout: 5000, encoding: 'utf8' });
      const list = JSON.parse(raw);
      const crashed = list.find((p: any) =>
        (p.pm2_env?.status === 'errored' || p.pm2_env?.status === 'stopped') &&
        String(p.pm2_env?.PORT || p.pm2_env?.env?.PORT) === String(port)
      );
      if (crashed) {
        return { healthy: false, httpStatus: 0 };
      }
    } catch {}

    await sleep(intervalMs);
  }

  return { healthy: false, httpStatus: lastStatus };
}

// Fast path checks expected port; fallback detects actual bound port.
async function awaitProcessPort(
  procName: string,
  expectedPort: number,
  timeoutMs: number,
  intervalMs: number,
): Promise<{ port: number; healthy: boolean; httpStatus: number }> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 0;

  while (Date.now() < deadline) {
    const check = isHttpHealthy(expectedPort);
    lastStatus = check.httpStatus;
    if (check.healthy) return { port: expectedPort, healthy: true, httpStatus: lastStatus };

    // Alive but 5xx — bail.
    if (check.alive && check.httpStatus >= 500) {
      return { port: expectedPort, healthy: false, httpStatus: lastStatus };
    }

    // Crash detection — no point polling a dead process
    try {
      const raw = execFileSync('bash', ['-lc',
        'PM2_HOME="$1" pm2 jlist 2>/dev/null', '_', PM2_SHIELDED_HOME,
      ], { stdio: 'pipe', timeout: 5000, encoding: 'utf8' });
      const list = JSON.parse(raw);
      const proc = list.find((p: any) => p.name === procName);
      if (proc?.pm2_env?.status === 'errored' || proc?.pm2_env?.status === 'stopped') {
        return { port: expectedPort, healthy: false, httpStatus: 0 };
      }
    } catch {}

    // Port discovery: check if process bound to a different port
    const actualPort = findProcessListeningPort(procName);
    if (actualPort && actualPort !== expectedPort) {
      const altCheck = isHttpHealthy(actualPort);
      if (altCheck.healthy) {
        console.log(`[shield] Port adaptation: "${procName}" expected port ${expectedPort} but bound to ${actualPort} — using ${actualPort}`);
        return { port: actualPort, healthy: true, httpStatus: altCheck.httpStatus };
      }
    }

    await sleep(intervalMs);
  }

  // Final port discovery attempt at timeout
  const lastPort = findProcessListeningPort(procName);
  if (lastPort && lastPort !== expectedPort) {
    const altCheck = isHttpHealthy(lastPort);
    if (altCheck.healthy) {
      console.log(`[shield] Port adaptation (at timeout): "${procName}" expected port ${expectedPort} but bound to ${lastPort} — using ${lastPort}`);
      return { port: lastPort, healthy: true, httpStatus: altCheck.httpStatus };
    }
  }

  return { port: expectedPort, healthy: false, httpStatus: lastStatus };
}

// First-deploy path; blue-green redeploys use startPm2Process directly.
async function ensureAppProcess(
  name: string,
  requestedPort: number,
  projectPath: string,
  appsDir: string,
  siblingUrls?: Map<string, { url: string; port: number; name: string }>,
): Promise<{ port: number }> {
  // Fast path: reuse healthy process owned by this project (avoids delete-restart cycle on preview handoff).
  try {
    if (!isHttpAlive(requestedPort)) throw new Error('not alive');
    if (!Number.isInteger(requestedPort) || requestedPort < 1 || requestedPort > 65535) {
      throw new Error('invalid port');
    }
    const pid = execFileSync(
      '/bin/sh',
      ['-c', `ss -tlnpH sport = :${requestedPort} 2>/dev/null | grep -oP 'pid=\\K\\d+' | head -1`],
      { stdio: 'pipe', timeout: 3000, encoding: 'utf8' },
    ).trim();
    if (pid && fs.existsSync(`/proc/${pid}/cwd`)) {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === projectPath || cwd.startsWith(projectPath + '/')) {
        console.log(`[shield] Fast-path: reusing healthy process on port ${requestedPort} (pid ${pid})`);
        return { port: requestedPort };
      }
    }
  } catch {}

  try {
    execFileSync('bash', ['-lc',
      'PM2_HOME="$1" pm2 delete "$2" 2>/dev/null', '_', PM2_SHIELDED_HOME, name!,
    ], { stdio: 'pipe', timeout: 5000 });
  } catch {}

  let port = requestedPort;
  if (isPortOccupied(port)) {
    let occupiedBySame = false;
    try {
      const files = fs.readdirSync(appsDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const meta = JSON.parse(fs.readFileSync(`${appsDir}/${file}`, 'utf8'));
          if (meta.port === port && meta.projectPath === projectPath) {
            occupiedBySame = true;
            break;
          }
        } catch {}
      }
    } catch {}

    if (!occupiedBySame) {
      port = findFreePort(port + 1);
    }
  }

  const result = startPm2Process(name, port, projectPath, siblingUrls);
  if (!result.started) {
    throw new Error(`Failed to start PM2 process "${name}" on port ${port}`);
  }

  const healthResult = await awaitProcessPort(name, port, 8000, 500);
  if (healthResult.healthy) {
    if (healthResult.port !== port) {
      console.log(`[shield] ensureAppProcess: port adapted from ${port} to ${healthResult.port}`);
    }
    return { port: healthResult.port };
  }

  let diagnosis = '';
  if (healthResult.httpStatus > 0) {
    diagnosis = ` — HTTP ${healthResult.httpStatus}`;
  }

  try {
    const raw = execFileSync('bash', ['-lc',
      'PM2_HOME="$1" pm2 jlist 2>/dev/null', '_', PM2_SHIELDED_HOME,
    ], { stdio: 'pipe', timeout: 5000, encoding: 'utf8' });
    const list = JSON.parse(raw);
    const proc = list.find((p: any) => p.name === name);
    if (proc?.pm2_env?.status === 'errored') {
      diagnosis += ' — process crashed';
      try {
        const errLogPath = `/var/log/ellul/apps/${name!.replace(/[^a-zA-Z0-9_-]/g, '_')}/error.log`;
        const errContent = fs.readFileSync(errLogPath, 'utf8');
        const lastLine = errContent.split('\n').filter((l: string) => l.trim()).pop() || '';
        if (lastLine) diagnosis += `: ${lastLine.replace(/^\d+\|[^|]+\|\s*/, '')}`;
      } catch {}
    } else if (proc?.pm2_env?.status) {
      diagnosis += ` — PM2 status: ${proc.pm2_env.status}`;
    }
  } catch {}

  try {
    execFileSync('bash', ['-lc',
      'PM2_HOME="$1" pm2 delete "$2" 2>/dev/null', '_', PM2_SHIELDED_HOME, name!,
    ], { stdio: 'pipe', timeout: 5000 });
  } catch {}

  throw new Error(
    `App failed to start on port ${port} (health check timed out after 8s${diagnosis})`
  );
}

function findFreePort(startPort: number): number {
  let candidate = startPort;
  while (candidate <= 65535) {
    if (!RESERVED_PORTS.has(candidate) && !isPortOccupied(candidate)) {
      return candidate;
    }
    candidate++;
  }
  throw new Error('No free ports available');
}

// ── Deployment metrics ────────────────────────────────────────────────────

const deployMetrics = {
  deploys: 0,
  deploysSucceeded: 0,
  deploysFailed: 0,
  rollbacks: 0,
  rollbacksSucceeded: 0,
  rollbacksFailed: 0,
  canaryPromotions: 0,
  canaryPromotionsFailed: 0,
  caddyReloadFailures: 0,
  npmInstallFailures: 0,
  snapshotFailures: 0,
  lockContentions: 0,
  gateOpened: 0,
  gateConsumed: 0,
  gateExpired: 0,
  gateRejected: 0,
  gitPushGateOpened: 0,
  gitPushGateConsumed: 0,
  gitPushGateRejected: 0,
  startedAt: Date.now(),
};

// ── Action gate — one-time tokens for deploy/git-push ────────────────────

type ActionGateType = 'deploy' | 'git-push';

interface ActionGate {
  token: string;
  type: ActionGateType;
  project: string;
  projectRoot: string;
  createdAt: number;
  expiresAt: number;
}

const actionGates = new Map<string, ActionGate>();
const ACTION_GATE_TTL_MS = 300_000;
const MAX_ACTION_GATES = 40;

function gcActionGates(): void {
  const now = Date.now();
  for (const [token, gate] of actionGates) {
    if (now > gate.expiresAt) {
      actionGates.delete(token);
    }
  }
  if (actionGates.size >= MAX_ACTION_GATES) {
    const sorted = [...actionGates.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    const toRemove = sorted.slice(0, sorted.length - MAX_ACTION_GATES + 1);
    for (const [key] of toRemove) actionGates.delete(key);
  }
}

function findGateForProject(project: string): ActionGate | undefined {
  const now = Date.now();
  for (const [, gate] of actionGates) {
    if (gate.project === project && gate.type === 'deploy' && now <= gate.expiresAt) return gate;
  }
  return undefined;
}

// Exported for git.service.ts console-initiated pushes.
export function createActionGate(type: ActionGateType, project: string): string {
  gcActionGates();
  const token = crypto.randomUUID();
  const now = Date.now();
  const topLevel = project.includes('/') ? project.split('/')[0]! : project;
  const gate: ActionGate = {
    token,
    type,
    project: project.toLowerCase().replace(/[^a-z0-9-]/g, ''),
    projectRoot: topLevel.toLowerCase().replace(/[^a-z0-9-]/g, ''),
    createdAt: now,
    expiresAt: now + ACTION_GATE_TTL_MS,
  };
  actionGates.set(token, gate);

  if (type === 'deploy') {
    deployMetrics.gateOpened++;
  } else {
    deployMetrics.gitPushGateOpened++;
  }

  console.log(`[shield] ${type} gate opened for project "${gate.project}" (expires in ${ACTION_GATE_TTL_MS / 1000}s)`);
  return token;
}

setInterval(() => { gcActionGates(); }, 60_000);

// Backfill missing `project` field in existing app metadata.
function migrateAppMetadata(): void {
  try {
    const { home, appsDir } = getUserInfo();
    if (!fs.existsSync(appsDir)) return;
    const files = fs.readdirSync(appsDir).filter(f => f.endsWith('.json'));
    let migrated = 0;
    for (const file of files) {
      try {
        const filePath = `${appsDir}/${file}`;
        const meta = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (meta.project) continue;
        const project = deriveProjectName(meta.projectPath, home);
        if (project) {
          meta.project = project;
          fs.writeFileSync(filePath, JSON.stringify(meta, null, 2));
          migrated++;
        }
      } catch {}
    }
    if (migrated > 0) {
      console.log(`[shield] Migrated ${migrated} app metadata files with project field`);
    }
  } catch {}
}

migrateAppMetadata();

export function registerWorkflowRoutes(app: Hono): void {

  app.get('/api/workflow/metrics', (c) => {
    return c.json({
      ...deployMetrics,
      activeGates: actionGates.size,
      uptimeMs: Date.now() - deployMetrics.startedAt,
    });
  });

  // Gate endpoints need browser-session proof (not agent). Code session = passkey+PoP or JWT.
  function resolveCodeSession(sessionId?: string, cookie?: string): boolean {
    if (sessionId && validateCodeSession(sessionId)) {
      return true;
    }

    if (cookie) {
      const cookies = parseCookies(cookie);
      const cookieSessionId = cookies['__Host-code_session'] || cookies['code_session'];
      if (cookieSessionId && validateCodeSession(cookieSessionId)) {
        return true;
      }
    }

    return false;
  }

  // Requires browser session — prevents agent self-authorization.
  app.post('/api/workflow/deploy-gate', async (c) => {
    let body: { project?: string; sessionId?: string; cookie?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { project, sessionId, cookie } = body;
    if (!project || typeof project !== 'string') {
      return c.json({ error: 'project is required' }, 400);
    }

    if (!resolveCodeSession(sessionId, cookie)) {
      return c.json({ error: 'Valid browser session required to authorize deployment' }, 403);
    }

    const token = createActionGate('deploy', project);
    const gate = actionGates.get(token)!;
    return c.json({ token, expiresAt: gate.expiresAt });
  });

  app.post('/api/workflow/action-gate', async (c) => {
    let body: { action?: string; project?: string; sessionId?: string; cookie?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { action, project, sessionId, cookie } = body;
    if (!action || (action !== 'deploy' && action !== 'git-push')) {
      return c.json({ error: 'action must be "deploy" or "git-push"' }, 400);
    }
    if (!project || typeof project !== 'string') {
      return c.json({ error: 'project is required' }, 400);
    }

    // Require valid browser session — prevents agent from minting tokens directly
    if (!resolveCodeSession(sessionId, cookie)) {
      return c.json({ error: 'Valid browser session required to authorize this action' }, 403);
    }

    const token = createActionGate(action, project);
    const gate = actionGates.get(token)!;
    return c.json({ token, expiresAt: gate.expiresAt });
  });

  // POST /api/workflow/validate-git-push — validate and consume a git-push token (called by pre-push hook)
  app.post('/api/workflow/validate-git-push', async (c) => {
    let body: { token?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ valid: false, error: 'Invalid JSON body' }, 400);
    }

    const { token } = body;
    if (!token || typeof token !== 'string') {
      return c.json({ valid: false, error: 'token is required' }, 400);
    }

    // Atomic consumption: get + delete in same synchronous block.
    // Using delete() return value as the gate ensures no TOCTOU race
    // even if an await is added between validation steps in the future.
    const gate = actionGates.get(token);
    const consumed = actionGates.delete(token);
    if (!gate || !consumed) {
      deployMetrics.gitPushGateRejected++;
      return c.json({ valid: false, error: 'Token not found or already consumed' });
    }

    if (gate.type !== 'git-push') {
      deployMetrics.gitPushGateRejected++;
      return c.json({ valid: false, error: 'Not a git-push token' });
    }

    if (Date.now() > gate.expiresAt) {
      deployMetrics.gitPushGateRejected++;
      return c.json({ valid: false, error: 'Token expired' });
    }

    deployMetrics.gitPushGateConsumed++;
    console.log(`[shield] Git push gate consumed for project "${gate.project}"`);

    return c.json({ valid: true });
  });

  // ── Git Credential & Operation Endpoints ─────────────────────────────
  //
  // These endpoints support the "credentials in memory only" security model.
  // The credential helper calls /api/internal/git-credentials to get auth.
  // The git-flow script calls /api/internal/git-push and /api/internal/git-pull
  // to delegate remote operations to sovereign-shield (which has the credentials).

  // git credential helper callback — sessions are in-process-only.
  app.post('/api/internal/git-credentials', async (c) => {
    let body: { session?: string; host?: string; protocol?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }

    const { session, host, protocol } = body;
    if (!session || typeof session !== 'string') {
      return c.json({ error: 'session is required' }, 400);
    }

    if (host && protocol) {
      if (protocol !== 'https') {
        return c.json({ error: 'https required' }, 400);
      }
    } else {
      console.warn('[shield] git-credentials called without host/protocol — old credential helper');
    }

    const creds = resolveCredentialSession(session, host || undefined);
    if (!creds) {
      return c.json({ error: 'Invalid or expired credential session' }, 403);
    }

    return c.json({ username: creds.username, password: creds.password });
  });

  // Delegated git push. Requires a valid gate token; creds never leave shield.
  app.post('/api/internal/git-push', async (c) => {
    let body: { token?: string; project?: string; force?: boolean; agentPush?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: 'Invalid JSON' }, 400);
    }

    const { token, project, force, agentPush } = body;
    if (!token || typeof token !== 'string') {
      return c.json({ success: false, error: 'Gate token is required' }, 400);
    }
    if (!project || typeof project !== 'string') {
      return c.json({ success: false, error: 'Project is required' }, 400);
    }

    // Validate and consume gate token atomically — safeGitCmd() disables hooks
    // (core.hooksPath=/dev/null) so the pre-push hook never fires to consume it.
    const gate = actionGates.get(token);
    if (!gate) {
      return c.json({ success: false, error: 'Token not found or already consumed' }, 403);
    }
    if (gate.type !== 'git-push') {
      return c.json({ success: false, error: 'Not a git-push token' }, 403);
    }
    if (Date.now() > gate.expiresAt) {
      actionGates.delete(token);
      return c.json({ success: false, error: 'Token expired' }, 403);
    }
    // Consume immediately — single-use enforcement
    actionGates.delete(token);

    // ── Sync receipt verification ──
    // Agent pushes skip receipts — the agent works directly in the git worktree
    // so there is no console→VPS sync step to receipt-bind. The consumed gate
    // token above is the authorization proof.
    if (!agentPush) {
      const receiptHeader = c.req.header('X-Sync-Receipt');
      if (!receiptHeader) {
        return c.json({ error: 'missing_receipt', message: 'X-Sync-Receipt header is required. Sync code before pushing.' }, 400);
      }
      let parsed: SyncReceipt;
      try {
        parsed = JSON.parse(receiptHeader);
      } catch {
        return c.json({ error: 'stale_receipt', message: 'Malformed X-Sync-Receipt header' }, 400);
      }
      const receiptCheck = verifySyncReceipt(parsed, project);
      if (!receiptCheck.valid) {
        return c.json({ error: 'stale_receipt', message: receiptCheck.reason || 'Receipt verification failed' }, 409);
      }
    }

    // Resolve app suffix for credential lookup
    const appSuffix = (project && project !== 'null' && project !== 'default')
      ? buildAppSuffix(project)
      : '';

    const cred = getGitCredential(appSuffix);
    if (!cred?.token || !cred?.provider) {
      return c.json({
        success: false,
        error: 'NO_CREDENTIALS',
        message: `No git credentials configured for "${project}". Link a repository in the console Integrations tab first.`,
      }, 400);
    }

    // Create credential session for this push
    const credSession = createCredentialSession(appSuffix);
    const projectDir = resolveProjectDir(project);
    const pushFlag = force ? '--force-with-lease' : '';

    // Acquire read lock to prevent pushing during an active sync
    const pushLock = getWorkspaceLock(project);
    if (pushLock) await pushLock.acquireRead();

    try {
      const sgit = safeGitCmd();
      const { uid: svcUid, gid: svcGid } = getSvcIds();
      const output = await execAsync(
        'cd -- "$1" && $2 push -u origin HEAD $3 2>&1',
        [projectDir, sgit, pushFlag],
        {
          timeout: 60_000,
          uid: svcUid,
          gid: svcGid,
          env: {
            ...process.env,
            GIT_CREDENTIAL_SESSION: credSession,
            GIT_PUSH_TOKEN: token,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
          },
        },
      );
      return c.json({ success: true, output });
    } catch (err: any) {
      const stderr = (err.stderr || err.stdout || err.message || '').toString().trim();
      const isAuthFailure = /authentication failed|invalid credentials|bad credentials|401|403/i.test(stderr);
      if (isAuthFailure) {
        return c.json({
          success: false,
          error: 'AUTH_FAILED',
          message: `Authentication failed for "${project}". The stored token may have expired or been revoked. Re-link the repository in the console Integrations tab.`,
          detail: stderr,
        }, 500);
      }
      return c.json({ success: false, error: stderr || 'Push failed' }, 500);
    } finally {
      if (pushLock) {
        try { pushLock.releaseRead(); } catch {}
      }
      deleteCredentialSession(credSession);
    }
  });

  // Delegated git pull (no gate token — pulls are safe).
  app.post('/api/internal/git-pull', async (c) => {
    let body: { project?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: 'Invalid JSON' }, 400);
    }

    const { project } = body;
    if (!project || typeof project !== 'string') {
      return c.json({ success: false, error: 'Project is required' }, 400);
    }

    const appSuffix = (project && project !== 'null' && project !== 'default')
      ? buildAppSuffix(project)
      : '';

    const cred = getGitCredential(appSuffix);
    if (!cred?.token || !cred?.provider) {
      return c.json({
        success: false,
        error: 'NO_CREDENTIALS',
        message: `No git credentials configured for "${project}". Link a repository in the console Integrations tab first.`,
      }, 400);
    }

    const credSession = createCredentialSession(appSuffix);
    const projectDir = resolveProjectDir(project);
    const sgit = safeGitCmd();

    // SECURITY: Split into fetch + rebase to prevent trojan hook attacks.
    // fetch is read-only at git protocol level — can't push even if hooks fire.
    // Credential session is deleted before rebase (local op, no creds needed).
    // Every git invocation (fetch, stash, rebase, stash pop) goes through $2 =
    // safeGitCmd so hooks are disabled throughout — a planted post-rewrite
    // hook under shield-runner can't run with creds or mutate state.
    // NOTE: Must use execAsync (not execSync) to avoid deadlocking the event loop —
    // the credential helper calls back to this server during fetch.
    const { uid: svcUid, gid: svcGid } = getSvcIds();
    const baseEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    try {
      await execAsync(
        'cd -- "$1" && $2 fetch origin 2>&1',
        [projectDir, sgit],
        {
          timeout: 60_000,
          uid: svcUid,
          gid: svcGid,
          env: {
            ...baseEnv,
            GIT_CREDENTIAL_SESSION: credSession,
          },
        },
      );
    } catch (err: any) {
      const stderr = (err.stderr || err.stdout || err.message || '').toString().trim();
      return c.json({ success: false, error: stderr || 'Fetch failed' }, 500);
    } finally {
      deleteCredentialSession(credSession);
    }

    // Rebase is local — no credentials, no remote access possible
    try {
      const branch = execFileSync(
        'git', ['rev-parse', '--abbrev-ref', 'HEAD'],
        { timeout: 5_000, encoding: 'utf8', cwd: projectDir },
      ).trim();
      // Validate branch name — reject anything that isn't a safe git ref.
      // Also reject '..' which is a path-traversal in ref form.
      if (!/^[a-zA-Z0-9\/_.-]+$/.test(branch) || branch.includes('..')) {
        return c.json({ success: false, error: 'Invalid branch name' }, 400);
      }
      // Stash any dirty working tree so rebase can proceed.
      const stashResult = await execAsync(
        'cd -- "$1" && $2 stash 2>&1',
        [projectDir, sgit],
        { timeout: 10_000, uid: svcUid, gid: svcGid, env: baseEnv },
      );
      const didStash = !stashResult.includes('No local changes');
      try {
        const output = await execAsync(
          'cd -- "$1" && $2 rebase "origin/$3" 2>&1',
          [projectDir, sgit, branch],
          { timeout: 60_000, uid: svcUid, gid: svcGid, env: baseEnv },
        );
        return c.json({ success: true, output: output.trim() });
      } finally {
        // Restore stashed changes
        if (didStash) {
          try {
            await execAsync('cd -- "$1" && $2 stash pop 2>&1', [projectDir, sgit], { timeout: 10_000, uid: svcUid, gid: svcGid, env: baseEnv });
          } catch {}
        }
      }
    } catch (err: any) {
      const stderr = (err.stderr || err.stdout || err.message || '').toString().trim();
      return c.json({ success: false, error: stderr || 'Rebase failed' }, 500);
    }
  });

  // Delegated git fetch (fetch-only, no gate token).
  app.post('/api/internal/git-fetch', async (c) => {
    let body: { project?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: 'Invalid JSON' }, 400);
    }

    const { project } = body;
    if (!project || typeof project !== 'string') {
      return c.json({ success: false, error: 'Project is required' }, 400);
    }

    const appSuffix = (project && project !== 'null' && project !== 'default')
      ? buildAppSuffix(project)
      : '';

    const credSession = createCredentialSession(appSuffix);
    const projectDir = resolveProjectDir(project);
    const sgit = safeGitCmd();

    try {
      const output = await execAsync(
        'cd -- "$1" && $2 fetch origin 2>&1',
        [projectDir, sgit],
        {
          timeout: 60_000,
          env: {
            ...process.env,
            GIT_CREDENTIAL_SESSION: credSession,
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
          },
        },
      );
      return c.json({ success: true, output: output || '' });
    } catch (err: any) {
      const stderr = (err.stderr || err.stdout || err.message || '').toString().trim();
      return c.json({ success: false, error: stderr || 'Fetch failed' }, 500);
    } finally {
      deleteCredentialSession(credSession);
    }
  });

  // git-link delegate: shield (in `shield` group) reads ai-proxy-token (root:shield 640);
  // file-api is deliberately excluded from the group. Pre-stages __GIT_TOKEN__<APP> before clone.
  app.post('/api/internal/git-link', async (c) => {
    let body: {
      provider?: string;
      repoFullName?: string;
      repoUrl?: string;
      defaultBranch?: string;
      isPrivate?: boolean;
      sandboxId?: string;
      vpsConfirmToken?: string;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: 'Invalid JSON' }, 400);
    }

    const { provider, repoFullName, repoUrl, defaultBranch, isPrivate, sandboxId, vpsConfirmToken } = body;
    if (!provider || typeof provider !== 'string') {
      return c.json({ success: false, error: 'provider is required' }, 400);
    }
    if (!['github', 'gitlab', 'bitbucket'].includes(provider)) {
      return c.json({ success: false, error: `Unsupported provider: ${provider}` }, 400);
    }
    if (!repoFullName || typeof repoFullName !== 'string') {
      return c.json({ success: false, error: 'repoFullName is required' }, 400);
    }
    if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repoFullName)) {
      return c.json({ success: false, error: 'Invalid repository name format' }, 400);
    }
    if (!repoUrl || typeof repoUrl !== 'string') {
      return c.json({ success: false, error: 'repoUrl is required' }, 400);
    }
    // Defense-in-depth: reject anything that isn't an https URL on a known
    // git host. The platform also validates, but catching it here avoids
    // round-tripping bad input.
    try {
      const parsed = new URL(repoUrl);
      if (parsed.protocol !== 'https:') {
        return c.json({ success: false, error: 'repoUrl must be https' }, 400);
      }
    } catch {
      return c.json({ success: false, error: 'repoUrl is not a valid URL' }, 400);
    }
    if (!defaultBranch || typeof defaultBranch !== 'string') {
      return c.json({ success: false, error: 'defaultBranch is required' }, 400);
    }
    if (typeof isPrivate !== 'boolean') {
      return c.json({ success: false, error: 'isPrivate is required' }, 400);
    }
    if (!sandboxId || typeof sandboxId !== 'string') {
      return c.json({ success: false, error: 'sandboxId is required' }, 400);
    }
    // Match the file-api-side validation for the on-disk app path shape
    // (`sbx-xxx/<subdir>`). The platform /link endpoint accepts any string,
    // so we tighten it here to keep the secret suffix aligned with the
    // buildAppSuffix() lookup in git-clone.
    const appSegments = sandboxId.split('/');
    if (
      appSegments.length !== 2 ||
      !isSandboxId(appSegments[0]!) ||
      !/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(appSegments[1]!)
    ) {
      return c.json({ success: false, error: 'sandboxId must be `sbx-xxxxxxx/<subdir>`' }, 400);
    }
    // Passkey confirm token is optional here — standard-tier servers won't
    // need it, locked-tier servers must provide it. We don't attempt to
    // judge the tier from shield; the platform's tierAuth is the single
    // source of truth and will 403 if the token is required but missing.
    // Validate shape only (hex from crypto.randomBytes(32) → 64 chars).
    if (vpsConfirmToken !== undefined) {
      if (typeof vpsConfirmToken !== 'string' || !/^[0-9a-f]{64}$/.test(vpsConfirmToken)) {
        return c.json({ success: false, error: 'vpsConfirmToken has invalid shape' }, 400);
      }
    }

    let apiUrl: string;
    let serverId: string;
    let aiProxyToken: string;
    try {
      apiUrl = fs.readFileSync(API_URL_FILE, 'utf8').trim();
      serverId = fs.readFileSync(SERVER_ID_FILE, 'utf8').trim();
      aiProxyToken = fs.readFileSync('/etc/ellul-bootstrap/ai-proxy-token', 'utf8').trim();
    } catch (err: any) {
      return c.json({ success: false, error: `Platform credentials unavailable: ${err.message}` }, 500);
    }
    if (!apiUrl || !serverId || !aiProxyToken) {
      return c.json({ success: false, error: 'Platform credentials empty on disk' }, 500);
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        // Attach the passkey confirm token on locked tiers. The platform's
        // tierAuth enforces it — we just faithfully relay what file-api
        // passed in. aiProxyToken on its own is NOT accepted as a substitute
        // on locked tiers; that guarantee lives on the platform side.
        const platformHeaders: Record<string, string> = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${aiProxyToken}`,
        };
        if (vpsConfirmToken) {
          platformHeaders['X-VPS-Confirm-Token'] = vpsConfirmToken;
        }
        const resp = await fetch(`${apiUrl}/api/git/servers/${serverId}/link`, {
          method: 'POST',
          headers: platformHeaders,
          body: JSON.stringify({
            provider,
            repoFullName,
            repoUrl,
            defaultBranch,
            isPrivate,
            sandboxId,
            skipSetup: true,
          }),
          signal: controller.signal,
        });
        if (!resp.ok) {
          let message = `Platform /link failed (HTTP ${resp.status})`;
          try {
            const errBody = await resp.json() as { message?: string; error?: string };
            if (errBody.message) message = errBody.message;
            else if (errBody.error) message = errBody.error;
          } catch {
            // Non-JSON error body — keep the HTTP-status message
          }
          return c.json({ success: false, error: message }, resp.status as 400 | 401 | 403 | 404 | 500);
        }
        return c.json({ success: true });
      } finally {
        clearTimeout(timer);
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return c.json({ success: false, error: 'Platform /link request timed out' }, 504);
      }
      return c.json({ success: false, error: `Platform /link request failed: ${err.message}` }, 502);
    }
  });

  // Delegated git clone — creds never leave shield's memory.
  app.post('/api/internal/git-clone', async (c) => {
    let body: { provider?: string; repoFullName?: string; targetPath?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: 'Invalid JSON' }, 400);
    }

    const { provider, repoFullName, targetPath } = body;
    if (!provider || !repoFullName || !targetPath) {
      return c.json({ success: false, error: 'provider, repoFullName, and targetPath are required' }, 400);
    }
    if (typeof provider !== 'string' || typeof repoFullName !== 'string' || typeof targetPath !== 'string') {
      return c.json({ success: false, error: 'Invalid parameter types' }, 400);
    }

    // Validate repoFullName format
    if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repoFullName)) {
      return c.json({ success: false, error: 'Invalid repository name format' }, 400);
    }

    // Validate targetPath — absolute, no shell metacharacters, inside a sandbox.
    // Layout rule: target must be `$SVC_HOME/projects/sbx-xxxxxxx/<subdir>` and
    // the target subdir must NOT already exist (git creates it). Rejecting pre-
    // existing targets prevents overwriting an app that's already scaffolded.
    const resolvedTarget = path.resolve(targetPath);
    if (resolvedTarget !== targetPath || !/^[a-zA-Z0-9\/_.-]+$/.test(targetPath)) {
      return c.json({ success: false, error: 'Invalid target path' }, 400);
    }
    const projectsRoot = `${SVC_HOME}/projects`;
    const rel = path.relative(projectsRoot, resolvedTarget);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return c.json({ success: false, error: 'Target path must be inside the projects directory' }, 400);
    }
    const segments = rel.split('/').filter(Boolean);
    if (segments.length !== 2) {
      return c.json({ success: false, error: 'Target path must be exactly `<projects>/sbx-xxxxxxx/<subdir>`' }, 400);
    }
    if (!isSandboxId(segments[0]!)) {
      return c.json({ success: false, error: 'Target path parent must be a sandbox slug' }, 400);
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(segments[1]!)) {
      return c.json({ success: false, error: 'Target subdirectory name is not a valid app name' }, 400);
    }
    // Parent must exist (sandbox was provisioned), target must not (git creates it).
    const parentDir = path.join(projectsRoot, segments[0]!);
    if (!fs.existsSync(parentDir)) {
      return c.json({ success: false, error: 'Sandbox does not exist' }, 404);
    }
    if (fs.existsSync(resolvedTarget)) {
      return c.json({ success: false, error: 'Target directory already exists' }, 409);
    }

    // Build clone URL (without credentials — credential helper handles auth)
    let cloneUrl: string;
    switch (provider) {
      case 'github': cloneUrl = `https://github.com/${repoFullName}.git`; break;
      case 'gitlab': cloneUrl = `https://gitlab.com/${repoFullName}.git`; break;
      case 'bitbucket': cloneUrl = `https://bitbucket.org/${repoFullName}.git`; break;
      default: return c.json({ success: false, error: `Unsupported provider: ${provider}` }, 400);
    }

    // Resolve app suffix — derived from the on-disk nested app path
    // (`sbx-xxx/<subdir>`) that the target points at. file-api calls the
    // platform's `/api/git/servers/:id/link` with the same `sandboxId` immediately
    // before this endpoint, so the suffix here MUST match what was used to
    // encrypt-and-store `__GIT_TOKEN__<APP>` in the DB. Otherwise
    // `syncSecretsFromApi()` below will pull the secret into memory but the
    // credential-helper lookup will miss and the clone will attempt anonymous
    // auth. Using `${segments[0]}/${segments[1]}` is the canonical form —
    // matches the app's directory path and is stable for subsequent
    // push/pull/fetch which pass `project` in the same shape.
    const sandboxIdForSuffix = `${segments[0]}/${segments[1]}`;
    const appSuffix = buildAppSuffix(sandboxIdForSuffix);

    // Pull the freshly-linked git token into shield's in-memory credential
    // store. The wizard stages the encrypted token via `/api/git/servers/:id/link`
    // immediately before calling this endpoint; without this sync the
    // credential helper would miss the lookup and git would attempt an
    // anonymous clone, which silently fails for private repos.
    // Deferred import avoids a circular dependency with git.service.
    try {
      const { syncSecretsFromApi } = await import('../application/credentials/Git');
      syncSecretsFromApi();
    } catch (err: any) {
      console.warn('[shield] git-clone: secrets sync failed (proceeding anyway)', err.message);
    }

    const credSession = createCredentialSession(appSuffix);
    const sgit = safeGitCmd();

    try {
      // SECURITY: Pass dynamic values as positional args — never interpolate into shell
      // CRITICAL: Must use execAsync (not execFileSync) — the credential helper
      // running as a git subprocess calls back to this server via HTTP during
      // the clone, and a blocking exec would deadlock the event loop, leaving
      // the credential callback stranded and the clone hanging until timeout.
      //
      // PRIVILEGE: Spawn as the service user, not shield-runner. Shield-runner
      // isn't in the `dev` group, so it cannot create the worktree directory
      // inside `/home/dev/projects/sbx-*/` (root:dev 0775). Shield has
      // `CAP_SETUID`/`CAP_SETGID` in AmbientCapabilities, making this the
      // intended delegation path — see systemd-unit comment in bundle.ts.
      const { uid: svcUid, gid: svcGid } = getSvcIds();
      const output = await execAsync(
        '$1 clone -- "$2" "$3" 2>&1',
        [sgit, cloneUrl, resolvedTarget],
        {
          timeout: 120_000,
          uid: svcUid,
          gid: svcGid,
          env: {
            ...process.env,
            // SECURITY: neutralise external git-config lookups. The spawned
            // git runs as `dev` (the service user), whose home is
            // agent-writable. A malicious ~/.gitconfig planted by the
            // agent could use `url.X.insteadOf = ...` to rewrite the
            // remote URL to an attacker-controlled host — the credential
            // helper would then hand the shield-issued token to that host,
            // a token-exfiltration path through a git config side channel.
            //
            // `-c` flags on the command line override individual keys but
            // don't neutralise URL rewriting (no single key to set). The
            // only sound defence is to stop git from reading external
            // config at all: skip the system file and point the global
            // config at /dev/null. Only `-c` flags (hardened via
            // safeGitCmd) and the fresh `.git/config` that git writes
            // itself during clone are honoured.
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: '/dev/null',
            // HOME must still be a traversable directory — some git
            // internals stat it even when config resolution is disabled.
            // `/` is read-only to the service user, which is fine.
            HOME: '/',
            GIT_CREDENTIAL_SESSION: credSession,
          },
        },
      );
      return c.json({ success: true, output });
    } catch (err: any) {
      // execAsync attaches stdout/stderr as *strings*, so plain truthy-checks
      // work — no Buffer-length dance needed. We intentionally prefer stdout
      // here because the command pipes `2>&1`, so git's real error lives in
      // stdout and stderr is the empty tail.
      const raw = (err.stdout || err.stderr || err.message || '').toString().trim();
      return c.json({ success: false, error: raw || 'Clone failed' }, 500);
    } finally {
      deleteCredentialSession(credSession);
    }
  });

  // Privileged expose: validates tier, generates Caddy config, reloads.
  app.post('/api/workflow/expose', async (c) => {
    deployMetrics.deploys++;
    let body: {
      name?: string;
      port?: number;
      customDomain?: string;
      projectPath?: string;
      stack?: string;
      deployToken?: string;
    };

    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    // ── Deploy gate enforcement ──────────────────────────────────────
    const deployToken = body.deployToken;
    if (!deployToken || typeof deployToken !== 'string') {
      deployMetrics.gateRejected++;
      return c.json({
        error: 'Deploy not authorized. The user must click the Deploy button in the console to authorize deployment.',
      }, 403);
    }

    // Atomic consumption: get + delete in same synchronous block
    const gate = actionGates.get(deployToken);
    const consumed = actionGates.delete(deployToken);
    if (!gate || !consumed) {
      deployMetrics.gateRejected++;
      return c.json({
        error: 'Deploy token is invalid or expired. Request a new deployment from the console.',
      }, 403);
    }

    if (gate.type !== 'deploy') {
      deployMetrics.gateRejected++;
      return c.json({
        error: 'Not a deploy token. This token cannot be used for deployment.',
      }, 403);
    }

    if (Date.now() > gate.expiresAt) {
      deployMetrics.gateExpired++;
      deployMetrics.gateRejected++;
      return c.json({
        error: 'Deploy token has expired. Request a new deployment from the console.',
      }, 403);
    }

    deployMetrics.gateConsumed++;
    console.log(`[shield] Deploy gate consumed for project "${gate.project}"`);

    const { customDomain, projectPath, stack } = body;
    let name = body.name;
    let port = body.port || 3001;

    // ── PROJECT ISOLATION: validate projectPath matches gate project ──
    if (gate.projectRoot && projectPath) {
      const { home } = getUserInfo();
      const derivedProject = deriveProjectName(projectPath, home);
      if (derivedProject && derivedProject !== gate.projectRoot) {
        deployMetrics.gateRejected++;
        return c.json({
          error: `Project mismatch: deploy authorized for "${gate.projectRoot}" but targets "${derivedProject}"`,
        }, 403);
      }
    }

    // ── Sync receipt verification (REQUIRED) ──
    const deployReceiptHeader = c.req.header('X-Sync-Receipt');
    if (!deployReceiptHeader) {
      return c.json({ error: 'missing_receipt', message: 'X-Sync-Receipt header is required. Sync code before deploying.' }, 400);
    }
    const deployProject = gate.project || (gate.projectRoot as string | undefined);
    {
      let parsed: SyncReceipt;
      try {
        parsed = JSON.parse(deployReceiptHeader);
      } catch {
        return c.json({ error: 'stale_receipt', message: 'Malformed X-Sync-Receipt header' }, 400);
      }
      if (deployProject) {
        const receiptCheck = verifySyncReceipt(parsed, deployProject);
        if (!receiptCheck.valid) {
          return c.json({ error: 'stale_receipt', message: receiptCheck.reason || 'Receipt verification failed' }, 409);
        }
      }
    }

    // ── Validate inputs ──────────────────────────────────────────────
    if (!name) {
      return c.json({ error: 'name is required' }, 400);
    }

    // Sanitize name
    name = name.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!name) {
      return c.json({ error: 'Invalid app name (alphanumeric and hyphens only)' }, 400);
    }

    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      return c.json({ error: `Invalid port: ${port} (must be 1024-65535)` }, 400);
    }

    if (RESERVED_PORTS.has(port)) {
      return c.json({ error: `Port ${port} is reserved for ellul internal services` }, 400);
    }

    // ── Resolve user paths ─────────────────────────────────────────
    // billingGateMiddleware enforces paid-only on POST /api/workflow/expose
    const { appsDir } = getUserInfo();

    // SECURITY: Validate customDomain to prevent command injection and Caddy config injection
    if (customDomain && !/^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(customDomain)) {
      return c.json({ error: 'Invalid custom domain format' }, 400);
    }

    // ── Ensure directories exist ─────────────────────────────────────
    try {
      fs.mkdirSync(SITES_DIR, { recursive: true });
      fs.mkdirSync(APP_ROUTES_DIR, { recursive: true });
      fs.mkdirSync(appsDir, { recursive: true });
    } catch {}

    // ── Load existing apps (for duplicate detection) ─────────────────
    let currentApps: string[] = [];
    try {
      currentApps = fs.readdirSync(appsDir).filter(f => f.endsWith('.json'));
    } catch {}

    // ── Duplicate detection (same projectPath, different name) ───────
    if (projectPath) {
      for (const file of currentApps) {
        try {
          const meta = JSON.parse(fs.readFileSync(`${appsDir}/${file}`, 'utf8'));
          if (meta.projectPath === projectPath && meta.name !== name) {
            // Clean up old deployment
            const oldName = meta.name;
            try { fs.unlinkSync(`${SITES_DIR}/${oldName}.caddy`); } catch {}
            try { fs.unlinkSync(`${APP_ROUTES_DIR}/${oldName}.caddy`); } catch {}
            try { fs.unlinkSync(`${appsDir}/${oldName}.json`); } catch {}
            name = oldName; // Reuse old name
            break;
          }
        } catch {}
      }
    }

    // ── Acquire read lock during snapshot (prevents sync mid-copy) ──
    const deployLock = (deployReceiptHeader && deployProject) ? getWorkspaceLock(deployProject) : null;
    let deployLockHeld = false;
    if (deployLock) {
      await deployLock.acquireRead();
      deployLockHeld = true;
    }

    // ── Create versioned deployment snapshot ─────────────────────
    // Every deploy takes a fresh snapshot into a timestamped version dir.
    // A 'current' symlink points to the live version, enabling instant rollback.
    let servingPath = projectPath;
    const { home } = getUserInfo();
    // isFirstDeploy is computed INSIDE the lock to prevent race conditions.
    // Two concurrent deploys could both see isFirstDeploy=false, but only one
    // gets the lock — the loser must re-evaluate after acquiring it.
    let isFirstDeploy = true;

    if (projectPath) {
      const appDeployDir = `${home}/.ellul/deployments/${name}`;
      const currentLink = `${appDeployDir}/current`;
      const versionDir = `${appDeployDir}/${Date.now()}`;

      try {
        fs.mkdirSync(versionDir, { recursive: true });

        // Detect package manager from ORIGINAL project (lockfile lives there, not in snapshot)
        const pmInfo = detectPackageManager(projectPath!, `${home}/projects`);
        console.log(`[shield] Package manager: ${pmInfo.pm} (lockfile: ${pmInfo.lockfile})`);

        // Build snapshot WITHOUT killing old process (zero-downtime for redeploys)
        execFileSync(
          'rsync',
          ['-a', '--exclude=node_modules', '--exclude=.git', projectPath + '/', versionDir + '/'],
          { stdio: 'pipe', timeout: 30000 }
        );

        // Copy lockfile to snapshot for reproducible installs.
        // Lockfile may be at monorepo root (above projectPath) — copy to snapshot root.
        if (pmInfo.lockfilePath) {
          try {
            const destLock = path.join(versionDir, pmInfo.lockfile);
            if (!fs.existsSync(destLock)) {
              fs.copyFileSync(pmInfo.lockfilePath, destLock);
            }
          } catch {}
        }

        // Release read lock — snapshot is now a standalone copy, workspace is free
        if (deployLock && deployLockHeld) {
          try { deployLock.releaseRead(); deployLockHeld = false; } catch {}
        }

        // Install deps + build + prune in snapshot
        {
          const snapAppRoot = findAppRoot(versionDir);
          const snapFw = detectFramework(snapAppRoot);
          const needsBuild = !!snapFw?.buildCommand;

          // Determine install command: PM-aware for Node.js, framework-based for others
          let installCmd: string | null = null;
          if (snapFw?.runtime === 'node') {
            installCmd = needsBuild ? pmInfo.installDev : pmInfo.installProd;
            if (pmInfo.preferOffline) installCmd += ` ${pmInfo.preferOffline}`;
          } else {
            installCmd = snapFw ? getInstallCommand(snapFw, needsBuild ? 'dev' : 'production') : null;
          }

          if (installCmd) {
            try {
              console.log(`[shield] Installing deps: ${installCmd}`);
              execFileSync('bash', ['-lc', 'cd -- "$1" && eval "$2" 2>&1', '_', snapAppRoot, installCmd], {
                stdio: 'pipe', timeout: 120000,
              });
            } catch (installErr) {
              const err = installErr as Error & { killed?: boolean; signal?: string };
              const reason = err.killed ? `killed by timeout (${err.signal || 'SIGTERM'}) after 120s` : err.message;
              console.error(`[shield] ${installCmd} failed in snapshot: ${reason}`);
              deployMetrics.npmInstallFailures++;
            }
          }

          // For monorepo nested packages: set NODE_PATH so build tools can find
          // hoisted dependencies in the monorepo root's node_modules.
          let buildEnvPrefix = '';
          if (snapFw?.runtime === 'node' && projectPath!) {
            const projectsDir = `${home}/projects`;
            const relPath = path.relative(projectsDir, projectPath!);
            if (relPath.includes('/')) {
              const rootProject = relPath.split('/')[0]!;
              const rootNm = path.join(projectsDir, rootProject, 'node_modules');
              if (fs.existsSync(rootNm)) {
                buildEnvPrefix = `export NODE_PATH=${JSON.stringify(rootNm)} && `;
                console.log(`[shield] NODE_PATH=${rootNm} (monorepo hoisted deps)`);
              }
            }
          }

          // Build step (e.g. next build, vite build, tsc) — required before production start
          if (snapFw?.buildCommand) {
            try {
              console.log(`[shield] Running build: ${snapFw.buildCommand}`);
              execFileSync('bash', ['-lc', 'cd -- "$1" && eval "$2" 2>&1', '_', snapAppRoot, `${buildEnvPrefix}${snapFw.buildCommand}`], {
                stdio: 'pipe', timeout: 600000, // 10 min for builds
              });
              console.log(`[shield] Build complete`);
            } catch (buildErr) {
              const err = buildErr as Error & { killed?: boolean; signal?: string; stdout?: Buffer };
              const reason = err.killed ? `killed by timeout (${err.signal || 'SIGTERM'}) after 600s` : err.message;
              console.error(`[shield] Build failed: ${reason}`);
              // Build failure is fatal — app won't start without it
              return c.json({ error: `Build failed: ${reason}` }, 500);
            }

            // Prune devDeps after build to keep snapshot lean
            if (snapFw.runtime === 'node') {
              try {
                if (pmInfo.prune) {
                  execFileSync('bash', ['-lc', 'cd -- "$1" && eval "$2" 2>&1', '_', snapAppRoot, pmInfo.prune], {
                    stdio: 'pipe', timeout: 60000,
                  });
                } else {
                  // yarn: no prune command — re-run production install to strip devDeps
                  execFileSync('bash', ['-lc', 'cd -- "$1" && eval "$2" 2>&1', '_', snapAppRoot, pmInfo.installProd], {
                    stdio: 'pipe', timeout: 120000,
                  });
                }
              } catch {}
            }
          }

          // Strip hardcoded port/host from start script (Node.js only)
          // Covers PORT=XXXX env style AND CLI flags like -p/-H/--port/--hostname
          if (snapFw?.runtime === 'node') {
            try {
              const pkgPath = `${snapAppRoot}/package.json`;
              const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
              if (pkg.scripts?.start) {
                let s = pkg.scripts.start;
                s = s.replace(/\bPORT=\d+\s*/g, '');
                s = s.replace(/\s+(-p|--port)\s+\d+/g, '');
                s = s.replace(/\s+(-H|--hostname)\s+\S+/g, '');
                s = s.trim();
                if (s !== pkg.scripts.start) {
                  pkg.scripts.start = s;
                  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
                }
              }
            } catch {}
          }
        }

        // Atomic symlink swap: create tmp link then rename over current
        // rename() is atomic on POSIX — guarantees no window where 'current' is missing
        const tmpLink = `${appDeployDir}/.current-tmp-${Date.now()}`;
        fs.symlinkSync(versionDir, tmpLink);
        try {
          fs.renameSync(tmpLink, currentLink);
        } catch (renameErr) {
          try { fs.unlinkSync(tmpLink); } catch {}
          // Symlink swap failed — rollback state will be inconsistent.
          // Serve from the new version dir directly (it's already built).
          console.error(`[shield] Symlink swap failed: ${(renameErr as Error).message} — rollback unavailable for this deploy`);
        }

        // Purge old versions — keep last 3
        try {
          const entries = fs.readdirSync(appDeployDir)
            .filter(e => /^\d+$/.test(e))
            .sort((a, b) => parseInt(a) - parseInt(b));
          const toRemove = entries.slice(0, Math.max(0, entries.length - 3));
          for (const old of toRemove) {
            fs.rmSync(`${appDeployDir}/${old}`, { recursive: true, force: true });
          }
        } catch {}

        servingPath = versionDir;
        console.log(`[shield] Created deployment snapshot v${path.basename(versionDir)}`);
      } catch (e) {
        // Release read lock if still held (rsync may have failed before normal release point)
        if (deployLock && deployLockHeld) {
          try { deployLock.releaseRead(); deployLockHeld = false; } catch {}
        }
        // Cleanup failed version dir
        try { fs.rmSync(versionDir, { recursive: true, force: true }); } catch {}
        console.error(`[shield] Snapshot failed, serving from source: ${(e as Error).message}`);
        deployMetrics.snapshotFailures++;
      }
    }

    // ── Blue-green deploy (zero-downtime for redeploys) ──────────
    const lockFile = `/tmp/ellul-deploy-${name}.lock`;
    // Atomic concurrency guard: O_EXCL fails if file exists (no TOCTOU race)
    try {
      const fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
    } catch {
      // Lock exists — check if stale (>2 min = dead deployer)
      try {
        const lockAge = Date.now() - (fs.statSync(lockFile).mtimeMs || 0);
        if (lockAge < 120000) {
          deployMetrics.lockContentions++;
          deployMetrics.deploysFailed++;
          return c.json({ error: 'Deploy already in progress' }, 409);
        }
        // Stale lock — atomic reclaim: unlink + re-create with O_EXCL.
        // If another process also sees the stale lock, only one reclaim succeeds.
        fs.unlinkSync(lockFile);
        const fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
      } catch {
        deployMetrics.lockContentions++;
        deployMetrics.deploysFailed++;
        return c.json({ error: 'Deploy lock contention' }, 409);
      }
    }

    // Track canary state for cleanup on any error path
    let canaryActive = false;
    const canaryProcName = `${name}__canary`;
    const cleanupCanary = () => {
      if (!canaryActive) return;
      try {
        execFileSync('bash', ['-lc', 'PM2_HOME="$1" pm2 delete "$2" 2>/dev/null', '_', PM2_SHIELDED_HOME, canaryProcName], {
          stdio: 'pipe', timeout: 5000,
        });
      } catch {}
      canaryActive = false;
    };
    const releaseLock = () => {
      try { fs.unlinkSync(lockFile); } catch {}
    };

    // ── Service discovery: compute sibling deployments for env injection ──
    const { home: deployHome } = getUserInfo();
    const projectName = deriveProjectName(projectPath, deployHome);
    const siblings = projectName
      ? getSiblingDeployments(projectName, name!, appsDir)
      : new Map<string, { url: string; port: number; name: string }>();

    // ── Shielded deploy decision: runtime env present → namespace isolation ──
    // `projectPath` is the absolute project workspace root (e.g.
    // /home/dev/projects/sbx-xyz/my-app); sandboxIdFromCwd locates the slug.
    const appSecrets = readRuntimeEnv(sandboxIdFromCwd(projectPath));
    const useShieldedDeploy = appSecrets.size > 0;
    let nsIp: string | null = null;

    try {
      // Evaluate isFirstDeploy INSIDE the lock to prevent race conditions
      isFirstDeploy = !isHttpAlive(port);

      // Clean up stale canary from a crashed prior deploy (not the live process).
      // A canary left from a failed deploy won't be serving on the live port.
      try {
        execFileSync('bash', ['-lc', 'PM2_HOME="$1" pm2 delete "$2" 2>/dev/null', '_', PM2_SHIELDED_HOME, canaryProcName], {
          stdio: 'pipe', timeout: 5000,
        });
      } catch {}

      if (useShieldedDeploy && servingPath) {
        // ── Shielded deploy: network + mount namespace isolation ──
        // Destroy any existing namespace for this app (clean slate)
        try { destroyNamespace(name!); } catch {}
        // Also clean up any existing PM2 process
        try {
          execFileSync('bash', ['-lc', 'PM2_HOME="$1" pm2 delete "$2" 2>/dev/null', '_', PM2_SHIELDED_HOME, name!], {
            stdio: 'pipe', timeout: 5000,
          });
        } catch {}

        const shieldResult = startShieldedProcess(name!, port, servingPath, siblings);
        if (!shieldResult.started) {
          releaseLock();
          deployMetrics.deploysFailed++;
          return c.json({ error: 'Shielded process failed to start' }, 500);
        }
        nsIp = shieldResult.nsIp;

        // Health check on namespace IP (shielded process listens inside namespace)
        const healthCheck = await waitForHealthy(port, 15000, 500, nsIp);
        if (!healthCheck.healthy) {
          destroyNamespace(name!);
          releaseLock();
          deployMetrics.deploysFailed++;
          const reason = healthCheck.httpStatus > 0
            ? `HTTP ${healthCheck.httpStatus}`
            : 'no response';
          return c.json({ error: `Shielded process failed health check (${reason})` }, 500);
        }
      } else if (!isFirstDeploy && servingPath && servingPath !== projectPath) {
        // ── Blue-green: old process stays alive, start canary alongside ──
        const canaryPort = findFreePort(port + 1);

        // Start canary process
        const canaryResult = startPm2Process(canaryProcName, canaryPort, servingPath, siblings);
        if (!canaryResult.started) throw new Error('Canary process failed to start');
        canaryActive = true;

        // Health check canary (500ms polls, 15s timeout) with port detection
        const canaryCheck = await awaitProcessPort(canaryProcName, canaryPort, 15000, 500);

        if (canaryCheck.healthy) {
          // Canary is healthy — swap traffic (use actual port in case of adaptation)
          port = canaryCheck.port;
          // Old process will be cleaned up after Caddy config is written and reloaded (below)
          // We defer the pm2 delete of the old process until after Caddy reload
        } else {
          // Canary failed — kill it, keep old process running
          cleanupCanary();
          releaseLock();
          deployMetrics.deploysFailed++;
          const reason = canaryCheck.httpStatus > 0
            ? `HTTP ${canaryCheck.httpStatus}`
            : 'no response';
          return c.json({
            error: `New version failed health check (${reason}) — old version still running`,
          }, 500);
        }
      } else {
        // First deploy or no snapshot — simple path (no secrets)
        if (isFirstDeploy) {
          // Kill existing process if any (first deploy, no live traffic to protect)
          try {
            execFileSync('bash', ['-lc', 'PM2_HOME="$1" pm2 delete "$2" 2>/dev/null', '_', PM2_SHIELDED_HOME, name!], {
              stdio: 'pipe', timeout: 15000,
            });
          } catch {}
          // Kill orphan on previous port
          try {
            const prevMeta = JSON.parse(fs.readFileSync(`${appsDir}/${name}.json`, 'utf8'));
            if (prevMeta.port) {
              execFileSync('fuser', ['-k', `${prevMeta.port}/tcp`], {
                stdio: 'pipe', timeout: 3000,
              });
            }
          } catch {}
        }

        if (servingPath) {
          try {
            const result = await ensureAppProcess(name!, port, servingPath, appsDir, siblings);
            port = result.port;
          } catch (e) {
            releaseLock();
            return c.json({ error: (e as Error).message }, 500);
          }
        }
      }
    } catch (e) {
      cleanupCanary();
      releaseLock();
      deployMetrics.deploysFailed++;
      return c.json({ error: (e as Error).message }, 500);
    }

    // ── Build domain ─────────────────────────────────────────────────
    const serverDomain = getServerDomain();
    const shortId = (serverDomain.match(/^([a-f0-9]{8})-/) || [])[1] || serverDomain.split('.')[0];
    const appDomain = customDomain || `${shortId}-${name}.${APP_ZONE}`;
    const isCustom = !!customDomain;

    // ── Generate Caddy config ────────────────────────────────────────
    // Proxied mode (gateway/cloudflare): write handler-only route inside the
    // main .app site block via app-routes.d/ — TLS is shared with the main block.
    // Direct mode / custom domain: write standalone site block in sites-enabled/.
    // When shielded, Caddy proxies to namespace IP (10.200.N.2) instead of localhost.
    const proxied = !isCustom && isProxiedMode();
    const proxyTarget = nsIp ? `${nsIp}:${port}` : `localhost:${port}`;
    let caddyConfig: string;
    let configDir: string;

    if (isCustom) {
      // Custom domain — standalone site block, user handles TLS
      configDir = SITES_DIR;
      caddyConfig = `${appDomain} {
    header ?Access-Control-Allow-Origin "${CONSOLE_ORIGIN}"
    header ?Access-Control-Allow-Credentials "true"
    reverse_proxy ${proxyTarget} {
        flush_interval -1
    }
    log {
        output file /var/log/caddy/${name}.log
        format json
    }
}
`;
    } else if (proxied) {
      // Proxied mode — handler-only block imported inside main .app site block.
      // CORS headers are inherited from the .app site block level — no need to add here.
      configDir = APP_ROUTES_DIR;
      // Billing middleware enforces paid-only — no auth block needed for deployed apps
      const authBlock = '';
      caddyConfig = `@app-${name} host ${appDomain}
handle @app-${name} {${authBlock}
    reverse_proxy ${proxyTarget} {
        flush_interval -1
    }
}
`;
    } else {
      // Direct connect — standalone site block with Let's Encrypt
      configDir = SITES_DIR;
      caddyConfig = `${appDomain} {
    header ?Access-Control-Allow-Origin "${CONSOLE_ORIGIN}"
    header ?Access-Control-Allow-Credentials "true"
    reverse_proxy ${proxyTarget} {
        flush_interval -1
    }
    log {
        output file /var/log/caddy/${name}.log
        format json
    }
}
`;
    }

    // ── Write Caddy config ───────────────────────────────────────────
    // Save old config for rollback on Caddy reload failure (blue-green safety)
    const configFile = `${configDir}/${name}.caddy`;
    let oldCaddyConfig = '';
    try { oldCaddyConfig = fs.readFileSync(configFile, 'utf8'); } catch {}
    let oldMetaContent = '';
    const metaFile = `${appsDir}/${name}.json`;
    try { oldMetaContent = fs.readFileSync(metaFile, 'utf8'); } catch {}

    try {
      fs.writeFileSync(configFile, caddyConfig);
    } catch (e) {
      cleanupCanary();
      releaseLock();
      deployMetrics.deploysFailed++;
      return c.json({ error: `Failed to write Caddy config: ${(e as Error).message}` }, 500);
    }

    // ── Write app metadata ───────────────────────────────────────────
    // Billing middleware enforces paid-only on this endpoint — isPreview always false
    const isPreview = false;
    const directory = projectPath ? path.basename(projectPath) : name;
    const { home: metaHome } = getUserInfo();
    const appMeta = {
      name,
      directory,
      port,
      domain: appDomain,
      url: `https://${appDomain}`,
      customDomain: isCustom ? customDomain : null,
      isCustomDomain: isCustom,
      isPreview,
      stack: stack || 'Unknown',
      summary: '',
      createdAt: new Date().toISOString(),
      projectPath: projectPath || null,
      deploymentPath: servingPath !== projectPath ? servingPath : null,
      project: deriveProjectName(projectPath, metaHome),
      shielded: useShieldedDeploy,
      nsName: useShieldedDeploy ? toNsName(name!) : null,
      nsIp,
    };

    try {
      fs.writeFileSync(metaFile, JSON.stringify(appMeta, null, 2));
    } catch (e) {
      // Restore old Caddy config, clean up canary
      if (oldCaddyConfig) { try { fs.writeFileSync(configFile, oldCaddyConfig); } catch {} }
      else { try { fs.unlinkSync(configFile); } catch {} }
      cleanupCanary();
      releaseLock();
      deployMetrics.deploysFailed++;
      return c.json({ error: `Failed to write app metadata: ${(e as Error).message}` }, 500);
    }

    // ── Reload Caddy (admin API validates server-side) ─────────────
    let caddyReloadOk = false;
    try {
      await reloadCaddy();
      caddyReloadOk = true;
    } catch (e) {
      // Reload failed — config may be invalid or Caddy is unresponsive.
      // Restore old config state so file-on-disk stays consistent.
      console.error('[shield] Caddy reload failed:', (e as Error).message?.slice(0, 300));
      if (oldCaddyConfig) { try { fs.writeFileSync(configFile, oldCaddyConfig); } catch {} }
      else { try { fs.unlinkSync(configFile); } catch {} }
      // Retry reload with restored config to keep Caddy in sync with disk
      try { await reloadCaddy(); } catch {}
      deployMetrics.caddyReloadFailures++;
    }

    // ── Blue-green cleanup: retire old process after Caddy points to canary ──
    // SAFETY: Only proceed if Caddy reload succeeded. If it failed, the old
    // config is still active in memory — killing the old process would cause downtime.
    if (canaryActive && !isFirstDeploy && servingPath && servingPath !== projectPath) {
      if (!caddyReloadOk) {
        // Caddy reload failed — abort blue-green. Restore old config so future
        // reloads don't point to the (about to be killed) canary port.
        console.error('[shield] Caddy reload failed during blue-green — aborting, keeping old process');
        if (oldCaddyConfig) { try { fs.writeFileSync(configFile, oldCaddyConfig); } catch {} }
        else { try { fs.unlinkSync(configFile); } catch {} }
        if (oldMetaContent) { try { fs.writeFileSync(metaFile, oldMetaContent); } catch {} }
        else { try { fs.unlinkSync(metaFile); } catch {} }
        cleanupCanary();
        releaseLock();
        deployMetrics.deploysFailed++;
        deployMetrics.caddyReloadFailures++;
        return c.json({ error: 'Caddy reload failed — old version still running' }, 500);
      }

      // Grace period: let Caddy drain connections to old upstream (2s)
      await sleep(2000);

      // 1. Delete old canonical process — Caddy already routes to canary port
      try {
        execFileSync('bash', ['-lc', 'PM2_HOME="$1" pm2 delete "$2" 2>/dev/null', '_', PM2_SHIELDED_HOME, name!], {
          stdio: 'pipe', timeout: 5000,
        });
      } catch {}

      // 2. Promote canary to canonical name: delete canary, immediately restart
      //    under the canonical name on the SAME port. The ~100ms gap is absorbed
      //    by Caddy's automatic retries (reverse_proxy retries on connect failure).
      //    This ensures `pm2 list` shows the canonical name and the next deploy's
      //    stale canary cleanup doesn't kill the live process.
      canaryActive = false; // We're about to delete it intentionally
      try {
        execFileSync('bash', ['-lc', 'PM2_HOME="$1" pm2 delete "$2" 2>/dev/null', '_', PM2_SHIELDED_HOME, canaryProcName], {
          stdio: 'pipe', timeout: 5000,
        });
      } catch {}
      const promoted = startPm2Process(name!, port, servingPath, siblings);
      if (!promoted.started) {
        console.error(`[shield] CRITICAL: Canary promotion failed for "${name}" on port ${port}`);
        deployMetrics.canaryPromotionsFailed++;
        // Caddy is pointing to this port — try one more time
        await sleep(1000);
        const retry = startPm2Process(name!, port, servingPath, siblings);
        if (!retry.started) {
          console.error(`[shield] CRITICAL: Canary promotion retry failed — port ${port} may be unserved`);
        } else {
          deployMetrics.canaryPromotions++;
        }
      } else {
        deployMetrics.canaryPromotions++;
      }

      try { execFileSync('bash', ['-lc', 'PM2_HOME="$1" pm2 save --force 2>/dev/null', '_', PM2_SHIELDED_HOME], { stdio: 'pipe', timeout: 5000 }); } catch {}
    } else if (!caddyReloadOk) {
      // First deploy with failed Caddy reload — retry via admin API after a brief pause.
      console.error('[shield] Caddy reload failed on first deploy — retrying');
      try {
        await sleep(1000);
        await reloadCaddy();
        caddyReloadOk = true;
        console.log('[shield] Caddy reload succeeded on retry');
      } catch {
        // Still failed — app is running but unreachable. Surface this clearly.
        console.error('[shield] CRITICAL: Caddy reload retry failed — app running but not routable');
        deployMetrics.caddyReloadFailures++;
      }
    }

    // Release deploy lock
    releaseLock();
    deployMetrics.deploysSucceeded++;

    // ── Update ellul.json in project root ───────────────────────
    if (projectPath) {
      const psjsonPath = `${projectPath}/ellul.json`;
      try {
        // SECURITY: Use Node.js JSON operations instead of shell jq to prevent injection
        let existing: Record<string, unknown> = {};
        if (fs.existsSync(psjsonPath)) {
          existing = JSON.parse(fs.readFileSync(psjsonPath, 'utf8'));
        }
        existing.name = name; // Sync app name with deployment name
        existing.deployedUrl = `https://${appDomain}`;
        existing.deployedDomain = appDomain;
        existing.deployedPort = port;
        // Include sibling deployment URLs for inter-package discovery
        if (projectName && siblings.size > 0) {
          const siblingMap: Record<string, string> = {};
          for (const [suffix, info] of siblings) {
            siblingMap[suffix] = info.url;
          }
          existing.siblings = siblingMap;
        }
        fs.writeFileSync(psjsonPath, JSON.stringify(existing, null, 2));
      } catch {}
    }

    // ── Restart sibling processes with updated service discovery env vars ──
    // When a new package deploys, existing siblings need the new URL injected
    if (projectName && siblings.size > 0) {
      for (const [, sibInfo] of siblings) {
        try {
          const sibMetaPath = `${appsDir}/${sibInfo.name}.json`;
          if (!fs.existsSync(sibMetaPath)) continue;
          const sibMeta = JSON.parse(fs.readFileSync(sibMetaPath, 'utf8'));
          if (!isHttpAlive(sibMeta.port)) continue; // Not running, skip
          const sibServPath = sibMeta.deploymentPath || sibMeta.projectPath;
          if (!sibServPath) continue;
          // Recompute siblings from the perspective of the sibling app
          const allSibsForSib = getSiblingDeployments(projectName, sibInfo.name, appsDir);
          // Graceful restart: PM2 delete + immediate restart with updated env
          try {
            execFileSync('bash', ['-lc', 'PM2_HOME="$1" pm2 delete "$2" 2>/dev/null', '_', PM2_SHIELDED_HOME, sibInfo.name], {
              stdio: 'pipe', timeout: 5000,
            });
          } catch {}
          startPm2Process(sibInfo.name, sibMeta.port, sibServPath, allSibsForSib);
          console.log(`[shield] Updated sibling "${sibInfo.name}" with new service discovery env`);
        } catch (e) {
          console.error(`[shield] Failed to update sibling ${sibInfo.name}: ${(e as Error).message}`);
        }
      }
    }

    // ── Trigger immediate heartbeat so deployments show in dashboard instantly ──
    try {
      const pid = fs.readFileSync('/run/ellul-enforcer.pid', 'utf8').trim();
      if (pid) {
        execFileSync('kill', ['-USR1', pid], { stdio: 'pipe', timeout: 2000 });
      }
    } catch {}

    // ── Kick off background AI inspection ────────────────────────────
    try {
      execFileSync('bash', ['-c', '/usr/local/bin/ellul-inspect "$1" 2>/dev/null &', '_', name!], {
        stdio: 'pipe',
        timeout: 2000,
      });
    } catch {}

    // ── Build response ───────────────────────────────────────────────
    const previewNote = isPreview
      ? ' (Dev Preview — only you can access this URL)'
      : '';

    const caddyWarning = !caddyReloadOk
      ? `  ⚠ Warning: Caddy reload failed — URL may not be reachable yet. Try: caddy reload`
      : '';

    const message = [
      '',
      `App deployed!`,
      '',
      `  Live at: https://${appDomain}${previewNote}`,
      `  Stack:   ${appMeta.stack}`,
      ...(isCustom ? [`  Note:    Custom domain — ensure DNS points to this server`] : []),
      ...(isPreview ? [`  Tip:     Upgrade to Sovereign tier for public live URLs`] : []),
      ...(caddyWarning ? [caddyWarning] : []),
      '',
      `IMPORTANT: This deploy is a ONE-TIME snapshot. Future code changes will ONLY update the preview, NOT this deployed site. Do NOT redeploy unless the user explicitly asks again.`,
      '',
    ].join('\n');

    return c.json({
      url: `https://${appDomain}`,
      domain: appDomain,
      isPreview,
      name,
      port,
      stack: appMeta.stack,
      message,
    });
  });

  // Swap 'current' symlink to previous version snapshot and restart PM2.
  app.post('/api/workflow/rollback', async (c) => {
    // Require internal service token — prevents agent from rolling back any app directly
    const { validateInternalToken } = await import('../application/credentials/InternalToken');
    if (!validateInternalToken(c.req.header('Authorization'))) {
      return c.json({ error: 'Unauthorized — internal token required' }, 401);
    }

    deployMetrics.rollbacks++;
    const body = await c.req.json().catch(() => ({}));
    const { name } = body as { name?: string };

    if (!name) return c.json({ error: 'name is required' }, 400);

    // Sanitize name same as expose
    const safeName = name.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!safeName) return c.json({ error: 'Invalid app name' }, 400);

    // Acquire deploy lock — prevents race with concurrent deploy/rollback
    const lockFile = `/tmp/ellul-deploy-${safeName}.lock`;
    try {
      const fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
    } catch {
      try {
        const lockAge = Date.now() - (fs.statSync(lockFile).mtimeMs || 0);
        if (lockAge < 120000) {
          return c.json({ error: 'Deploy in progress — cannot rollback now' }, 409);
        }
        fs.unlinkSync(lockFile);
        const fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
      } catch {
        return c.json({ error: 'Deploy lock contention' }, 409);
      }
    }
    const releaseLock = () => { try { fs.unlinkSync(lockFile); } catch {} };

    const { home, appsDir } = getUserInfo();
    const appDeployDir = `${home}/.ellul/deployments/${safeName}`;
    const currentLink = `${appDeployDir}/current`;
    const metaFile = `${appsDir}/${safeName}.json`;

    if (!fs.existsSync(appDeployDir)) {
      releaseLock();
      return c.json({ error: 'No deployment versions found' }, 404);
    }

    // List version directories (numeric timestamps)
    const versions = fs.readdirSync(appDeployDir)
      .filter(e => /^\d+$/.test(e))
      .sort((a, b) => parseInt(a) - parseInt(b));

    if (versions.length < 2) {
      releaseLock();
      return c.json({ error: 'No previous version to roll back to' }, 400);
    }

    // Determine current and previous versions
    const currentVersion = fs.existsSync(currentLink)
      ? path.basename(fs.readlinkSync(currentLink))
      : versions[versions.length - 1]!;
    const currentIdx = versions.indexOf(currentVersion);
    const previousIdx = currentIdx > 0 ? currentIdx - 1 : versions.length - 2;
    const previousVersion = versions[previousIdx];
    const previousDir = `${appDeployDir}/${previousVersion}`;

    if (!fs.existsSync(previousDir)) {
      releaseLock();
      return c.json({ error: 'Previous version directory missing' }, 500);
    }

    // Read current app metadata for port and domain
    let appMeta: Record<string, unknown> = {};
    let port = 3000;
    try {
      appMeta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      port = (appMeta.port as number) || port;
    } catch {}

    // Atomic symlink swap
    const tmpLink = `${appDeployDir}/.current-tmp-${Date.now()}`;
    try {
      fs.symlinkSync(previousDir, tmpLink);
      fs.renameSync(tmpLink, currentLink);
    } catch (e) {
      try { fs.unlinkSync(tmpLink); } catch {}
      releaseLock();
      deployMetrics.rollbacksFailed++;
      return c.json({ error: `Symlink swap failed: ${(e as Error).message}` }, 500);
    }

    // Kill existing processes (canonical + any leftover canary)
    for (const proc of [safeName, `${safeName}__canary`]) {
      try {
        execFileSync('bash', ['-lc', 'PM2_HOME="$1" pm2 delete "$2" 2>/dev/null', '_', PM2_SHIELDED_HOME, proc], {
          stdio: 'pipe', timeout: 5000,
        });
      } catch {}
    }

    // Start from rolled-back version (with sibling service discovery)
    const { home: rollbackHome, appsDir: rollbackAppsDir } = getUserInfo();
    const rollbackProject = deriveProjectName(previousDir, rollbackHome);
    const rollbackSiblings = rollbackProject
      ? getSiblingDeployments(rollbackProject, safeName, rollbackAppsDir)
      : new Map<string, { url: string; port: number; name: string }>();
    const started = startPm2Process(safeName, port, previousDir, rollbackSiblings);
    if (!started.started) {
      releaseLock();
      deployMetrics.rollbacksFailed++;
      return c.json({ error: 'Failed to start rolled-back version' }, 500);
    }

    // Health check the rolled-back version
    const healthCheck = await waitForHealthy(port, 10000, 500);
    if (!healthCheck.healthy) {
      console.error(`[shield] Rollback health check failed (HTTP ${healthCheck.httpStatus})`);
      // Don't abort — the process may still come up, and we've already swapped the symlink
    }

    // Update app metadata with new deployment path
    try {
      appMeta.deploymentPath = previousDir;
      fs.writeFileSync(metaFile, JSON.stringify(appMeta, null, 2));
    } catch {}

    // Caddy reload (config points to same port, but ensures clean state)
    let caddyOk = false;
    try {
      await reloadCaddy();
      caddyOk = true;
    } catch {
      // Retry after brief pause
      try {
        await sleep(1000);
        await reloadCaddy();
        caddyOk = true;
      } catch {
        console.error('[shield] Caddy reload failed during rollback — app may be unreachable');
      }
    }

    try { execFileSync('bash', ['-lc', 'PM2_HOME="$1" pm2 save --force 2>/dev/null', '_', PM2_SHIELDED_HOME], { stdio: 'pipe', timeout: 5000 }); } catch {}

    releaseLock();
    deployMetrics.rollbacksSucceeded++;

    // Trigger heartbeat
    try {
      const pid = fs.readFileSync('/run/ellul-enforcer.pid', 'utf8').trim();
      if (pid) execFileSync('kill', ['-USR1', pid], { stdio: 'pipe', timeout: 2000 });
    } catch {}

    return c.json({
      message: `Rolled back ${safeName} to version ${previousVersion}`,
      version: previousVersion,
      previousVersion: currentVersion,
      healthy: healthCheck.healthy,
      caddyReloaded: caddyOk,
    });
  });

  // Remove app: stop PM2, drop Caddy config, clean metadata + snapshots.
  app.post('/api/workflow/remove', async (c) => {
    // Require internal service token — prevents agent from deleting any app directly
    const { validateInternalToken } = await import('../application/credentials/InternalToken');
    if (!validateInternalToken(c.req.header('Authorization'))) {
      return c.json({ error: 'Unauthorized — internal token required' }, 401);
    }

    const body = await c.req.json().catch(() => ({}));
    const { name } = body as { name?: string };

    if (!name) return c.json({ error: 'name is required' }, 400);

    const safeName = name.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!safeName) return c.json({ error: 'Invalid app name' }, 400);

    // Acquire deploy lock
    const lockFile = `/tmp/ellul-deploy-${safeName}.lock`;
    try {
      const fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
    } catch {
      try {
        const lockAge = Date.now() - (fs.statSync(lockFile).mtimeMs || 0);
        if (lockAge < 120000) {
          return c.json({ error: 'Deploy in progress — cannot remove now' }, 409);
        }
        fs.unlinkSync(lockFile);
        const fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
      } catch {
        return c.json({ error: 'Deploy lock contention' }, 409);
      }
    }
    const releaseLock = () => { try { fs.unlinkSync(lockFile); } catch {} };

    const { home, appsDir } = getUserInfo();

    try {
      // 0. Destroy shielded namespace (if exists — idempotent)
      try { destroyNamespace(safeName); } catch {}

      // 1. Stop PM2 processes (canonical + canary)
      for (const proc of [safeName, `${safeName}__canary`]) {
        try {
          execFileSync('bash', ['-lc', 'PM2_HOME="$1" pm2 delete "$2" 2>/dev/null', '_', PM2_SHIELDED_HOME, proc], {
            stdio: 'pipe', timeout: 10000,
          });
        } catch {}
      }

      // 2. Remove Caddy configs
      try { fs.unlinkSync(`${SITES_DIR}/${safeName}.caddy`); } catch {}
      try { fs.unlinkSync(`${APP_ROUTES_DIR}/${safeName}.caddy`); } catch {}

      // 3. Remove app metadata
      try { fs.unlinkSync(`${appsDir}/${safeName}.json`); } catch {}

      // 4. Reload Caddy (admin API validates server-side)
      try {
        await reloadCaddy();
      } catch (e) {
        console.error(`[shield] Caddy reload after remove failed: ${(e as Error).message}`);
      }

      // 5. Remove deployment snapshots
      const deployDir = `${home}/.ellul/deployments/${safeName}`;
      try { fs.rmSync(deployDir, { recursive: true, force: true }); } catch {}

      // 6. Save PM2 state
      try { execFileSync('bash', ['-lc', 'PM2_HOME="$1" pm2 save --force 2>/dev/null', '_', PM2_SHIELDED_HOME], { stdio: 'pipe', timeout: 5000 }); } catch {}

      releaseLock();

      // 7. Trigger heartbeat
      try {
        const pid = fs.readFileSync('/run/ellul-enforcer.pid', 'utf8').trim();
        if (pid) execFileSync('kill', ['-USR1', pid], { stdio: 'pipe', timeout: 2000 });
      } catch {}

      return c.json({ message: `Deployment "${safeName}" removed` });
    } catch (e) {
      releaseLock();
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // Remove ALL apps in a project. Internal-token only — agent cannot call directly.
  app.post('/api/workflow/remove-project', async (c) => {
    // Require internal service token — prevents agent from calling directly
    const { validateInternalToken } = await import('../application/credentials/InternalToken');
    if (!validateInternalToken(c.req.header('Authorization'))) {
      return c.json({ error: 'Unauthorized — internal token required' }, 401);
    }

    let body: { project?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { project } = body;
    if (!project || typeof project !== 'string') {
      return c.json({ error: 'project is required' }, 400);
    }

    const safeProject = project.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!safeProject) {
      return c.json({ error: 'Invalid project name' }, 400);
    }

    const { home, appsDir } = getUserInfo();
    const removed: string[] = [];

    try {
      if (!fs.existsSync(appsDir)) {
        return c.json({ message: 'No deployments found', removed: [] });
      }

      const files = fs.readdirSync(appsDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const meta = JSON.parse(fs.readFileSync(`${appsDir}/${file}`, 'utf8'));
          if (meta.project !== safeProject) continue;

          const sandboxId = meta.name;

          // Destroy shielded namespace (if exists)
          try { destroyNamespace(sandboxId); } catch {}

          // Stop PM2 processes (canonical + canary)
          for (const proc of [sandboxId, `${sandboxId}__canary`]) {
            try {
              execFileSync('bash', ['-lc', 'PM2_HOME="$1" pm2 delete "$2" 2>/dev/null', '_', PM2_SHIELDED_HOME, proc], {
                stdio: 'pipe', timeout: 10000,
              });
            } catch {}
          }

          // Remove Caddy configs
          try { fs.unlinkSync(`${SITES_DIR}/${sandboxId}.caddy`); } catch {}
          try { fs.unlinkSync(`${APP_ROUTES_DIR}/${sandboxId}.caddy`); } catch {}

          // Remove metadata
          try { fs.unlinkSync(`${appsDir}/${sandboxId}.json`); } catch {}

          // Remove deployment snapshots
          const deployDir = `${home}/.ellul/deployments/${sandboxId}`;
          try { fs.rmSync(deployDir, { recursive: true, force: true }); } catch {}

          removed.push(sandboxId);
        } catch {}
      }
    } catch (e) {
      return c.json({ error: `Failed to enumerate apps: ${(e as Error).message}` }, 500);
    }

    if (removed.length > 0) {
      // Single Caddy reload for all removals
      try { await reloadCaddy(); } catch {}
      // Save PM2 state
      try { execFileSync('bash', ['-lc', 'PM2_HOME="$1" pm2 save --force 2>/dev/null', '_', PM2_SHIELDED_HOME], { stdio: 'pipe', timeout: 5000 }); } catch {}
      // Trigger heartbeat
      try {
        const pid = fs.readFileSync('/run/ellul-enforcer.pid', 'utf8').trim();
        if (pid) execFileSync('kill', ['-USR1', pid], { stdio: 'pipe', timeout: 2000 });
      } catch {}
      console.log(`[shield] Removed ${removed.length} deployments for project "${safeProject}": ${removed.join(', ')}`);
    }

    // Clean up cross-project access rules involving this sandbox (as reader
    // or shared source). Rules are sandbox-scoped; the service parses the
    // input slug via the canonical `parseSandboxId` and throws on malformed
    // values, so no local pre-validation is needed here.
    try {
      const rulesRemoved = cleanupSandboxCrossProjectAccess(project);
      if (rulesRemoved > 0) {
        console.log(`[shield] Cleaned ${rulesRemoved} cross-project access rules for "${project}"`);
      }
    } catch (e) {
      console.warn(`[shield] Failed to cleanup cross-project access for "${project}":`, (e as Error).message);
    }

    return c.json({ message: `Removed ${removed.length} deployments for project "${safeProject}"`, removed });
  });

  // Restore workspace from Neon snapshot (free→paid upgrade / hibernation wake).
  app.post('/api/workflow/hydrate', async (c) => {
    // Require internal service token — only file-api/provisioning can trigger hydration
    const { validateInternalToken } = await import('../application/credentials/InternalToken');
    if (!validateInternalToken(c.req.header('Authorization'))) {
      return c.json({ error: 'Unauthorized — internal token required' }, 401);
    }

    const LOG = '[hydrate]';

    try {
      // ── Read server config ──────────────────────────────────────────
      const serverId = fs.readFileSync('/etc/ellul-bootstrap/server-id', 'utf8').trim();
      const apiUrl = fs.readFileSync('/etc/ellul/api-url', 'utf8').trim();
      const aiProxyToken = fs.readFileSync('/etc/ellul-bootstrap/ai-proxy-token', 'utf8').trim();
      const targetDir = SVC_HOME;

      console.log(`${LOG} Starting hydration for server ${serverId.slice(0, 8)}... → ${targetDir}`);

      // ── Fetch snapshot chunks from API ───────────────────────────────
      const response = await fetch(
        `${apiUrl}/api/servers/${serverId}/snapshot-chunks`,
        {
          headers: {
            'Authorization': `Bearer ${aiProxyToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${await response.text()}`);
      }

      const data = await response.json() as {
        hasSnapshot: boolean;
        totalChunks?: number;
        compressedSizeBytes?: number;
        chunks?: Array<{ chunkIndex: number; data: string; sizeBytes: number; checksum: string }>;
      };

      if (!data.hasSnapshot || !data.chunks || data.chunks.length === 0) {
        console.log(`${LOG} No snapshot found — empty workspace`);
        return c.json({ success: true, message: 'No snapshot to hydrate' });
      }

      console.log(`${LOG} Received ${data.chunks.length} chunks (${data.compressedSizeBytes} bytes compressed)`);

      // ── Reassemble chunks into tarball ───────────────────────────────
      const sortedChunks = data.chunks.sort((a, b) => a.chunkIndex - b.chunkIndex);
      const buffers = sortedChunks.map(chunk => Buffer.from(chunk.data, 'base64'));
      const tarball = Buffer.concat(buffers);

      const tempFile = '/tmp/hydrate-workspace.tar.gz';
      fs.writeFileSync(tempFile, tarball);
      console.log(`${LOG} Tarball reassembled: ${tarball.length} bytes`);

      // ── Extract to target directory ──────────────────────────────────
      fs.mkdirSync(targetDir, { recursive: true });

      execFileSync('tar', ['xzf', tempFile, '-C', targetDir, '--strip-components=0'], {
        stdio: 'pipe',
        timeout: 120000,
      });

      console.log(`${LOG} Workspace extracted to ${targetDir}`);

      // ── Post-hydration setup ─────────────────────────────────────────
      const packageJson = `${targetDir}/package.json`;
      if (fs.existsSync(packageJson)) {
        console.log(`${LOG} Found package.json — running npm install...`);
        try {
          const npmNoBinLinks = process.env.ELLUL_PLATFORM === 'android' ? ' --no-bin-links' : '';
          execFileSync('bash', ['-lc', `cd -- "$1" && npm install --prefer-offline${npmNoBinLinks} 2>&1`, '_', targetDir], {
            stdio: 'pipe', timeout: 120000,
          });
          console.log(`${LOG} npm install complete`);
        } catch (npmErr) {
          const err = npmErr as Error & { killed?: boolean; signal?: string };
          const reason = err.killed ? `killed by timeout (${err.signal || 'SIGTERM'}) after 120s` : (err as Error).message;
          console.warn(`${LOG} npm install failed (non-fatal): ${reason}`);
        }
      }

      // ── Cleanup ──────────────────────────────────────────────────────
      try { fs.unlinkSync(tempFile); } catch {}

      console.log(`${LOG} Hydration complete`);
      return c.json({ success: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`${LOG} Hydration failed: ${msg}`);
      return c.json({ success: false, error: msg }, 500);
    }
  });

  // Re-resolve DNS + re-apply nftables (handles CDN IP rotation).
  app.post('/api/internal/refresh-shield/:name', (c) => {
    const raw = c.req.param('name');
    const sandboxParse = tryParseSandboxId(raw);
    if (!sandboxParse) {
      return c.json({ error: 'refresh-shield requires a sandbox slug', code: 'INVALID_SANDBOX_ID' }, 400);
    }
    const sandboxId = sandboxParse;

    try {
      const secrets = readRuntimeEnv(sandboxId);
      if (secrets.size === 0) {
        return c.json({ error: 'No secrets configured — nothing to refresh' }, 400);
      }
      const destinations = resolveDestinations(secrets);
      applyWhitelist(sandboxId, destinations);
      return c.json({ success: true, ruleCount: destinations.length });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // ── Shielded Preview ──────────────────────────────────────────────────

  // Per-framework build cache dirs — private tmpfs mounts in namespace (agent invisible).
  const FRAMEWORK_WRITABLE_DIRS: Record<string, string[]> = {
    next:    ['.next'],
    vite:    ['node_modules/.vite'],
    svelte:  ['.svelte-kit', 'node_modules/.vite'],
    cra:     ['node_modules/.cache'],
    astro:   ['.astro'],
    nuxt:    ['.nuxt', '.output'],
    remix:   ['.cache', 'build', 'node_modules/.vite'],
    gatsby:  ['.cache', 'public'],
  };

  // Shielded preview dev server (Glass Box isolation). If no secrets: { shielded: false }.
  app.post('/api/internal/preview/start', async (c) => {
    const { project, command, port, framework } = await c.req.json() as {
      project: string; command: string; port: number; framework?: string;
    };
    if (!project || !command || !port) {
      return c.json({ error: 'project, command, and port required' }, 400);
    }

    // Derive sandbox slug from project path for runtime env injection.
    // First path segment is the sandbox slug; sandboxIdFromPath folds any
    // nested app/package path to the enclosing sandbox and parses it.
    const sandboxForPreview = sandboxIdFromPath(project);
    const secrets = readRuntimeEnv(sandboxForPreview, 'production');
    if (secrets.size === 0) {
      return c.json({ success: true, shielded: false });
    }

    const nsName = `pv${port % 10000}`;
    const procName = nsName; // Used for netns.service calls

    try {
      // Clean up any existing preview namespace for this port
      try { destroyNamespace(procName); } catch {}

      // Build env with per-app secrets (passed via stdin pipe to helper — never CLI args)
      const env: Record<string, string> = {};
      const secretValues: string[] = [];
      for (const [k, v] of secrets) {
        env[k] = v;
        secretValues.push(v);
      }
      // Standard dev environment
      env.NODE_ENV = 'development';
      env.PORT = String(port);
      env.HOST = '0.0.0.0';

      // Inject env-shield-preload (defense-in-depth: hides secrets from enumeration)
      const preloadPath = '/usr/local/lib/ellul/env-shield-preload.cjs';
      env.NODE_OPTIONS = `--require ${preloadPath}`;

      // Resolve whitelist from secrets
      const destinations = resolveDestinations(secrets);

      // Determine writable build cache dirs for this framework
      const writableDirs = framework ? (FRAMEWORK_WRITABLE_DIRS[framework] || []) : [];

      // Create namespace + veth pair (DNAT makes localhost:PORT route transparently)
      const { nsIp } = createShieldedNamespace(procName, port);

      // Apply nftables egress whitelist
      applyWhitelist(procName, destinations);

      // Start dev server inside namespace with R/O source + writable build caches
      console.log(`[preview-shield] Starting shielded preview on ${nsIp}:${port} (${framework || 'unknown'}: ${command})`);
      execInNamespace(procName, { command, cwd: project, env, writableDirs }, secretValues);

      return c.json({ success: true, shielded: true, nsIp });
    } catch (err) {
      console.error(`[preview-shield] Failed to start:`, (err as Error).message);
      try { destroyNamespace(procName); } catch {}
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // Stop shielded preview + destroy namespace.
  app.post('/api/internal/preview/stop', async (c) => {
    const { port } = await c.req.json() as { port: number };
    if (!port) return c.json({ error: 'port required' }, 400);

    const nsName = `pv${port % 10000}`;
    try {
      destroyNamespace(nsName);
      return c.json({ success: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // ── Sovereign Gates ──────────────────────────────────────────────────

  // Grant gate. PoP signature (when present) cryptographically binds grant to passkey gesture —
  // proves human authorization, agent cannot forge.
  app.post('/api/internal/gate/grant', async (c) => {
    const { gate, threadId, ttlMs, sandboxId, popSignature, popTimestamp, popNonce } = await c.req.json() as {
      gate: GateType; threadId: string; ttlMs?: number; sandboxId?: string;
      popSignature?: string; popTimestamp?: string; popNonce?: string;
    };
    if (!gate || !threadId) return c.json({ error: 'gate and threadId required' }, 400);

    // PoP (Proof-of-Possession) verification is strictly tier-based:
    //   - web_locked / private_locked: passkey-bound tiers. Every gate
    //     grant MUST carry a valid PoP signature HMAC-signed with the
    //     session's passkey-derived key. No PoP → 401 with a clear error.
    //     No session with pop_hmac_key → also 401 (user needs to re-auth
    //     with their passkey before any grant can land).
    //   - standard: soft-security tier by design. Passkey/PoP are not
    //     required; internal-token auth is the proof. We still verify a
    //     PoP if the browser happens to supply one (harmless extra check)
    //     but we never reject a grant for lacking it on this tier.
    const tier = getCurrentTier();
    const tierRequiresPop = tier === 'web_locked' || tier === 'private_locked';
    const popSupplied = !!(popSignature && popTimestamp && popNonce);

    const sessionRow = db.prepare(
      'SELECT id, pop_hmac_key FROM sessions WHERE pop_hmac_key IS NOT NULL ORDER BY last_activity DESC LIMIT 1'
    ).get() as { id: string; pop_hmac_key: string } | undefined;

    if (tierRequiresPop) {
      if (!popSupplied) {
        logAuditEvent({
          type: 'gate_grant_rejected_no_pop',
          details: { gate, threadId: threadId.slice(0, 8), tier },
        });
        return c.json({
          error: `Gate grants on the ${tier} tier must be passkey-signed. The browser did not supply a PoP signature — either a UI bug or an attempted bypass.`,
        }, 401);
      }
      if (!sessionRow?.pop_hmac_key) {
        logAuditEvent({ type: 'gate_pop_no_session', details: { gate, threadId, tier } });
        return c.json({
          error: 'No passkey-bound session is available to verify the PoP signature. Re-authenticate with your passkey and retry.',
        }, 401);
      }
    }

    if (popSupplied && sessionRow?.pop_hmac_key) {
      // PoP was supplied (required on web_locked/private_locked; optional
      // but welcome on standard). Verify it.
      const reqTime = parseInt(popTimestamp!, 10);
      const now = Date.now();
      if (Math.abs(now - reqTime) > POP_TIMESTAMP_TOLERANCE_MS) {
        return c.json({ error: 'PoP timestamp expired' }, 403);
      }

      // Atomic nonce claim — INSERT OR IGNORE prevents replay
      const nonceKey = `gate:${sessionRow.id}:${popNonce}`;
      const nonceResult = db.prepare(
        'INSERT OR IGNORE INTO pop_nonces (nonce_key, expires_at) VALUES (?, ?)'
      ).run(nonceKey, now + POP_TIMESTAMP_TOLERANCE_MS * 2);
      if (nonceResult.changes === 0) {
        logAuditEvent({ type: 'gate_pop_replay', details: { gate, threadId } });
        return c.json({ error: 'PoP nonce replay detected' }, 403);
      }

      const payload = `gate_grant|${gate}|${threadId}|${popTimestamp}|${popNonce}`;
      const valid = await verifyPopSignature(sessionRow.pop_hmac_key, payload, popSignature!);
      if (!valid) {
        logAuditEvent({ type: 'gate_pop_invalid', details: { gate, threadId, tier } });
        return c.json({ error: 'PoP signature verification failed' }, 403);
      }

      logAuditEvent({ type: 'gate_pop_verified', details: { gate, threadId, session: sessionRow.id.substring(0, 8), tier } });
    } else if (!tierRequiresPop) {
      // Standard tier with no PoP — expected. Record a soft-audit entry.
      logAuditEvent({
        type: 'gate_grant_unsigned_standard',
        details: { gate, threadId: threadId.slice(0, 8), tier },
      });
    }

    const result = grantGate(gate, threadId, ttlMs, { sandboxId });
    return c.json({ success: true, expiresAt: result.expiresAt });
  });

  // Revoke gate ("Lock Now").
  app.post('/api/internal/gate/revoke', async (c) => {
    const { gate, threadId } = await c.req.json() as { gate: GateType; threadId: string };
    if (!gate || !threadId) return c.json({ error: 'gate and threadId required' }, 400);
    revokeGate(gate, threadId);
    return c.json({ success: true });
  });

  // ── Permissions v2 — server-authoritative request lifecycle ──────────
  //
  // The v2 endpoints split the grant flow into two phases:
  //   1. agent-bridge POSTs /api/internal/permissions/request when the
  //      agent needs human approval. Shield issues a UUID and persists
  //      the pending row. The id travels with every downstream event.
  //   2. When the user clicks Grant/Deny, agent-bridge POSTs
  //      /api/internal/permissions/:id/{grant,deny}. Shield re-verifies
  //      the PoP signature against a payload that binds id + action +
  //      scope (preventing a captured PoP being replayed against a
  //      different request, sandbox, or ttl).
  //
  // Legacy `/api/internal/gate/grant` remains live during migration — the
  // caller decides which path to use based on whether a requestId is
  // available. Both write through to the same grantGate() primitive, so
  // downstream gate enforcement is unchanged.

  // Idempotent on (gate, threadId, sandboxId, argsHash).
  app.post('/api/internal/permissions/request', async (c) => {
    const body = await c.req.json() as {
      gate: GateType;
      threadId: string;
      sandboxId?: string;
      reason?: string;
      scope?: Record<string, unknown>;
      requestedBy?: {
        agentId?: string;
        cliKind?: string;
        toolName?: string;
        argsHash?: string;
      };
    };
    if (!body.gate || !body.threadId) {
      return c.json({ error: 'gate and threadId required' }, 400);
    }

    const { createRequest } = await import('../application/gates/Permission');
    const result = createRequest({
      gate: body.gate,
      threadId: body.threadId,
      sandboxId: body.sandboxId || null,
      reason: body.reason || null,
      scope: body.scope || null,
      requestedBy: body.requestedBy || {},
    });
    return c.json({
      id: result.request.id,
      created: result.created,
      status: result.request.status,
      createdAt: result.request.createdAt,
    });
  });

  // PoP v2 payload binds id + action + scope.
  app.post('/api/internal/permissions/:id/grant', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json() as {
      action: 'grant_timed' | 'grant_session' | 'grant_always';
      ttlMs?: number;
      sandboxId?: string;
      popSignature?: string;
      popTimestamp?: string;
      popNonce?: string;
    };
    if (!body.action || !body.action.startsWith('grant')) {
      return c.json({ error: 'action must be grant_timed|grant_session|grant_always' }, 400);
    }
    return resolvePermissionV2(c, id, body);
  });

  // PoP-signed on passkey tiers.
  app.post('/api/internal/permissions/:id/deny', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json() as {
      action: 'deny' | 'deny_always';
      sandboxId?: string;
      popSignature?: string;
      popTimestamp?: string;
      popNonce?: string;
    };
    if (!body.action || !body.action.startsWith('deny')) {
      return c.json({ error: 'action must be deny|deny_always' }, 400);
    }
    return resolvePermissionV2(c, id, { ...body, ttlMs: undefined });
  });

  // Revoke granted permission.
  app.post('/api/internal/permissions/:id/revoke', async (c) => {
    const id = c.req.param('id');
    const { revokeRequest, getRequest } = await import('../application/gates/Permission');
    const req = getRequest(id);
    if (!req) return c.json({ error: 'not found' }, 404);
    // If the granted row is backed by an active gate grant, revoke that too.
    if (req.status === 'granted') {
      try { revokeGate(req.gate, req.threadId); } catch {}
    }
    const updated = revokeRequest(id);
    return c.json({ success: true, status: updated?.status ?? 'revoked' });
  });

  // UI hint ("no repeat toast") — unsigned, not authorization.
  app.post('/api/internal/permissions/:id/seen', async (c) => {
    const id = c.req.param('id');
    const { markSeen } = await import('../application/gates/Permission');
    const updated = markSeen(id);
    if (!updated) return c.json({ error: 'not found' }, 404);
    return c.json({ success: true, lastSeenAt: updated.lastSeenAt });
  });

  // Shared grant/deny: validates PoP v2, pending→resolved, on grant materializes gate.service entry.
  async function resolvePermissionV2(
    c: Context,
    id: string,
    body: {
      action: 'grant_timed' | 'grant_session' | 'grant_always' | 'deny' | 'deny_always';
      ttlMs?: number;
      sandboxId?: string;
      popSignature?: string;
      popTimestamp?: string;
      popNonce?: string;
    },
  ) {
    const { getRequest, resolveRequest } = await import('../application/gates/Permission');
    const { recordConflict, recordPopRejection } = await import('../application/gates/PermissionMetrics');
    const existing = getRequest(id);
    if (!existing) return c.json({ error: 'not found' }, 404);
    if (existing.status !== 'pending') {
      recordConflict(existing.gate);
      return c.json({
        error: 'already_resolved',
        current: {
          id: existing.id,
          status: existing.status,
          resolvedAt: existing.resolvedAt,
          resolution: existing.resolution,
        },
      }, 409);
    }

    const isGrant = body.action.startsWith('grant');
    const effectiveTtl = isGrant
      ? (body.action === 'grant_session' ? 60 * 60 * 1000 : body.ttlMs)
      : undefined;

    // ── PoP verification (v2 payload) ────────────────────────────────
    const tier = getCurrentTier();
    const tierRequiresPop = tier === 'web_locked' || tier === 'private_locked';
    const popSupplied = !!(body.popSignature && body.popTimestamp && body.popNonce);

    const sessionRow = db.prepare(
      'SELECT id, pop_hmac_key, credential_id FROM sessions WHERE pop_hmac_key IS NOT NULL ORDER BY last_activity DESC LIMIT 1'
    ).get() as { id: string; pop_hmac_key: string; credential_id: string } | undefined;

    if (tierRequiresPop) {
      if (!popSupplied) {
        logAuditEvent({
          type: 'permission_pop_missing',
          sandboxId: existing.sandboxId,
          details: { id, action: body.action, tier, gate: existing.gate },
        });
        recordPopRejection('missing', existing.gate);
        return c.json({
          error: `Permission resolution on the ${tier} tier must be passkey-signed.`,
        }, 401);
      }
      if (!sessionRow?.pop_hmac_key) {
        logAuditEvent({
          type: 'permission_pop_no_session',
          sandboxId: existing.sandboxId,
          details: { id, action: body.action, tier },
        });
        return c.json({
          error: 'No passkey-bound session is available. Re-authenticate and retry.',
        }, 401);
      }
    }

    if (popSupplied && sessionRow?.pop_hmac_key) {
      const reqTime = parseInt(body.popTimestamp!, 10);
      const now = Date.now();
      if (Math.abs(now - reqTime) > POP_TIMESTAMP_TOLERANCE_MS) {
        recordPopRejection('expired', existing.gate);
        return c.json({ error: 'PoP timestamp expired' }, 403);
      }

      // Namespace nonce under perm: so v2 grants cannot consume nonces
      // issued for v1 grants (or vice-versa) — defense in depth during
      // the rolling migration.
      const nonceKey = `perm:${sessionRow.id}:${body.popNonce}`;
      const nonceResult = db.prepare(
        'INSERT OR IGNORE INTO pop_nonces (nonce_key, expires_at) VALUES (?, ?)'
      ).run(nonceKey, now + POP_TIMESTAMP_TOLERANCE_MS * 2);
      if (nonceResult.changes === 0) {
        logAuditEvent({
          type: 'permission_pop_replay',
          sandboxId: existing.sandboxId,
          details: { id, action: body.action },
        });
        recordPopRejection('replay', existing.gate);
        return c.json({ error: 'PoP nonce replay detected' }, 403);
      }

      // v2 signed payload — binds id, action, gate, thread, sandbox, and ttl.
      // A signature captured for one request cannot be replayed against a
      // different one, and a client can no longer lie about ttlMs because
      // the server reconstructs the payload from the resolved request + body.
      const sandboxForSig = body.sandboxId || existing.sandboxId || '';
      const ttlForSig = effectiveTtl ?? 0;
      const payload =
        `permission|${body.action}|${id}|${existing.gate}|${existing.threadId}|${sandboxForSig}|${ttlForSig}|${body.popTimestamp}|${body.popNonce}`;
      const valid = await verifyPopSignature(sessionRow.pop_hmac_key, payload, body.popSignature!);
      if (!valid) {
        logAuditEvent({
          type: 'permission_pop_invalid',
          sandboxId: existing.sandboxId,
          details: { id, action: body.action, tier },
        });
        recordPopRejection('invalid', existing.gate);
        return c.json({ error: 'PoP signature verification failed' }, 403);
      }

      logAuditEvent({
        type: 'permission_pop_verified',
        sandboxId: existing.sandboxId,
        sessionId: sessionRow.id,
        credentialId: sessionRow.credential_id,
        details: { id, action: body.action, gate: existing.gate, tier },
      });
    } else if (!tierRequiresPop) {
      logAuditEvent({
        type: 'permission_resolve_unsigned_standard',
        sandboxId: existing.sandboxId,
        details: { id, action: body.action, tier },
      });
    }

    // ── Materialize the backing gate grant (grant path only) ─────────
    let backingGrantExpiresAt: number | null = null;
    if (isGrant) {
      const grantResult = grantGate(existing.gate, existing.threadId, effectiveTtl, {
        sandboxId: body.sandboxId || existing.sandboxId || undefined,
      });
      backingGrantExpiresAt = grantResult.expiresAt;
    }

    // ── Transition the row (atomic, 409-safe on race) ────────────────
    const resolveResult = resolveRequest({
      id,
      action: body.action,
      ttlMs: effectiveTtl ?? null,
      expiresAt: backingGrantExpiresAt,
      sessionId: sessionRow?.id ?? null,
      credentialId: sessionRow?.credential_id ?? null,
      popNonce: body.popNonce ?? null,
      popTimestamp: body.popTimestamp ?? null,
      device: { ip: c.req.header('x-forwarded-for') || null, userAgent: c.req.header('user-agent') || null },
    });

    if ('code' in resolveResult) {
      if (resolveResult.code === 'not_found') {
        return c.json({ error: 'not found' }, 404);
      }
      // already_resolved — rare race (two devices clicked). Mirror the state.
      recordConflict(resolveResult.current.gate);
      return c.json({
        error: 'already_resolved',
        current: {
          id: resolveResult.current.id,
          status: resolveResult.current.status,
          resolvedAt: resolveResult.current.resolvedAt,
          resolution: resolveResult.current.resolution,
        },
      }, 409);
    }

    return c.json({
      success: true,
      id: resolveResult.request.id,
      status: resolveResult.request.status,
      expiresAt: backingGrantExpiresAt,
    });
  }

  // Gate status for a thread (UI).
  app.get('/api/internal/gate/status', (c) => {
    const threadId = c.req.query('threadId');
    if (!threadId) return c.json({ error: 'threadId required' }, 400);
    const sandboxId = c.req.query('sandboxId') || undefined;
    const result: Record<string, boolean> = {};
    for (const gate of VALID_GATE_TYPES) {
      result[gate] = isGateOpen(gate, threadId, sandboxId);
    }
    const response = {
      ...result,
      logsRemainingMs: getGateRemainingMs('logs', threadId),
      envRemainingMs: getGateRemainingMs('env', threadId),
      dbReadRemainingMs: getGateRemainingMs('db_read', threadId),
      dbWriteRemainingMs: getGateRemainingMs('db_write', threadId),
      dbMigrateRemainingMs: getGateRemainingMs('db_migrate', threadId),
    };
    return c.json(response);
  });

  // Env Gate: inject secrets, exec, auto-revoke after.
  app.post('/api/internal/gate/exec-with-secrets', async (c) => {
    const { threadId, command, cwd } = await c.req.json() as {
      threadId: string; command: string; cwd?: string;
    };
    if (!threadId || !command) return c.json({ error: 'threadId and command required' }, 400);

    // Check thread-level grant first, then app-level fallback
    const grant = getGateGrant('env', threadId);
    if (!grant) {
      // Try to resolve sandboxId from cwd for app-level fallback
      const cwdSandboxId = cwd ? path.basename(cwd) : undefined;
      if (!cwdSandboxId || !isGateOpenForApp('env', cwdSandboxId)) {
        return c.json({ error: 'Env gate is closed' }, 403);
      }
    }

    // Resolve the sandbox scope for this env gate call. The gate grant
    // carries the sandbox id; if missing (legacy callers) we fall back to
    // parsing from `cwd`. If neither yields a valid slug, the call has no
    // sandbox context and we refuse to inject (no fallback to `_global`).
    const grantSandbox = grant?.sandboxId ? tryParseSandboxId(grant.sandboxId) : null;
    const cwdSandbox = cwd ? tryParseSandboxId(path.basename(cwd)) : null;
    const sandboxId: SandboxId | null = grantSandbox || cwdSandbox;
    if (!sandboxId) {
      return c.json({ error: 'env gate requires a sandbox scope', code: 'INVALID_SANDBOX_ID' }, 400);
    }

    // Runtime view: sandbox's own env merged with org overlay (reserved
    // for future cross-sandbox org env support — see readRuntimeEnv).
    const secrets = readRuntimeEnv(sandboxId);
    const secretValues = Array.from(secrets.values());

    // Phase 4: Record exposure BEFORE injection — track what the agent sees
    if (secrets.size > 0) {
      try {
        recordExposure(sandboxId, secrets, threadId);
      } catch (e) {
        console.warn('[shield] Exposure tracking failed (non-fatal):', (e as Error).message);
      }
    }

    // CRITICAL: Inject secrets via stdin pipe, NOT the env parameter.
    // The env parameter writes to /proc/<pid>/environ which is readable
    // by a racing agent process despite ptrace_scope=1.
    const exportLines = Array.from(secrets.entries())
      .map(([k, v]: [string, string]) => `export ${k}=${JSON.stringify(v)}`)
      .join('\n');
    const stdinScript = `${exportLines}\n${command}`;

    const { spawn: spawnChild } = require('child_process');
    const result = await new Promise<{ stdout: string; stderr: string; status: number | null }>((resolve) => {
      const child = spawnChild('bash', [], {
        cwd: cwd || undefined,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code: number | null) => {
        resolve({ stdout, stderr, status: code });
      });
      child.stdin.write(stdinScript);
      child.stdin.end();
    });

    // Auto-revoke after single use
    revokeGate('env', threadId);

    // Redact secrets from output
    const redact = createRedactor(secretValues);

    return c.json({
      stdout: redact(result.stdout || ''),
      stderr: redact(result.stderr || ''),
      exitCode: result.status,
    });
  });

  // Redacted or raw depending on log gate state.
  app.get('/api/internal/gate/logs/:sandboxId', (c) => {
    const sandboxId = c.req.param('sandboxId');
    const threadId = c.req.query('threadId');
    const since = c.req.query('since') ? parseInt(c.req.query('since')!, 10) : undefined;

    if (!sandboxId) return c.json({ error: 'sandboxId required' }, 400);

    // If log gate is open (thread-level or app-level), return raw logs
    if (threadId && isGateOpen('logs', threadId, sandboxId)) {
      return c.json({ logs: logStore.getRaw(sandboxId, since), redacted: false });
    }

    // Default: redacted logs
    return c.json({ logs: logStore.getRedacted(sandboxId, since), redacted: true });
  });

  // In-memory scope-confusion denial counters — reset on restart, no sensitive fields.
  app.get('/api/internal/gate/cross-project-scope-metrics', (c) => {
    return c.json(getScopeConfusionDenialStats());
  });

  // ── Gate Permissions ────────────────────────────────────────────────

  // Pre-popup check for auto-grant.
  app.get('/api/internal/gate/check-permission', (c) => {
    const gateRaw = c.req.query('gate');
    const rawSandboxId = c.req.query('sandboxId');
    if (!gateRaw || !rawSandboxId) return c.json({ error: 'gate and sandboxId required' }, 400);

    try {
      const gate = validateGateType(gateRaw);
      const sandboxId = parseSandboxId(rawSandboxId);

      // Always return 200 with uniform JSON body. Returning 403 for 'never'
      // vs 200 for other permissions would leak the permission setting to the
      // agent via HTTP status code differences.
      if (shouldAutoDeny(gate, sandboxId)) {
        return c.json({ shouldAutoGrant: false, shouldAutoDeny: true });
      }
      return c.json({
        shouldAutoGrant: shouldAutoGrant(gate, sandboxId),
        shouldAutoDeny: false,
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  // Atomic check-and-grant (eliminates check→grant TOCTOU).
  app.post('/api/internal/gate/auto-grant', async (c) => {
    let body: { gate?: string; sandboxId?: string; threadId?: string; reason?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { threadId, reason } = body;
    console.log(`[shield] [DBG] auto-grant: gate="${body.gate}" sandboxId="${body.sandboxId}" threadId="${threadId?.slice(0, 8)}" reason="${reason?.slice(0, 80)}"`);
    if (!body.gate || !body.sandboxId || !threadId) {
      console.log(`[shield] [DBG] auto-grant: REJECTED — missing required fields`);
      return c.json({ error: 'gate, sandboxId, and threadId are required' }, 400);
    }

    try {
      const gate = validateGateType(body.gate);
      const sandboxId = parseSandboxId(body.sandboxId);

      // L3 cross-project scope-confusion (bridge-driven auto-grant
      // path). Bridge enriches generic per-tool reasons with extracted
      // `.shared/*` / `/projects/<slug>` hints from tool args before
      // calling here, so the matcher has real signal. See
      // `services/gate-scope-check.ts` for the full decision pipeline.
      const scopeResult = runScopeCheck({
        project: sandboxId,
        reason: reason ?? '',
        gate: body.gate,
        layer: 'shield_auto_grant',
        auditExtras: { threadId },
        shape: 'auto_grant',
      });
      if (scopeResult.denied) {
        return c.json(scopeResult.body, scopeResult.status);
      }

      // Check auto-deny first (highest priority)
      const autoDeny = shouldAutoDeny(gate, sandboxId);
      console.log(`[shield] [DBG] auto-grant: shouldAutoDeny(${gate}, ${sandboxId})=${autoDeny}`);
      if (autoDeny) {
        logAuditEvent({
          type: 'gate_auto_denied',
          details: { gate, sandboxId, threadId, reason },
        });
        return c.json({ denied: true }, 403);
      }

      // Check auto-grant
      const autoGrant = shouldAutoGrant(gate, sandboxId);
      console.log(`[shield] [DBG] auto-grant: shouldAutoGrant(${gate}, ${sandboxId})=${autoGrant}`);
      if (autoGrant) {
        const grant = grantGateForApp(gate, sandboxId, undefined, { autoGranted: true });
        logAuditEvent({
          type: 'gate_auto_granted',
          details: { gate, sandboxId, threadId, reason, expiresAt: grant.expiresAt },
        });
        console.log(`[shield] [DBG] auto-grant: GRANTED gate="${gate}" sandboxId="${sandboxId}" expiresAt=${grant.expiresAt}`);
        return c.json({ granted: true, grant });
      }

      // No permission set — needs popup
      console.log(`[shield] [DBG] auto-grant: no permission set → returning {ask: true}`);
      return c.json({ ask: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  // Auto-issue deploy gate when permission is allow_always/allow_session. Localhost only.
  // The permission IS the authorization — bypasses browser code session requirement.
  app.post('/api/internal/deploy-auto-authorize', async (c) => {
    let body: { sandboxId?: string; threadId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.sandboxId || !body.threadId) {
      return c.json({ error: 'sandboxId and threadId required' }, 400);
    }

    try {
      const sandboxId = parseSandboxId(body.sandboxId);

      // Double-check permission (fail-secure)
      if (!shouldAutoGrant('deploy', sandboxId)) {
        return c.json({ error: 'Deploy auto-authorize not permitted for this app' }, 403);
      }

      const token = createActionGate('deploy', sandboxId);
      const gate = actionGates.get(token)!;

      logAuditEvent({
        type: 'deploy_auto_authorized',
        details: { sandboxId, threadId: body.threadId, expiresAt: gate.expiresAt, source: 'auto_authorize' },
      });

      return c.json({ token, expiresAt: gate.expiresAt });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  // Same as deploy-auto-authorize but for git-push.
  app.post('/api/internal/git-auto-authorize', async (c) => {
    let body: { sandboxId?: string; threadId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.sandboxId || !body.threadId) {
      return c.json({ error: 'sandboxId and threadId required' }, 400);
    }

    try {
      const sandboxId = parseSandboxId(body.sandboxId);

      // Mint token if auto-grant policy is set OR if the git gate is
      // currently open (manual approval via modal). Without the second
      // check, modal-approved grants never produce an action token.
      if (!shouldAutoGrant('git', sandboxId) && !isGateOpenForApp('git', sandboxId)) {
        return c.json({ error: 'Git auto-authorize not permitted for this app' }, 403);
      }

      const token = createActionGate('git-push', sandboxId);
      const gate = actionGates.get(token)!;
      const credentialSession = createCredentialSession('');

      logAuditEvent({
        type: 'git_auto_authorized',
        details: { sandboxId, threadId: body.threadId, expiresAt: gate.expiresAt, source: 'auto_authorize' },
      });

      return c.json({ token, credentialSession, expiresAt: gate.expiresAt });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  // ?sandboxId=sbx-xxx for single; no param = all.
  app.get('/api/internal/gate/permissions', (c) => {
    const rawSandboxId = c.req.query('sandboxId');
    if (rawSandboxId) {
      try {
        const sandboxId = parseSandboxId(rawSandboxId);
        return c.json({ sandboxId: sandboxId, permissions: getSandboxPermissions(sandboxId) });
      } catch (err: any) {
        return c.json({ error: err.message }, 400);
      }
    }
    return c.json(getAllPermissions());
  });

  // Set gate permission for an app.
  app.post('/api/internal/gate/permissions', async (c) => {
    let parsed: { gate?: string; sandboxId?: string; permission?: string; source?: string };
    try {
      parsed = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!parsed.gate || !parsed.sandboxId || !parsed.permission) {
      return c.json({ error: 'gate, sandboxId, and permission required' }, 400);
    }
    if (!['ask', 'allow_session', 'allow_always', 'never'].includes(parsed.permission)) {
      return c.json({ error: 'Invalid permission. Must be ask, allow_session, allow_always, or never' }, 400);
    }

    try {
      const gate = validateGateType(parsed.gate);
      const sandboxId = parseSandboxId(parsed.sandboxId);
      const permission = parsed.permission as GatePermission;
      const source = (parsed.source || 'dashboard') as 'dashboard' | 'popup' | 'auto';

      if (permission === 'allow_session') {
        setSessionPermission(gate, sandboxId);
      } else {
        await setPermission(gate, sandboxId, permission, source);
      }

      return c.json({ success: true, gate, sandboxId, permission });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Names only (agent can't read .names directly). ?sandboxId=... or all.
  app.get('/api/internal/secret-names', (c) => {
    const raw = c.req.query('sandboxId');
    let sandboxId: SandboxId | undefined;
    if (raw !== undefined) {
      const parsed = tryParseSandboxId(raw);
      if (!parsed) {
        return c.json({ error: 'Invalid sandboxId', code: 'INVALID_SANDBOX_ID' }, 400);
      }
      sandboxId = parsed;
    }
    const names = listSecrets(sandboxId);
    return c.json({ names });
  });

  // ── Database (Phase 8 — Native PostgreSQL) ──────────────────────────

  // Create per-app DB + roles; returns DATABASE_URL.
  app.post('/api/internal/db/provision', async (c) => {
    let body: { sandboxId?: string; connectionUrl?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.sandboxId) return c.json({ error: 'sandboxId required' }, 400);

    try {
      // Parse + brand the scope at the boundary. Database provisioning is
      // sandbox-scoped; any app-nested path folds to the enclosing sandbox.
      // The branded `SandboxId` is identical to its underlying string at
      // runtime, so downstream calls that still type `sandboxId: string`
      // see the same value.
      const sandboxId = sandboxIdFromPath(body.sandboxId);

      // External provider: just store the URL, no local DB creation
      if (body.connectionUrl) {
        validateConnectionUrl(body.connectionUrl);

        // Verify connectivity before saving (async — uses connection pool)
        if (!(await testExternalConnAsync(sandboxId, body.connectionUrl))) {
          return c.json({ error: 'Cannot connect to external database. Verify the connection URL and ensure the database is reachable.' }, 502);
        }

        const config = loadDbConfig(sandboxId);
        config.type = 'external';
        config.connectionUrl = 'encrypted'; // Sentinel — real URL in encrypted at-rest storage
        if (config.databases.length === 0) {
          config.databases = [{ label: 'default', dbName: 'external', createdAt: Date.now() }];
        }
        config.previewDb = config.previewDb ?? 'default';
        config.deployedDb = config.deployedDb ?? 'default';
        saveDbConfig(sandboxId, config);

        // Encrypt and store URL at rest (AES-256-GCM + RSA-OAEP key wrap)
        saveEncryptedUrl(sandboxId, body.connectionUrl);

        // Inject DATABASE_URL into the app's secrets
        const secrets = readEnvFile(sandboxId);
        secrets.set('DATABASE_URL', body.connectionUrl);
        writeEnvFile(secrets, sandboxId);

        return c.json({
          success: true,
          type: 'external',
          database: 'external',
        });
      }

      // Local PostgreSQL path (existing behavior)
      if (!(await ensurePostgresAvailable())) {
        return c.json({ error: 'PostgreSQL is not available on this VPS' }, 503);
      }

      const result = createAppDatabase(sandboxId);

      // Auto-inject DATABASE_URL into the app's secrets so the app can connect
      const secrets = readEnvFile(sandboxId);
      secrets.set('DATABASE_URL', result.databaseUrl);
      writeEnvFile(secrets, sandboxId);

      // Do NOT return databaseUrl — it contains credentials.
      // The URL is injected into app secrets; the agent reads it from there.
      return c.json({
        success: true,
        type: 'local',
        database: result.info.database,
        roles: {
          owner: result.info.ownerRole,
          app: result.info.appRole,
          readonly: result.info.readonlyRole,
        },
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get('/api/internal/db/info', (c) => {
    const rawSandboxId = c.req.query('sandboxId');
    if (!rawSandboxId) return c.json({ error: 'sandboxId query param required' }, 400);

    try {
      const sandboxId = parseSandboxId(rawSandboxId);
      const info = getAppDatabaseInfo(sandboxId);
      return c.json(info);
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.post('/api/internal/db/delete', async (c) => {
    let body: { sandboxId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.sandboxId) return c.json({ error: 'sandboxId required' }, 400);

    try {
      const sandboxId = parseSandboxId(body.sandboxId);
      deleteAppDatabase(sandboxId);
      return c.json({ success: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Query proxy — the ONLY agent→DB path (pg_hba.conf denies peer auth for agent user).
  // Gates: SELECT/EXPLAIN=db_read, DML=db_write, DDL=db_migrate, SET/VACUUM=blocked.
  app.post('/api/internal/db/query', async (c) => {
    let body: { sandboxId?: string; sql?: string; threadId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { sandboxId: rawSandboxId, sql, threadId } = body;
    if (!rawSandboxId || !sql || !threadId) {
      return c.json({ error: 'sandboxId, sql, and threadId required' }, 400);
    }

    try {
      const sandboxId = parseSandboxId(rawSandboxId);

      // Check database availability
      const dbConfig = loadDbConfig(sandboxId);
      if (dbConfig.type === 'external') {
        const extUrl = resolveConnectionUrl(sandboxId);
        if (!extUrl || !(await testExternalConnAsync(sandboxId, extUrl))) {
          return c.json({ error: 'External database is not reachable' }, 503);
        }
      } else {
        if (!(await ensurePostgresAvailable())) {
          return c.json({ error: 'PostgreSQL is not available on this VPS' }, 503);
        }
      }

      // Check database exists
      const dbInfo = getAppDatabaseInfo(sandboxId);
      if (!dbInfo.exists) {
        return c.json({ error: `No database provisioned for app '${sandboxId}'. Call POST /api/internal/db/provision first.` }, 404);
      }

      // Classify the SQL
      const category = classifySql(sql);
      const requiredGate = requiredGateForSql(category);

      if (!requiredGate) {
        return c.json({
          error: `Query type '${category}' is not permitted through the query proxy`,
          category,
        }, 403);
      }

      // Check gate permission
      // db_write implies db_read, db_migrate implies both
      const gateOpen = isGateOpen(requiredGate, threadId, sandboxId) ||
        (requiredGate === 'db_read' && (isGateOpen('db_write', threadId, sandboxId) || isGateOpen('db_migrate', threadId, sandboxId))) ||
        (requiredGate === 'db_write' && isGateOpen('db_migrate', threadId, sandboxId));

      if (!gateOpen) {
        return c.json({
          error: `Gate '${requiredGate}' is not open. Request access via the gate system.`,
          requiredGate,
          category,
        }, 403);
      }

      // Execute the query
      const result = await executeQuery(sandboxId, sql, category);

      return c.json({
        success: true,
        rows: result.rows,
        rowCount: result.rowCount,
        command: result.command,
        category: result.category,
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Short-lived owner-level DATABASE_URL for DDL (requires db_migrate gate).
  app.post('/api/internal/db/migrate-credentials', async (c) => {
    let body: { sandboxId?: string; threadId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.sandboxId || !body.threadId) {
      return c.json({ error: 'sandboxId and threadId required' }, 400);
    }

    try {
      const sandboxId = parseSandboxId(body.sandboxId);
      const { threadId } = body;

      if (!isGateOpen('db_migrate', threadId, sandboxId)) {
        return c.json({ error: 'db_migrate gate is not open' }, 403);
      }

      // External databases: return the stored URL directly (no temp roles)
      const dbConfig = loadDbConfig(sandboxId);
      if (dbConfig.type === 'external') {
        const extUrl = resolveConnectionUrl(sandboxId);
        if (!extUrl) return c.json({ error: 'External database URL not configured' }, 500);
        return c.json({
          databaseUrl: extUrl,
          role: 'external',
          database: 'external',
          expiresAt: Date.now() + 5 * 60 * 1000,
        });
      }

      // Local: create/reuse temp role with owner-level access
      let tempRole = getActiveTempRole(sandboxId);
      if (!tempRole) {
        // Get the remaining TTL from the gate grant
        const remaining = getGateRemainingMs('db_migrate', threadId);
        const ttl = remaining > 0 ? remaining : 5 * 60 * 1000;
        tempRole = createTempMigrateRole(sandboxId, ttl);
      }

      const databaseUrl = `postgresql://${tempRole.roleName}:${tempRole.password}@127.0.0.1:5432/${tempRole.database}`;

      return c.json({
        databaseUrl,
        role: tempRole.roleName,
        database: tempRole.database,
        expiresAt: tempRole.expiresAt,
      });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.post('/api/internal/db/backup', async (c) => {
    let body: { sandboxId?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.sandboxId) return c.json({ error: 'sandboxId required' }, 400);

    try {
      const sandboxId = parseSandboxId(body.sandboxId);
      const dumpFile = backupAppDatabase(sandboxId);
      return c.json({ success: true, dumpFile });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.post('/api/internal/db/restore', async (c) => {
    let body: { sandboxId?: string; dumpFile?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.sandboxId || !body.dumpFile) {
      return c.json({ error: 'sandboxId and dumpFile required' }, 400);
    }

    try {
      const sandboxId = parseSandboxId(body.sandboxId);

      // Validate dump file path to prevent path traversal
      const resolved = require('path').resolve(body.dumpFile);
      if (!resolved.startsWith('/var/backups/ellul/postgres/')) {
        return c.json({ error: 'Invalid backup file path' }, 400);
      }

      restoreAppDatabase(sandboxId, resolved);
      return c.json({ success: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  app.get('/api/internal/db/backups', (c) => {
    const rawSandboxId = c.req.query('sandboxId');
    if (!rawSandboxId) return c.json({ error: 'sandboxId query param required' }, 400);

    try {
      const sandboxId = parseSandboxId(rawSandboxId);
      const backups = listAppBackups(sandboxId);
      return c.json({ backups });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  // ── Wallet Proxy (feature-flagged) ──
  // Follows the same pattern as POST /api/internal/db/query:
  //   validate → check gate → enforce limits → execute → audit
  //
  // The proxy signs Solana transactions OFFLINE using the VPS keypair.
  // The agent provides recentBlockhash and is responsible for broadcasting.
  // Shield never connects to Solana RPC — no outbound dependency.

  if (isWalletEnabled()) {
    let solana: typeof import('@solana/web3.js');
    try { solana = require('@solana/web3.js'); }
    catch { console.warn('[shield] @solana/web3.js not available — wallet endpoints disabled'); return; }
    const { PublicKey, Transaction, SystemProgram } = solana;
    const { loadWalletKeypair, getWalletPublicKey } = require('../application/wallets/WalletKeypair') as typeof import('../application/wallets/WalletKeypair');
    const { recordTransaction, updateTransaction, getSpentInCurrentGrant, getTransactionHistory, getTransactionByIdempotencyKey } = require('../application/wallets/WalletLedger') as typeof import('../application/wallets/WalletLedger');

    // Per-app rate limiter: max 10 signing requests per minute per app.
    // Prevents an agent with an open gate from spamming thousands of signed transactions.
    const walletRateLimits = new Map<string, { count: number; resetAt: number }>();
    const WALLET_RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
    const WALLET_RATE_LIMIT_MAX = 10;            // 10 tx/min per app

    function checkWalletRateLimit(sandboxId: string): { blocked: boolean; remaining: number } {
      const now = Date.now();
      let entry = walletRateLimits.get(sandboxId);
      if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + WALLET_RATE_LIMIT_WINDOW_MS };
        walletRateLimits.set(sandboxId, entry);
      }
      entry.count++;
      if (entry.count > WALLET_RATE_LIMIT_MAX) {
        return { blocked: true, remaining: 0 };
      }
      return { blocked: false, remaining: WALLET_RATE_LIMIT_MAX - entry.count };
    }

    // Wallet proxy: offline Solana transfer signing. Enforces wallet_spend gate,
    // authorizedRecipients binding, cumulative <= maxAmountLamports, 10/min rate, idempotency.
    app.post('/api/internal/wallet/transaction', async (c) => {
      let body: {
        sandboxId?: string;
        threadId?: string;
        recipient?: string;
        amountLamports?: number;
        recentBlockhash?: string;
        idempotencyKey?: string;
        memo?: string;
      };
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'Invalid JSON body' }, 400);
      }

      const { sandboxId: rawSandboxId, threadId, recipient, amountLamports, recentBlockhash, idempotencyKey, memo } = body;
      if (!rawSandboxId || !threadId || !recipient || !amountLamports || !recentBlockhash) {
        return c.json({ error: 'sandboxId, threadId, recipient, amountLamports, and recentBlockhash required' }, 400);
      }

      // Validate amountLamports
      if (!Number.isInteger(amountLamports) || amountLamports <= 0) {
        return c.json({ error: 'amountLamports must be a positive integer' }, 400);
      }

      // Validate idempotency key format (if provided)
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 128)) {
        return c.json({ error: 'idempotencyKey must be a string between 8-128 characters' }, 400);
      }

      // Validate recipient is plausible base58
      try {
        new PublicKey(recipient);
      } catch {
        return c.json({ error: 'Invalid recipient: not a valid Solana address' }, 400);
      }

      // Validate recentBlockhash is plausible base58
      if (typeof recentBlockhash !== 'string' || recentBlockhash.length < 32 || recentBlockhash.length > 44) {
        return c.json({ error: 'Invalid recentBlockhash' }, 400);
      }

      try {
        const sandboxId = parseSandboxId(rawSandboxId);

        // Rate limit: 10 signing requests per minute per app
        const rateLimit = checkWalletRateLimit(sandboxId);
        if (rateLimit.blocked) {
          return c.json({
            error: 'Wallet transaction rate limit exceeded (10/min per app)',
            retryAfterMs: WALLET_RATE_LIMIT_WINDOW_MS,
          }, 429);
        }

        // Idempotency: return cached result if this key was already processed
        if (idempotencyKey) {
          const existing = getTransactionByIdempotencyKey(sandboxId, idempotencyKey);
          if (existing) {
            return c.json({
              success: true,
              txId: existing.txId,
              signedTransaction: existing.metadata ? JSON.parse(existing.metadata)?.signedTransaction : undefined,
              amountLamports: existing.amountLamports,
              status: existing.status,
              idempotent: true,
            });
          }
        }

        // Check gate
        if (!isGateOpen('wallet_spend' as GateType, threadId, sandboxId)) {
          return c.json({
            error: "Gate 'wallet_spend' is not open. Request access via the gate system.",
            requiredGate: 'wallet_spend',
          }, 403);
        }

        // Get grant metadata for spending limits + authorized recipients
        const grant = getGateGrant('wallet_spend' as GateType, threadId, sandboxId);
        if (!grant?.metadata) {
          return c.json({ error: 'wallet_spend gate has no metadata (spending limits not set)' }, 403);
        }

        const maxAmountLamports = grant.metadata.maxAmountLamports as number;
        const authorizedRecipients = grant.metadata.authorizedRecipients as string[];

        // Verify recipient is authorized (prevents blank check attack)
        if (!authorizedRecipients.includes(recipient)) {
          return c.json({
            error: 'Recipient not in authorized list. The operator must approve this recipient.',
            recipient,
          }, 403);
        }

        // Enforce spending limit
        const gateKey = `app:${sandboxId}:wallet_spend`;
        const alreadySpent = getSpentInCurrentGrant(sandboxId, gateKey);
        if (alreadySpent + amountLamports > maxAmountLamports) {
          return c.json({
            error: 'Spending limit exceeded for this gate grant',
            alreadySpent,
            requested: amountLamports,
            maxAmountLamports,
            remaining: maxAmountLamports - alreadySpent,
          }, 403);
        }

        // ── QUANTUM-BLIND TRANSACTION ENFORCEMENT ──
        // Ensure the signing address has never been used for an outbound tx.
        // If it has, the Ed25519 public key is exposed on the Solana ledger
        // and a future CRQC could derive the private key.
        const { isAddressUsed, markAddressUsed, tryAcquireSigningLock } = await import('../application/wallets/WalletLedger');
        const { getCurrentReceiveAddress, getCurrentReceiveIndex, deriveNextKeypair, advanceToNextAddress } = await import('../application/wallets/WalletKeypair');
        const { SOLANA_RENT_EXEMPT_MINIMUM, SOLANA_ESTIMATED_FEE_PER_INSTRUCTION } = await import('../config');

        const currentAddress = getCurrentReceiveAddress();
        const currentIndex = getCurrentReceiveIndex();

        if (!currentAddress || currentIndex === null) {
          return c.json({ error: 'HD wallet not initialized. Call wallet setup first.' }, 500);
        }

        // Acquire signing mutex (prevents TOCTOU race on concurrent requests)
        const releaseLock = tryAcquireSigningLock(currentIndex);
        if (!releaseLock) {
          return c.json({
            error: 'ADDRESS_LOCKED_FOR_SWEEP',
            message: 'Another transaction is being signed from this address. Retry after sweep completes.',
            retryAfterMs: 2000,
            currentAddress,
          }, 409);
        }

        try {
          // Quantum-blind check: reject if address already has outbound tx history
          if (isAddressUsed(currentAddress)) {
            return c.json({
              error: 'QUANTUM_BLIND_REJECT',
              message: 'Signing address has prior outbound transactions. ' +
                       'Public key is exposed on the Solana ledger. ' +
                       'Call POST /api/internal/wallet/rotate to advance to a fresh address.',
              address: currentAddress,
              quantumBlindCheck: 'FAILED',
            }, 403);
          }

          // Load current keypair (decrypts secret key from HD seed)
          const keypair = loadWalletKeypair();
          if (!keypair) {
            return c.json({ error: 'Wallet keypair not available' }, 500);
          }

          // Calculate atomic sweep: must drain account to exactly 0 lamports
          const balanceLamports = (body as any).balanceLamports as number | undefined;
          const instructionCount = balanceLamports ? 2 : 1;
          const estimatedFee = SOLANA_ESTIMATED_FEE_PER_INSTRUCTION * instructionCount;

          // Record transaction as pending
          const txId = crypto.randomUUID();
          recordTransaction({
            txId,
            sandboxId,
            threadId,
            type: 'spend',
            amountLamports,
            recipient,
            gateKey,
            idempotencyKey,
            metadata: { memo, recentBlockhash },
          });

          // Construct Solana transaction
          const transaction = new Transaction();
          transaction.recentBlockhash = recentBlockhash;
          transaction.feePayer = keypair.publicKey;

          // Instruction 1: Transfer requested amount to recipient
          transaction.add(
            SystemProgram.transfer({
              fromPubkey: keypair.publicKey,
              toPubkey: new PublicKey(recipient),
              lamports: amountLamports,
            }),
          );

          // Instruction 2: Atomic sweep to change address (if balance provided)
          let changeAddress: string | null = null;
          let sweepAmount = 0;

          if (balanceLamports && balanceLamports > amountLamports + estimatedFee) {
            sweepAmount = balanceLamports - amountLamports - estimatedFee;

            // Reject if sweep would leave dust below rent-exemption minimum
            if (sweepAmount > 0 && sweepAmount < SOLANA_RENT_EXEMPT_MINIMUM) {
              keypair.secretKey.fill(0);
              return c.json({
                error: 'QUANTUM_DUST_TRAP',
                message: 'Sweep amount is below Solana rent-exemption minimum. ' +
                         'Adjust amountLamports to leave either 0 or >= ' +
                         SOLANA_RENT_EXEMPT_MINIMUM + ' lamports for the change address.',
                sweepAmount,
                rentExemptMinimum: SOLANA_RENT_EXEMPT_MINIMUM,
              }, 400);
            }

            if (sweepAmount >= SOLANA_RENT_EXEMPT_MINIMUM) {
              const nextResult = deriveNextKeypair();
              if (nextResult) {
                changeAddress = nextResult.keypair.publicKey.toBase58();
                transaction.add(
                  SystemProgram.transfer({
                    fromPubkey: keypair.publicKey,
                    toPubkey: nextResult.keypair.publicKey,
                    lamports: sweepAmount,
                  }),
                );
                nextResult.keypair.secretKey.fill(0);
              }
            }
          }

          transaction.sign(keypair);

          const signedTransaction = transaction.serialize().toString('base64');

          // Zero the keypair secret key after use
          keypair.secretKey.fill(0);

          // Mark address as used and advance to next (UNDER LOCK)
          markAddressUsed(currentAddress, currentIndex, txId, changeAddress);
          if (changeAddress) {
            advanceToNextAddress();
          }

          // Update transaction status
          updateTransaction(txId, {
            status: 'signed',
            metadata: { signedTransaction, memo, changeAddress, sweepAmount },
          });

          const remaining = maxAmountLamports - alreadySpent - amountLamports;

          return c.json({
            success: true,
            txId,
            signedTransaction,
            amountLamports,
            changeAddress,
            sweepAmountLamports: sweepAmount,
            quantumBlindCheck: 'PASSED',
            remainingLimitLamports: remaining,
            status: 'signed',
          });
        } finally {
          // Release signing lock (always, even on error)
          releaseLock();
        }
      } catch (err: any) {
        return c.json({ error: err.message }, 500);
      }
    });

    app.get('/api/internal/wallet/balance', (c) => {
      const publicKey = getWalletPublicKey();
      if (!publicKey) {
        return c.json({ error: 'Wallet not initialized' }, 404);
      }

      // Balance is tracked via the Solana network — agent queries RPC directly.
      // We only return the public key so the agent knows where to check.
      return c.json({
        publicKey,
        note: 'Query Solana RPC for on-chain balance. This endpoint provides the wallet address.',
      });
    });

    app.get('/api/internal/wallet/transactions', (c) => {
      const rawSandboxId = c.req.query('sandboxId');
      if (!rawSandboxId) return c.json({ error: 'sandboxId query param required' }, 400);

      try {
        const sandboxId = parseSandboxId(rawSandboxId);
        const limit = parseInt(c.req.query('limit') || '50', 10);
        const transactions = getTransactionHistory(sandboxId, Math.min(limit, 100));
        return c.json({ transactions });
      } catch (err: any) {
        return c.json({ error: err.message }, 400);
      }
    });

    app.get('/api/internal/wallet/status', async (c) => {
      const { getCurrentReceiveAddress, getCurrentReceiveIndex, isHdWalletActive } = await import('../application/wallets/WalletKeypair');
      const { getUsedAddressCount } = await import('../application/wallets/WalletLedger');

      const currentAddress = getCurrentReceiveAddress();
      const derivationIndex = getCurrentReceiveIndex();

      return c.json({
        currentAddress,
        derivationIndex,
        quantumBlindCheck: currentAddress ? 'PASSED' : 'UNKNOWN',
        addressUsedCount: getUsedAddressCount(),
        hdWalletVersion: isHdWalletActive() ? 2 : 1,
        nextDerivationIndex: derivationIndex !== null ? derivationIndex + 1 : null,
      });
    });
  }
}
