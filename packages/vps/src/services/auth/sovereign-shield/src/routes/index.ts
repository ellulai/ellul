// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Routes Module Index
 *
 * Sovereign Shield handles 58 endpoints organized into these route modules:
 *
 * - health.routes.ts      - /health
 * - capabilities.routes.ts - /_auth/capabilities (version & feature discovery)
 * - session.routes.ts     - Forward auth & session management
 * - token.routes.ts       - Token authorization for services
 * - audit.routes.ts       - Audit log access & integrity verification
 * - tier.routes.ts        - Security tier management
 * - keys.routes.ts        - SSH key management
 * - login.routes.ts       - Passkey login
 * - setup.routes.ts       - Initial setup & registration
 * - bridge.routes.ts      - Platform bridge API
 * - recovery.routes.ts    - Recovery system
 * - confirm.routes.ts     - Operation confirmation
 * - upgrade.routes.ts     - Tier upgrades via JWT (Standard tier)
 * - secrets.routes.ts     - Encrypted environment secrets management
 * - static.routes.ts      - Static assets
 * - workflow.routes.ts    - Privileged workflow commands (expose, etc.)
 * - internal.routes.ts    - Internal API (secrets cleanup, backup-identity)
 * - exec.routes.ts        - Sovereign sandbox (sync, patch, run in shielded namespace)
 * - guardrail.routes.ts   - Guardrail policy discovery + agent proposals
 * - vault.routes.ts       - Scoped Knowledge Vault (browser: /_auth/vault/*)
 * - vault-internal.routes.ts - Vault IPC (agent: /api/internal/vault/*)
 */

import type { Hono } from 'hono';
import { registerHealthRoutes } from './health.routes';
import { registerCapabilitiesRoutes } from './capabilities.routes';
import { registerSessionRoutes } from './session.routes';
import { registerTokenRoutes } from './token.routes';
import { registerAuditRoutes } from './audit.routes';
import { registerTierRoutes } from './tier.routes';
import { registerKeysRoutes } from './keys.routes';
import { registerLoginRoutes } from './login.routes';
import { registerSetupRoutes } from './setup.routes';
import { registerBridgeRoutes } from './bridge.routes';
import { registerRecoveryRoutes } from './recovery.routes';
import { registerConfirmRoutes } from './confirm.routes';
import { registerUpgradeRoutes } from './upgrade.routes';
import { registerStaticRoutes } from './static.routes';
import { registerGitRoutes } from './git.routes';
import { registerWorkflowRoutes } from './workflow.routes';
import { registerPreviewRoutes } from './preview.routes';
import { registerSecretsRoutes } from './secrets.routes';
import { registerDatabaseRoutes } from './database.routes';
import { registerChatRoutes } from './chat.routes';
import { registerInternalRoutes } from './internal.routes';
import { registerSovereignProxyRoutes } from './sovereign-proxy.routes';
import { registerProjectsRoutes, startOrphanReaper } from './projects.routes';
import { registerGateApiRoutes } from './gate-api.routes';
import { registerContextRoutes } from './context.routes';
import { registerToolPermissionRoutes } from './tool-permission.routes';
import { registerPermissionsRoutes } from './permissions.routes';
import { registerSchemaRoutes } from './schema.routes';
import { registerExecRoutes } from './exec.routes';
import { registerGuardrailRoutes } from './guardrail.routes';
import { registerStsRoutes } from './sts.routes';
import { registerDeviceRoutes } from './device.routes';
import { registerPromotionRoutes } from './promotion.routes';
import { registerDowngradeRoutes } from './downgrade.routes';
import { registerMigrationRoutes } from './migration.routes';
import { registerVaultRoutes } from './vault.routes';
import { registerVaultInternalRoutes } from './vault-internal.routes';
import {
  registerClaudeOatRoutes,
  type ClaudeOatModule,
} from '../credentials/claude-oat/public';
import { requireInternalTokenMiddleware } from '../middleware/internal-auth.middleware';
import { tierGateMiddleware } from '../middleware/tier-gate.middleware';
import { productGateMiddleware } from '../middleware/product-gate.middleware';
import { originAllowlistMiddleware } from '../middleware/origin-allowlist.middleware';
// org-mode imports available for future use (proxy is on dedicated port 3006)

export interface RouteConfig {
  hostname: string;
  rpName: string;
  /** Composition-root for the Claude OAT credential bounded context. */
  claudeOat: ClaudeOatModule;
}

/**
 * Register all routes on the Hono app
 */
export function registerAllRoutes(app: Hono, config: RouteConfig): void {
  // NOTE: /proxy/* routes are handled by a dedicated HTTPS server on port 3006
  // (separate from Hono) for zero-buffered SSE streaming. See main.ts.

  // ── Phase 1: Tier Gate — require auth on ALL endpoints (exempt: login, bridge, static, health) ──
  // web_locked: passkey session required. standard: JWT required. No anonymous access.
  app.use('*', tierGateMiddleware);

  // ── Phase 1.5: Product Gate — feature access control based on product type ──
  // Reads /etc/ellul/product + /etc/ellul/billing-tier at boot.
  // Sets c.get('product') + c.get('billingTier'). Enforces feature gates by product.
  app.use('*', productGateMiddleware);

  // ── Phase 1.6: Origin Allowlist — advisory CSRF defense-in-depth ──
  // Rejects Origin headers that aren't in the platform trust set (custom-domain,
  // dev-preview, *.ellul.app, *.ellul.ai). Absent Origin (SSR, navigation,
  // localhost IPC) passes through. Auth remains enforced by tier-gate above.
  app.use('*', originAllowlistMiddleware);

  // ── Phase 2: Internal endpoint authentication ──
  // All /api/internal/* endpoints require a valid internal service token.
  // Token is generated fresh on each shield start, written to /run/shield/internal.token.
  // Only services in the shield-ipc group (file-api, agent-bridge, enforcer) can read it.
  // Agent ($SVC_USER) gets 401 on every internal endpoint call.
  app.use('/api/internal/*', requireInternalTokenMiddleware);
  // Also protect /_internal/* endpoints (validate-infra-token, git-setup)
  app.use('/_internal/*', requireInternalTokenMiddleware);

  // Health check (no auth required)
  registerHealthRoutes(app);

  // Capabilities discovery (no auth required)
  registerCapabilitiesRoutes(app);

  // Session management (forward auth, PoP binding)
  registerSessionRoutes(app, config.hostname);

  // Token authorization (terminal, code, agent)
  registerTokenRoutes(app);

  // CLI device trust (challenge-response auth)
  registerDeviceRoutes(app);

  // Audit log access
  registerAuditRoutes(app);

  // Security tier management
  registerTierRoutes(app);

  // SSH key management
  registerKeysRoutes(app, config.hostname);

  // Passkey login
  registerLoginRoutes(app, config.hostname);

  // Initial setup & registration
  registerSetupRoutes(app, config.hostname);

  // Platform bridge API
  registerBridgeRoutes(app, config.hostname);

  // Recovery system
  registerRecoveryRoutes(app, config.hostname);

  // Operation confirmation
  registerConfirmRoutes(app);

  // Tier upgrades via JWT (Standard tier users)
  registerUpgradeRoutes(app, config.hostname);

  // Secrets management (encrypted env vars)
  registerSecretsRoutes(app);

  // Database management
  registerDatabaseRoutes(app);

  // Git link/unlink authorization
  registerGitRoutes(app);

  // Privileged workflow commands (expose, etc.)
  registerWorkflowRoutes(app);

  // Preview auth (cross-site dev domain token flow)
  registerPreviewRoutes(app, config.hostname);

  // Chat SPA (VPS-served iframe for SSH-equivalent security)
  registerChatRoutes(app);

  // Sovereign Database Proxy (shared DBs, query tagging, idempotency, agent views)
  registerSovereignProxyRoutes(app);

  // Projects (VS Code extension project binding)
  registerProjectsRoutes(app);

  // Sweep partial-create / partial-delete sandbox dirs that left an
  // entitlement slot occupied without a real sandbox attached. Sandboxes
  // without ellul.json older than 5 min get reaped on a 60s cycle.
  // Idempotent — safe to call across reload.
  startOrphanReaper();

  // STS (project-scoped token issuance + refresh)
  registerStsRoutes(app);

  // Gate API (SSE-based gate management for VS Code extension)
  registerGateApiRoutes(app);

  // Context-mode API (console-direct per-project prompt-layer switching)
  registerContextRoutes(app);

  // Per-tool permission overrides (console-direct, operator-signed)
  registerToolPermissionRoutes(app);

  // Permissions API (enterprise-grade HITL: inbox, SSE, history)
  registerPermissionsRoutes(app);

  // Exec API (sovereign sandbox: sync, patch, run)
  registerExecRoutes(app);

  // Guardrail API (policy discovery + agent proposals)
  registerGuardrailRoutes(app);

  // Promotion API (local → VPS state promotion)
  registerPromotionRoutes(app);

  // Downgrade API (VPS → local state repatriation)
  registerDowngradeRoutes(app);

  // Migration bridge (passkey re-enrollment during local↔cloud migration)
  registerMigrationRoutes(app, config.hostname);

  // Vault API (Scoped Knowledge Vault — Obsidian-like knowledge layer)
  registerVaultRoutes(app);

  // Vault Internal API (agent-bridge IPC for scoped vault access)
  registerVaultInternalRoutes(app);

  // Claude OAT credential subsystem — owns the Claude OAuth Access Token
  // canonically. Bridge talks to these routes via per-service IPC token;
  // launcher inherits bridge's group and calls /redeem to exchange a
  // single-use issuance token for the actual OAT before execve into claude.
  registerClaudeOatRoutes(app, config.claudeOat);

  // API Schema (agent discovery)
  registerSchemaRoutes(app);

  // Internal API (Phase 3: delegated operations from file-api)
  registerInternalRoutes(app, config.hostname);

  // Static assets
  registerStaticRoutes(app);
}

export {
  registerHealthRoutes,
  registerCapabilitiesRoutes,
  registerSessionRoutes,
  registerTokenRoutes,
  registerDeviceRoutes,
  registerAuditRoutes,
  registerTierRoutes,
  registerKeysRoutes,
  registerLoginRoutes,
  registerSetupRoutes,
  registerBridgeRoutes,
  registerRecoveryRoutes,
  registerConfirmRoutes,
  registerUpgradeRoutes,
  registerStaticRoutes,
  registerGitRoutes,
  registerWorkflowRoutes,
  registerPreviewRoutes,
  registerSecretsRoutes,
  registerDatabaseRoutes,
  registerChatRoutes,
  registerInternalRoutes,
  registerSovereignProxyRoutes,
  registerProjectsRoutes,
  startOrphanReaper,
  registerGateApiRoutes,
  registerStsRoutes,
  registerExecRoutes,
  registerGuardrailRoutes,
  registerSchemaRoutes,
  registerVaultRoutes,
  registerVaultInternalRoutes,
  registerClaudeOatRoutes,
};
