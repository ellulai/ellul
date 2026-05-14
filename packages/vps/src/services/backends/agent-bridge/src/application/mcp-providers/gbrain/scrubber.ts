// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// gbrain write-path scrub middleware.
//
// Security invariant: gate tokens, JWTs, IPC tokens, credentials,
// env var values, and API keys must NEVER reach gbrain's Postgres.
// Intercepts all string values in write-path tool args and redacts
// known secret patterns. Fail-closed: throws on redaction failure.
//
// Implements McpProviderScrubber so the gateway can apply it
// generically without gbrain-specific imports.

import * as fs from 'fs';
import type { McpProviderScrubber } from '../types';

const REDACTED = '[REDACTED]';

const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'put_page',
  'sync_brain',
  'create_take',
  'put_timeline_event',
]);

// ── Pattern-based redaction ──

const JWT_RE = /eyJ[A-Za-z0-9\-_=]{10,}\.[A-Za-z0-9\-_=]{10,}\.[A-Za-z0-9\-_.+/=]*/g;

const SECRET_PREFIX_RE = /\b(sk-[A-Za-z0-9\-_]{20,}|pk_live_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{36,}|gho_[A-Za-z0-9]{36,}|xoxb-[A-Za-z0-9\-]{20,}|xoxp-[A-Za-z0-9\-]{20,}|AKIA[A-Z0-9]{16}|sk-ant-[A-Za-z0-9\-_]{20,})/g;

const HEX_ASSIGNMENT_RE = /(?<=[=:])\s*[0-9a-fA-F]{32,}/g;

const BASE64_KEY_RE = /[A-Za-z0-9+/]{40,}={0,2}/g;

const ENV_ASSIGNMENT_RE = /[A-Z_]{2,}=\S{8,}/g;

// ── Vault secret dictionary ──

let _cachedSecrets: Set<string> | null = null;
let _secretsReadAt = 0;
const SECRETS_CACHE_MS = 60_000;
const SECRET_NAMES_DIR = '/etc/ellul/secrets';

function loadVaultSecrets(): Set<string> | null {
  const now = Date.now();
  if (_cachedSecrets && now - _secretsReadAt < SECRETS_CACHE_MS) {
    return _cachedSecrets;
  }

  try {
    const secrets = new Set<string>();
    if (!fs.existsSync(SECRET_NAMES_DIR)) return secrets;
    const files = fs.readdirSync(SECRET_NAMES_DIR);
    for (const f of files) {
      if (!f.endsWith('.env')) continue;
      try {
        const content = fs.readFileSync(`${SECRET_NAMES_DIR}/${f}`, 'utf8');
        for (const line of content.split('\n')) {
          const eqIdx = line.indexOf('=');
          if (eqIdx < 1) continue;
          const val = line.slice(eqIdx + 1).trim();
          if (val.length >= 6) secrets.add(val);
        }
      } catch { /* skip unreadable files */ }
    }
    _cachedSecrets = secrets;
    _secretsReadAt = now;
    return secrets;
  } catch {
    return null;
  }
}

function scrubString(input: string): string {
  let result = input;

  result = result.replace(JWT_RE, REDACTED);
  result = result.replace(SECRET_PREFIX_RE, REDACTED);
  result = result.replace(HEX_ASSIGNMENT_RE, ` ${REDACTED}`);
  result = result.replace(BASE64_KEY_RE, (match) => {
    if (match.length < 40) return match;
    const entropy = new Set(match).size;
    if (entropy < 10) return match;
    return REDACTED;
  });
  result = result.replace(ENV_ASSIGNMENT_RE, (match) => {
    const eqIdx = match.indexOf('=');
    const key = match.slice(0, eqIdx);
    const val = match.slice(eqIdx + 1);
    if (/^(PATH|HOME|USER|NODE_ENV|SHELL|LANG|TERM|PWD)$/.test(key)) return match;
    if (SECRET_PREFIX_RE.test(val)) return `${key}=${REDACTED}`;
    SECRET_PREFIX_RE.lastIndex = 0;
    return match;
  });

  const vaultSecrets = loadVaultSecrets();
  if (vaultSecrets) {
    for (const secret of vaultSecrets) {
      if (result.includes(secret)) {
        result = result.split(secret).join(REDACTED);
      }
    }
  }

  return result;
}

function scrubValue(value: unknown): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubValue(v);
    }
    return out;
  }
  return value;
}

export const gbrainScrubber: McpProviderScrubber = {
  writeTools: WRITE_TOOLS,
  scrubArgs(args: Record<string, unknown>): Record<string, unknown> {
    return scrubValue(args) as Record<string, unknown>;
  },
};
