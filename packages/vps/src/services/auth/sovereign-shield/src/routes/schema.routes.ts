// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Schema Routes — API schema for agent discovery
 *
 * Returns the full API schema so agents can discover available
 * operations without burning context on large static files.
 *
 * Endpoints:
 * - GET /_auth/schema - Returns API schema JSON
 */

import type { Hono } from 'hono';

const SCHEMA = {
  version: '1.0',
  description: 'ellul Sovereign Shield API — agent-accessible endpoints via auth proxy',
  endpoints: {
    // ── Gates ──
    'POST /_auth/gates/request': {
      description: 'Request a gate (permission) to perform a privileged operation',
      body: { gate: 'string (db_read|db_write|db_migrate|git|deploy)', project: 'string', reason: 'string' },
      response: '{ status: "granted"|"pending"|"already_granted", requestId?: string, expiresAt?: number }',
      notes: 'If pending, poll GET /_auth/gates/request/:id/status until granted or denied',
    },
    'GET /_auth/gates/request/:id/status': {
      description: 'Poll gate request status',
      response: '{ status: "pending"|"granted"|"denied", gate: string, expiresAt?: number }',
    },
    'GET /_auth/gates/active?project=X': {
      description: 'List currently active gates for a project',
      response: '{ gates: Array<{ gate: string, expiresAt: number, scope: string }> }',
    },

    // ── Secrets ──
    'GET /_auth/secrets?app=X&env=Y': {
      description: 'List secret names (no values) for an app',
      response: '{ names: string[], classifications: Record<string, "secret"|"plain"> }',
    },
    'GET /_auth/secrets/values?app=X&env=Y': {
      description: 'Read decrypted secret values for an app',
      response: '{ values: Record<string, string> }',
    },
    'POST /_auth/secrets': {
      description: 'Set a secret (encrypted client-side)',
      body: { name: 'string', sandboxId: 'string', env: 'string', encryptedKey: 'string', iv: 'string', encryptedData: 'string' },
    },
    'DELETE /_auth/secrets/:name?app=X&env=Y': {
      description: 'Delete a secret',
    },

    // ── Database ──
    'GET /_auth/db/status?app=X': {
      description: 'Check if database is provisioned',
      gates: 'none',
      response: '{ provisioned: boolean, app: string, database: string }',
    },
    'POST /_auth/db/query': {
      description: 'Execute a read-only SQL query',
      gates: 'db_read',
      body: { sql: 'string', app: 'string' },
      response: '{ columns: string[], rows: Record<string, unknown>[], rowCount: number }',
    },
    'POST /_auth/db/execute': {
      description: 'Execute a write SQL statement',
      gates: 'db_write or db_migrate',
      body: { sql: 'string', app: 'string' },
    },
    'POST /_auth/db/provision': {
      description: 'Provision a PostgreSQL database for an app',
      gates: 'db_migrate',
      body: { app: 'string' },
    },
    'POST /_auth/db/backup': {
      description: 'Trigger a database backup',
      body: { app: 'string' },
      response: '{ path: string }',
    },

    // ── Projects ──
    'GET /_auth/projects': {
      description: 'List all known projects',
      response: '{ projects: Array<{ id: string, name: string }> }',
    },
    'POST /_auth/projects': {
      description: 'Register a new project (provisions shielded workspace)',
      body: { name: 'string' },
      response: '{ id: string, name: string, shielded: { workspace: string, cache: string, subnet: { hostIp, nsIp, subnet } } | null }',
    },
    'DELETE /_auth/projects/:name': {
      description: 'Delete a project and all shielded data',
      response: '{ deleted: boolean, name: string }',
    },

    // ── Sovereign Sandbox (exec) ──
    'POST /_auth/exec/sync?project=X': {
      description: 'Upload tar.gz of workspace to VPS shielded directory',
      body: 'Raw tar.gz binary (Content-Type: application/gzip)',
      response: '{ ok: boolean, filesCount: number }',
      notes: 'Max 50MB. Validates gzip magic bytes. Cleans workspace before extraction.',
    },
    'POST /_auth/exec/patch': {
      description: 'Incremental file patches for HMR-speed updates',
      body: { project: 'string', files: '[{ path: string, content?: string (base64), action: "write"|"delete" }]' },
      response: '{ ok: boolean, applied: number, errors?: string[] }',
      notes: 'Max 5MB total. Path traversal protected.',
    },
    'GET /_auth/exec/run?cmd=X&project=Y': {
      description: 'Execute command in shielded namespace (SSE stream)',
      gates: 'exec',
      response: 'SSE events: meta, stdout, stderr, exit, error',
      notes: 'cmd: dev|build|test. Secrets injected via stdin. Output redacted. 4hr gate TTL.',
    },

    // ── Deploy ──
    'POST /_auth/workflow/deploy': {
      description: 'Deploy an app (requires deploy gate)',
      gates: 'deploy',
    },

    // ── Git ──
    'POST /_auth/workflow/git-push': {
      description: 'Push to remote (requires git gate)',
      gates: 'git',
    },
  },
  gate_types: ['db_read', 'db_write', 'db_migrate', 'git', 'deploy', 'exec'],
  gate_flow: 'POST /_auth/gates/request → if pending, poll /_auth/gates/request/:id/status → then use gated endpoint',
};

/**
 * Register schema routes on Hono app
 */
export function registerSchemaRoutes(app: Hono): void {
  app.get('/_auth/schema', (c) => {
    return c.json(SCHEMA);
  });
}
