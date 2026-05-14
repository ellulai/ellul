// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Never throws on the happy path — failures degrade gracefully to an

import * as fs from 'fs';
import * as path from 'path';
import type {
  IntegrationsResponse,
  IntegrationState,
} from '@ellul.ai/types';
import { PATHS } from '../../config';
import { callShieldInternal } from '@vps/shared/shield-client';

const LOG_PREFIX = '[integrations]';
const CACHE_TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;

// ─── Cache ──────────────────────────────────────────────────────────────────

interface CachedEntry {
  response: IntegrationsResponse;
  writtenAt: number;
}

const cache: Map<string, CachedEntry> = new Map();

// Drop cached integrations. Called after a successful action so the next
export function invalidateIntegrationsCache(sandboxId?: string): void {
  if (sandboxId) {
    cache.delete(sandboxId);
  } else {
    cache.clear();
  }
}

// ─── Control-plane fetch ────────────────────────────────────────────────────

interface VpsCredentials {
  serverId: string;
  apiUrl: string;
  token: string;
}

// Read the VPS identity + API bearer from disk. Mirrors the pattern in
function readVpsCredentials(): VpsCredentials | null {
  try {
    const serverId = fs.readFileSync(PATHS.SERVER_ID, 'utf8').trim();
    const apiUrl = fs.readFileSync(PATHS.API_URL, 'utf8').trim();
    const token = process.env.AI_PROXY_TOKEN?.trim() || '';
    if (!serverId || !apiUrl || !token) return null;
    return { serverId, apiUrl, token };
  } catch {
    return null;
  }
}

// Empty response used as a fail-safe when the control plane is unreachable
function emptyResponse(sandboxId: string): IntegrationsResponse {
  return {
    sandboxId,
    state: {
      deployProviders: [],
      dataProviders: [],
      gitProviders: [],
      cloudflareProviders: [],
      paymentProviders: [],
      hasLinkedRepo: false,
      hasDeployConfig: false,
      hasDatabase: false,
      hasMigrations: false,
    },
    connections: {
      deploy: [],
      data: [],
      git: [],
      cloudflare: [],
      payments: [],
    },
    computedAt: Date.now(),
  };
}

// Fetch the control-plane snapshot. Returns null on failure — the caller
async function fetchControlPlane(
  sandboxId: string,
  creds: VpsCredentials,
): Promise<IntegrationsResponse | null> {
  try {
    const res = await fetch(
      `${creds.apiUrl}/api/servers/${creds.serverId}/integrations?sandboxId=${encodeURIComponent(sandboxId)}`,
      {
        headers: {
          Authorization: `Bearer ${creds.token}`,
          Accept: 'application/json',
          'User-Agent': 'ellul-file-api/1.0',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    );

    if (!res.ok) {
      console.warn(`${LOG_PREFIX} control plane returned ${res.status} for ${sandboxId}`);
      return null;
    }

    const body = (await res.json()) as IntegrationsResponse;
    // Basic shape guard — any malformed payload falls through to `emptyResponse`.
    if (!body || typeof body !== 'object' || !body.state || !body.connections) {
      console.warn(`${LOG_PREFIX} control plane returned malformed body for ${sandboxId}`);
      return null;
    }
    return body;
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} control plane fetch failed for ${sandboxId}:`,
      (err as Error).message,
    );
    return null;
  }
}

// ─── Local signals (VPS-only) ───────────────────────────────────────────────

// True when the project directory has at least one git remote configured.
export function detectGitRemote(projectDir: string): boolean {
  try {
    const configPath = path.join(projectDir, '.git', 'config');
    const text = fs.readFileSync(configPath, 'utf8');
    // A valid remote section looks like: [remote "origin"]
    return /\n?\[remote\s+"[^"]+"\]/.test(text);
  } catch {
    return false;
  }
}

// True when the project is set up to run database migrations. Heuristic
export function detectMigrations(projectDir: string): boolean {
  // Node: package.json scripts
  try {
    const pkgPath = path.join(projectDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const raw = fs.readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw);
      const scripts = pkg?.scripts ?? {};
      const haystack = `${Object.keys(scripts).join(' ')} ${Object.values(scripts)
        .filter((v): v is string => typeof v === 'string')
        .join(' ')}`;
      // Tight word-boundary match — no false positives from "emigrate" etc.
      if (
        /\b(migrate|db:push|db:migrate|prisma|drizzle|knex|sequelize|sqlx|flyway|liquibase|alembic|goose)\b/i.test(
          haystack,
        )
      ) {
        return true;
      }
    }
  } catch {
    // fall through to other checks
  }

  // Known migration runner directories / config files
  const markers = [
    'prisma',
    'drizzle',
    'migrations',
    'db/migrate',
    'db/migrations',
    'alembic.ini',
    'flyway.conf',
    'liquibase.properties',
    'supabase/migrations',
  ];
  for (const marker of markers) {
    try {
      if (fs.existsSync(path.join(projectDir, marker))) return true;
    } catch {
      // next
    }
  }

  // Python: django management command flag in manage.py
  try {
    const managePy = path.join(projectDir, 'manage.py');
    if (fs.existsSync(managePy)) {
      const text = fs.readFileSync(managePy, 'utf8');
      if (/django\.core\.management/.test(text)) return true;
    }
  } catch {
    // swallow
  }

  return false;
}

// Ask sovereign-shield whether this app has a provisioned database. Returns
export async function detectShieldDatabase(sandboxId: string): Promise<boolean> {
  try {
    const res = await callShieldInternal(
      `/api/internal/db/info?sandboxId=${encodeURIComponent(sandboxId)}`,
      { timeout: 5_000 },
    );
    if (!res.ok) return false;
    const body = await res.json();
    return Boolean(body?.exists);
  } catch {
    return false;
  }
}

// ─── Merge ──────────────────────────────────────────────────────────────────

// `.git/config` with a remote. AND-only: the VPS never upgrades a false
export function mergeIntegrationState(
  controlPlane: IntegrationState,
  local: { gitRemote: boolean; shieldDatabase: boolean; migrations: boolean },
): IntegrationState {
  return {
    ...controlPlane,
    hasLinkedRepo: controlPlane.hasLinkedRepo && local.gitRemote,
    hasDatabase: controlPlane.hasDatabase || local.shieldDatabase,
    hasMigrations: local.migrations,
  };
}

// ─── Public entry point ─────────────────────────────────────────────────────

// cache when fresh, otherwise fetches + merges + caches.
export async function getIntegrations(
  sandboxId: string,
  projectDir: string,
): Promise<IntegrationsResponse> {
  const cached = cache.get(sandboxId);
  if (cached && Date.now() - cached.writtenAt < CACHE_TTL_MS) {
    return cached.response;
  }

  const creds = readVpsCredentials();
  const controlPlaneSnapshot = creds
    ? await fetchControlPlane(sandboxId, creds)
    : null;

  const base = controlPlaneSnapshot ?? emptyResponse(sandboxId);

  const [migrations, shieldDatabase] = await Promise.all([
    Promise.resolve(detectMigrations(projectDir)),
    detectShieldDatabase(sandboxId),
  ]);
  const gitRemote = detectGitRemote(projectDir);

  const merged: IntegrationsResponse = {
    sandboxId,
    state: mergeIntegrationState(base.state, {
      gitRemote,
      shieldDatabase,
      migrations,
    }),
    connections: base.connections,
    computedAt: Date.now(),
  };

  cache.set(sandboxId, { response: merged, writtenAt: Date.now() });
  return merged;
}
