// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * ellul doctor — Health diagnostics for the local daemon
 *
 * Checks:
 *   ✓ daemon running (socket probe)
 *   ✓ guardrail binary found + version
 *   ✓ master secret in keychain
 *   ✓ project bound in cwd
 *   ✓ rules.db initialized + rule count
 *   ✓ .mcp.json configured
 *   ✓ exec mode (capability/unrestricted)
 *   ✓ checksum integrity of materialized rules
 *   ✓ peer credential tier
 */

import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import { spawnSync } from 'child_process';
import { getAvailableTier } from '../index';
import { resolveGuardrailBinary } from '../index';

const CONFIG_DIR = path.join(process.env.HOME || '~', '.ellul');
const SOCKET_PATH = path.join(CONFIG_DIR, 'daemon.sock');

type Status = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  status: Status;
  detail: string;
}

function check(name: string, status: Status, detail: string): Check {
  return { name, status, detail };
}

function symbol(s: Status): string {
  switch (s) {
    case 'ok': return '✓';
    case 'warn': return '⚠';
    case 'fail': return '✗';
  }
}

async function checkDaemon(): Promise<Check> {
  if (!fs.existsSync(SOCKET_PATH)) {
    return check('Daemon', 'fail', 'Not running (no socket at ~/.ellul/daemon.sock)');
  }

  return new Promise((resolve) => {
    const sock = new net.Socket();
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(check('Daemon', 'fail', 'Socket exists but not responding'));
    }, 2000);

    sock.connect(SOCKET_PATH, () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(check('Daemon', 'ok', 'Running on Unix socket'));
    });

    sock.on('error', () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(check('Daemon', 'fail', 'Socket exists but connection refused (stale?)'));
    });
  });
}

function checkGuardrailBinary(): Check {
  const binary = resolveGuardrailBinary();
  if (!binary) {
    return check('Guardrail binary', 'fail', 'Not found. Install at ~/.ellul/bin/guardrail');
  }
  return check('Guardrail binary', 'ok', binary);
}

function checkMasterSecret(): Check {
  const KEYCHAIN_SERVICE = 'ai.ellul.local-daemon';
  if (process.platform === 'darwin') {
    const result = spawnSync('security', [
      'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'master-secret', '-w',
    ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (result.status === 0) {
      return check('Master secret', 'ok', 'Stored in macOS Keychain');
    }
  } else {
    const result = spawnSync('secret-tool', [
      'lookup', 'service', KEYCHAIN_SERVICE, 'account', 'master-secret',
    ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (result.status === 0) {
      return check('Master secret', 'ok', 'Stored in Linux secret-tool');
    }
  }

  const fallbackFile = path.join(CONFIG_DIR, 'master.key');
  if (fs.existsSync(fallbackFile)) {
    return check('Master secret', 'warn', 'Stored in fallback file (keychain recommended)');
  }

  return check('Master secret', 'fail', 'Not found. Run: ellul init');
}

function checkProject(): Check {
  const projectFile = path.join(process.cwd(), '.ellul', 'project.json');
  if (!fs.existsSync(projectFile)) {
    return check('Project binding', 'fail', 'No .ellul/project.json in cwd. Run: ellul init');
  }

  try {
    const config = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
    if (!config.projectSlug) {
      return check('Project binding', 'fail', 'project.json missing projectSlug');
    }
    return check('Project binding', 'ok', `${config.projectName || config.projectSlug} (${config.projectSlug})`);
  } catch {
    return check('Project binding', 'fail', 'project.json is malformed');
  }
}

function checkRulesDb(): Check {
  const dbPath = path.join(CONFIG_DIR, 'guardrails', 'rules.db');
  if (!fs.existsSync(dbPath)) {
    return check('Rule store', 'fail', 'rules.db not found. Run: ellul init');
  }

  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT COUNT(*) as count FROM guardrail_rules WHERE enabled = 1').get() as { count: number };
    db.close();
    return check('Rule store', 'ok', `${row.count} active rules`);
  } catch (err) {
    return check('Rule store', 'fail', `Database error: ${(err as Error).message}`);
  }
}

function checkMcpConfig(): Check {
  const mcpFile = path.join(process.cwd(), '.mcp.json');
  if (!fs.existsSync(mcpFile)) {
    return check('MCP config', 'warn', 'No .mcp.json in cwd. Agents won\'t discover ellul tools.');
  }

  try {
    const config = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
    const servers = config.mcpServers || {};
    if (servers.ellul || servers['ellul-local']) {
      return check('MCP config', 'ok', 'ellul server configured in .mcp.json');
    }
    return check('MCP config', 'warn', '.mcp.json exists but no ellul server configured');
  } catch {
    return check('MCP config', 'warn', '.mcp.json is malformed');
  }
}

function checkExecMode(): Check {
  const globalConfig = path.join(CONFIG_DIR, 'config.json');
  const projectConfig = path.join(process.cwd(), '.ellul', 'config.json');

  let mode = 'capability';
  for (const configPath of [globalConfig, projectConfig]) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (config.execMode === 'unrestricted') mode = 'unrestricted';
    } catch { /* file doesn't exist or malformed */ }
  }

  if (mode === 'unrestricted') {
    return check('Exec mode', 'warn', 'UNRESTRICTED — any command allowed when exec gate open');
  }
  return check('Exec mode', 'ok', 'capability (test/build/lint/dev only)');
}

function checkPeercred(): Check {
  const tier = getAvailableTier();
  switch (tier) {
    case 'native-addon':
      return check('Peer credentials', 'ok', 'N-API native addon (per-connection UID verification)');
    case 'helper-binary':
      return check('Peer credentials', 'ok', 'C helper binary (per-connection UID verification)');
    case 'filesystem-only':
      return check('Peer credentials', 'warn', 'Filesystem permissions only (no per-connection UID check)');
  }
}

function checkChecksumIntegrity(): Check {
  const checksumFile = path.join(CONFIG_DIR, 'guardrails', 'checksums.json');
  if (!fs.existsSync(checksumFile)) {
    return check('Rule integrity', 'warn', 'No checksums.json — rules may not have been materialized');
  }

  try {
    const stored = JSON.parse(fs.readFileSync(checksumFile, 'utf8')) as Record<string, string>;
    let mismatched = 0;
    const crypto = require('crypto') as typeof import('crypto');

    for (const dir of ['global', 'workspace']) {
      const dirPath = path.join(CONFIG_DIR, 'guardrails', dir);
      try {
        for (const file of fs.readdirSync(dirPath)) {
          if (!file.endsWith('.scm')) continue;
          const content = fs.readFileSync(path.join(dirPath, file));
          const hash = crypto.createHash('sha256').update(content).digest('hex');
          if (stored[file] !== hash) mismatched++;
        }
      } catch { /* dir may not exist */ }
    }

    if (mismatched > 0) {
      return check('Rule integrity', 'warn', `${mismatched} file(s) modified outside daemon — will be restored on next scan`);
    }
    return check('Rule integrity', 'ok', `All materialized rules match SQLite source of truth`);
  } catch {
    return check('Rule integrity', 'warn', 'Could not verify checksums');
  }
}

export async function runDoctor(): Promise<void> {
  process.stderr.write('ellul doctor — local daemon health check\n\n');

  const checks: Check[] = [
    await checkDaemon(),
    checkGuardrailBinary(),
    checkMasterSecret(),
    checkProject(),
    checkRulesDb(),
    checkMcpConfig(),
    checkExecMode(),
    checkPeercred(),
    checkChecksumIntegrity(),
  ];

  for (const c of checks) {
    process.stderr.write(`  ${symbol(c.status)} ${c.name}: ${c.detail}\n`);
  }

  const failures = checks.filter(c => c.status === 'fail');
  const warnings = checks.filter(c => c.status === 'warn');

  process.stderr.write('\n');
  if (failures.length > 0) {
    process.stderr.write(`${failures.length} issue(s) need attention.\n`);
    process.exit(1);
  } else if (warnings.length > 0) {
    process.stderr.write(`All checks passed (${warnings.length} warning(s)).\n`);
  } else {
    process.stderr.write('All checks passed.\n');
  }
}
