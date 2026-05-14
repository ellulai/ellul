// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * CLI Environment Service
 *
 * Manages CLI API keys stored in ~/.ellul-cli-env.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CLI_ENV_FILE, CLI_KEY_MAP } from '../../config';

// Re-export for consumers
export { CLI_KEY_MAP };

/**
 * Load env vars from ~/.ellul-cli-env.
 */
export function loadCliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    if (!fs.existsSync(CLI_ENV_FILE)) return env;
    const lines = fs.readFileSync(CLI_ENV_FILE, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^export\s+(\w+)=["']?(.+?)["']?$/);
      if (match && match[1] && match[2]) {
        env[match[1]] = match[2];
      }
    }
  } catch {}
  return env;
}

/**
 * Save a key to ~/.ellul-cli-env (creates or updates).
 */
export function saveCliKey(varName: string, value: string): void {
  let lines: string[] = [];
  try {
    if (fs.existsSync(CLI_ENV_FILE)) {
      lines = fs.readFileSync(CLI_ENV_FILE, 'utf8').split('\n');
    }
  } catch {}

  const exportLine = 'export ' + varName + "='" + value.replace(/'/g, "'\\''") + "'";
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] as string).match(new RegExp('^export\\s+' + varName + '='))) {
      lines[i] = exportLine;
      found = true;
      break;
    }
  }
  if (!found) lines.push(exportLine);

  // Remove empty lines at end
  while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === '') lines.pop();
  fs.writeFileSync(CLI_ENV_FILE, lines.join('\n') + '\n', { mode: 0o600 });
}

/**
 * Remove a key from ~/.ellul-cli-env.
 */
export function removeCliKey(varName: string): void {
  try {
    if (!fs.existsSync(CLI_ENV_FILE)) return;
    let lines = fs.readFileSync(CLI_ENV_FILE, 'utf8').split('\n');
    lines = lines.filter((l) => !l.match(new RegExp('^export\\s+' + varName + '=')));
    while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === '') lines.pop();
    fs.writeFileSync(CLI_ENV_FILE, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
  } catch {}
}

/**
 * Allowlisted env vars safe to pass to untrusted agent processes.
 *
 * SECURITY: Agents are untrusted — never inherit the full process.env.
 * This prevents leaking AI proxy tokens, JWT secrets, DATABASE_URL, or
 * any other sensitive vars from the agent-bridge systemd environment.
 */
const AGENT_ENV_ALLOWLIST = new Set([
  // System essentials
  'PATH', 'HOME', 'USER', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'TMPDIR',
  'TZ', 'HOSTNAME',
  // XDG (overridden per-thread, but allow base values)
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  // Node.js runtime — NODE_OPTIONS removed: allows --require for arbitrary code loading.
  // npm_config_prefix removed: unnecessary exposure.
  'NODE_ENV', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'NO_COLOR', 'FORCE_COLOR',
  // CLI tool config (non-secret)
  'EDITOR', 'VISUAL', 'PAGER', 'COLORTERM', 'TERM_PROGRAM',
  // Network — proxy vars passed but credentials stripped (see getCliSpawnEnv below)
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
]);

/**
 * Strip embedded credentials from proxy URLs.
 * `http://user:pass@proxy:8080` → `http://proxy:8080`
 */
function stripProxyCredentials(value: string): string {
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return value; // Not a URL — pass through
  }
}

const PROXY_KEYS = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
]);

/**
 * Get spawn env with CLI keys merged, filtered to safe allowlist.
 *
 * SECURITY: Only passes allowlisted vars from process.env + CLI keys from
 * ~/.ellul-cli-env. Prevents agent access to AI proxy tokens, JWT secrets,
 * DATABASE_URL, and other sensitive agent-bridge environment variables.
 */
export function getCliSpawnEnv(): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const key of AGENT_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      // SECURITY: Strip embedded credentials from proxy URLs to prevent
      // leaking proxy auth (e.g. http://user:pass@proxy:8080) to agents.
      filtered[key] = PROXY_KEYS.has(key)
        ? stripProxyCredentials(process.env[key]!)
        : process.env[key];
    }
  }
  return { ...filtered, ...loadCliEnv(), TERM: 'xterm-256color' };
}

/**
 * Check if a CLI needs first-time setup (not authenticated/configured).
 */
export function checkCliNeedsSetup(session: string): boolean {
  try {
    switch (session) {
      case 'claude': {
        // Greenfield: claude auth state is owned by sovereign-shield, not by
        // any field on disk in the agent's home. Bridge consults the cached
        // peek state from internal-http/auth-routes.ts for UI surfacing;
        // checkCliNeedsSetup is the sync CLI-tool model and would block on
        // an HTTP call. The shield's /peek endpoint is the canonical signal;
        // this synchronous helper conservatively returns false (assume
        // configured) so the CLI-tool UI doesn't false-positive a setup
        // prompt for claude. The workbench surfaces the actual login UI via
        // the dedicated peek poll in auth-routes.ts.
        return false;
      }
      case 'codex': {
        // Codex stores auth via OpenAI config
        const codexAuth = path.join(process.env.HOME || '/home/' + (process.env.USER || 'dev'), '.codex', 'auth.json');
        const openaiKey = process.env.OPENAI_API_KEY || loadCliEnv()['OPENAI_API_KEY'];
        return !fs.existsSync(codexAuth) && !openaiKey;
      }
      default:
        return false;
    }
  } catch {
    return true; // If we can't check, assume needs setup
  }
}

/**
 * Get CLI keys status for frontend.
 */
export function getCliKeysStatus(): Record<string, { set: boolean; masked?: string }> {
  const env = loadCliEnv();
  const keys: Record<string, { set: boolean; masked?: string }> = {};
  for (const [provider, varName] of Object.entries(CLI_KEY_MAP)) {
    const value = env[varName];
    keys[provider] = value
      ? { set: true, masked: '***' + (value.slice(-4) || '') }
      : { set: false };
  }
  return keys;
}
