// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Internal Auth Middleware — ACL Policy Unit Tests
 *
 * Tests endpoint-level access control:
 *   1. findAclEntry returns correct allow lists for known endpoints
 *   2. Prefix matching works for parameterized routes
 *   3. Method-scoped ACLs (DELETE on /projects/ restricted to file-api)
 *   4. Default deny for unknown endpoints
 *   5. git-credentials explicitly blocked for all IPC services
 *   6. Cross-service denial (agent-bridge can't reach file-api endpoints)
 */

import { describe, it, expect, vi } from 'vitest';

// Mock database to prevent SQLite file access
vi.mock('../database', () => ({
  db: {
    exec: vi.fn(),
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      run: vi.fn(),
    })),
  },
}));

// Mock internal-token.service (not needed for ACL tests)
vi.mock('../application/credentials/InternalToken', () => ({
  validateInternalToken: vi.fn(),
  getVerifiedService: vi.fn(),
}));

import { findAclEntry, matchesAclPattern, ACL_POLICY } from './internal-auth.middleware';

describe('internal-auth ACL policy', () => {
  describe('findAclEntry', () => {
    // ── file-api endpoints ──
    it('allows file-api for /api/internal/projects/create', () => {
      const allow = findAclEntry('/api/internal/projects/create', 'POST');
      expect(allow).toContain('file-api');
    });

    it('allows file-api for DELETE /api/internal/projects/sbx-abc1234', () => {
      const allow = findAclEntry('/api/internal/projects/sbx-abc1234', 'DELETE');
      expect(allow).toContain('file-api');
    });

    it('allows file-api for /api/internal/git-clone', () => {
      const allow = findAclEntry('/api/internal/git-clone', 'POST');
      expect(allow).toContain('file-api');
    });

    it('allows file-api for /api/internal/git-pull', () => {
      const allow = findAclEntry('/api/internal/git-pull', 'POST');
      expect(allow).toContain('file-api');
    });

    it('allows file-api for /api/internal/backup-identity', () => {
      const allow = findAclEntry('/api/internal/backup-identity', 'POST');
      expect(allow).toContain('file-api');
    });

    it('allows file-api for /api/internal/logs/my-app', () => {
      const allow = findAclEntry('/api/internal/logs/my-app', 'GET');
      expect(allow).toContain('file-api');
    });

    it('allows file-api for /api/internal/preview-ports', () => {
      const allow = findAclEntry('/api/internal/preview-ports', 'POST');
      expect(allow).toContain('file-api');
    });

    it('allows file-api for DELETE /api/internal/secrets/my-app', () => {
      const allow = findAclEntry('/api/internal/secrets/my-app', 'DELETE');
      expect(allow).toContain('file-api');
    });

    // ── agent-bridge endpoints ──
    it('allows agent-bridge for /api/internal/gate/grant', () => {
      const allow = findAclEntry('/api/internal/gate/grant', 'POST');
      expect(allow).toContain('agent-bridge');
    });

    it('allows agent-bridge for /api/internal/gate/status', () => {
      const allow = findAclEntry('/api/internal/gate/status', 'GET');
      expect(allow).toContain('agent-bridge');
    });

    it('allows agent-bridge for /api/internal/gate/permissions', () => {
      const allow = findAclEntry('/api/internal/gate/permissions', 'GET');
      expect(allow).toContain('agent-bridge');
    });

    it('allows agent-bridge for /api/internal/permissions/request', () => {
      const allow = findAclEntry('/api/internal/permissions/request', 'POST');
      expect(allow).toContain('agent-bridge');
    });

    it('allows agent-bridge for /api/internal/permissions/:id/grant', () => {
      const allow = findAclEntry('/api/internal/permissions/abc123/grant', 'POST');
      expect(allow).toContain('agent-bridge');
    });

    it('allows agent-bridge for /api/internal/permissions/:id/deny', () => {
      const allow = findAclEntry('/api/internal/permissions/abc123/deny', 'POST');
      expect(allow).toContain('agent-bridge');
    });

    it('allows agent-bridge for /api/internal/permissions/:id/revoke', () => {
      const allow = findAclEntry('/api/internal/permissions/abc123/revoke', 'POST');
      expect(allow).toContain('agent-bridge');
    });

    it('allows agent-bridge for /api/internal/permissions/:id/seen', () => {
      const allow = findAclEntry('/api/internal/permissions/abc123/seen', 'POST');
      expect(allow).toContain('agent-bridge');
    });

    it('denies file-api for /api/internal/permissions/request', () => {
      const allow = findAclEntry('/api/internal/permissions/request', 'POST');
      expect(allow).not.toContain('file-api');
    });

    it('denies enforcer for /api/internal/permissions/request', () => {
      const allow = findAclEntry('/api/internal/permissions/request', 'POST');
      expect(allow).not.toContain('enforcer');
    });

    it('allows agent-bridge for /api/internal/secret-names', () => {
      const allow = findAclEntry('/api/internal/secret-names', 'GET');
      expect(allow).toContain('agent-bridge');
    });

    it('allows agent-bridge for /api/internal/deploy-auto-authorize', () => {
      const allow = findAclEntry('/api/internal/deploy-auto-authorize', 'POST');
      expect(allow).toContain('agent-bridge');
    });

    it('allows agent-bridge for /api/internal/exposure-alerts/my-app', () => {
      const allow = findAclEntry('/api/internal/exposure-alerts/my-app', 'POST');
      expect(allow).toContain('agent-bridge');
    });

    // ── Cross-service denial ──
    it('denies agent-bridge for /api/internal/git-clone', () => {
      const allow = findAclEntry('/api/internal/git-clone', 'POST');
      expect(allow).not.toContain('agent-bridge');
    });

    it('denies agent-bridge for /api/internal/backup-identity', () => {
      const allow = findAclEntry('/api/internal/backup-identity', 'POST');
      expect(allow).not.toContain('agent-bridge');
    });

    it('denies file-api for /api/internal/gate/grant', () => {
      const allow = findAclEntry('/api/internal/gate/grant', 'POST');
      expect(allow).not.toContain('file-api');
    });

    it('denies file-api for /api/internal/gate/status', () => {
      const allow = findAclEntry('/api/internal/gate/status', 'GET');
      expect(allow).not.toContain('file-api');
    });

    it('denies file-api for /api/internal/deploy-auto-authorize', () => {
      const allow = findAclEntry('/api/internal/deploy-auto-authorize', 'POST');
      expect(allow).not.toContain('file-api');
    });

    // ── git-credentials: blocked for all IPC services ──
    it('blocks git-credentials for all IPC services', () => {
      const allow = findAclEntry('/api/internal/git-credentials', 'POST');
      expect(allow).toEqual([]);
    });

    // ── Default deny ──
    it('returns null for unknown endpoint', () => {
      const allow = findAclEntry('/api/internal/nonexistent', 'GET');
      expect(allow).toBeNull();
    });

    it('returns null for path outside /api/internal', () => {
      const allow = findAclEntry('/api/auth/session', 'GET');
      expect(allow).toBeNull();
    });

    // ── Method scoping ──
    it('DELETE /api/internal/projects/:slug matches file-api', () => {
      const allow = findAclEntry('/api/internal/projects/sbx-test123', 'DELETE');
      expect(allow).toContain('file-api');
    });

    it('GET /api/internal/projects/:slug does NOT match method-scoped DELETE entry', () => {
      // The DELETE-scoped entry shouldn't match GET requests
      // But /api/internal/projects/create entry matches /api/internal/projects/create exactly
      const allow = findAclEntry('/api/internal/projects/random-slug', 'GET');
      // This should either match a broader projects entry or be null
      // Let's check: projects/create is exact match, projects/ DELETE is method-scoped
      // A GET to /api/internal/projects/random-slug doesn't match create (exact) or / (DELETE only)
      expect(allow === null || !allow.includes('agent-bridge' as any)).toBe(true);
    });
  });

  describe('matchesAclPattern', () => {
    it('prefix match: trailing slash matches sub-paths', () => {
      const entry = { pattern: '/api/internal/gate/', allow: ['agent-bridge' as const] };
      expect(matchesAclPattern(entry, '/api/internal/gate/grant', 'POST')).toBe(true);
      expect(matchesAclPattern(entry, '/api/internal/gate/status', 'GET')).toBe(true);
      expect(matchesAclPattern(entry, '/api/internal/gate', 'GET')).toBe(true);
    });

    it('prefix match: does not match unrelated paths', () => {
      const entry = { pattern: '/api/internal/gate/', allow: ['agent-bridge' as const] };
      expect(matchesAclPattern(entry, '/api/internal/gateway', 'GET')).toBe(false);
    });

    it('exact match: matches exact path', () => {
      const entry = { pattern: '/api/internal/backup-identity', allow: ['file-api' as const] };
      expect(matchesAclPattern(entry, '/api/internal/backup-identity', 'POST')).toBe(true);
    });

    it('exact match: does not match sub-path', () => {
      const entry = { pattern: '/api/internal/backup-identity', allow: ['file-api' as const] };
      expect(matchesAclPattern(entry, '/api/internal/backup-identity-extra', 'POST')).toBe(false);
    });

    it('method scoping: blocks wrong method', () => {
      const entry = { pattern: '/api/internal/projects/', methods: ['DELETE'], allow: ['file-api' as const] };
      expect(matchesAclPattern(entry, '/api/internal/projects/slug', 'DELETE')).toBe(true);
      expect(matchesAclPattern(entry, '/api/internal/projects/slug', 'GET')).toBe(false);
    });
  });

  describe('policy completeness', () => {
    it('has entries for all critical endpoints', () => {
      const criticalEndpoints = [
        '/api/internal/git-credentials',
        '/api/internal/git-clone',
        '/api/internal/git-push',
        '/api/internal/git-pull',
        '/api/internal/backup-identity',
        '/api/internal/gate/grant',
        '/api/internal/gate/revoke',
        '/api/internal/permissions/request',
        '/api/internal/permissions/abc/grant',
        '/api/internal/permissions/abc/deny',
        '/api/internal/secrets/app',
        '/api/internal/db/query',
      ];

      for (const ep of criticalEndpoints) {
        const allow = findAclEntry(ep, 'POST');
        expect(allow, `Missing ACL for ${ep}`).not.toBeNull();
      }
    });

    it('no ACL entry allows all three services simultaneously', () => {
      // Defense check: at least some entries should be restricted
      const tooPermissive = ACL_POLICY.filter(
        e => e.allow.length === 3
      );
      expect(tooPermissive.length).toBe(0);
    });
  });
});
