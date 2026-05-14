// SPDX-License-Identifier: MIT

// log a warning so contributors can see which routes need mocking.

import {
  MOCK_MODE,
  mockGitConnections,
  mockIntegrationConnections,
  mockLinkedRepo,
  mockGitLinks,
  mockGitRepos,
  mockDeployConfig,
  mockDeployHistory,
  mockWorkspaceConfig,
  mockWorkspaceTemplates,
  mockDatabaseTables,
  mockDatabaseInfo,
  mockDatabaseList,
  mockQueryResult,
  mockSecretNames,
  mockSecretClassifications,
  mockSecretValues,
  mockIntegrationGroups,
  mockDiscoveredTools,
} from "./mock-data";

// ── Route definition ─────────────────────────────────────────────────────────

interface MockRoute {
  pattern: RegExp;
  method?: string;
  response: unknown | ((url: string, init?: RequestInit) => unknown);
}

const MOCK_ROUTES: MockRoute[] = [
  // ── Integrations ─────────────────────────────────────
  {
    pattern: /\/api\/integrations\/connections\/[^/]+$/,
    method: "DELETE",
    response: { success: true },
  },
  {
    pattern: /\/api\/integrations\/connections/,
    response: mockIntegrationConnections,
  },
  {
    pattern: /\/api\/integrations\/supabase\/[^/]+\/databases/,
    response: { databases: [] },
  },

  // ── Integration Groups ───────────────────────────────
  {
    pattern: /\/api\/servers\/[^/]+\/groups\?/,
    response: mockIntegrationGroups,
  },
  {
    pattern: /\/api\/servers\/[^/]+\/groups$/,
    method: "POST",
    response: { group: { id: "grp-new", name: "New Group" } },
  },
  {
    pattern: /\/api\/servers\/[^/]+\/groups\/[^/]+$/,
    method: "PATCH",
    response: { success: true },
  },
  {
    pattern: /\/api\/servers\/[^/]+\/groups\/[^/]+$/,
    method: "DELETE",
    response: { success: true },
  },
  {
    pattern: /\/api\/servers\/[^/]+\/groups\/[^/]+\/connections$/,
    method: "POST",
    response: { connection: { id: "conn-new" } },
  },
  {
    pattern: /\/api\/servers\/[^/]+\/groups\/[^/]+\/connections\/[^/]+$/,
    method: "DELETE",
    response: { success: true },
  },
  {
    pattern: /\/api\/servers\/[^/]+\/groups\/[^/]+\/connections\/[^/]+\/set-default/,
    method: "POST",
    response: { success: true },
  },
  {
    pattern: /\/api\/servers\/[^/]+\/groups\/[^/]+\/connections\/[^/]+\/enable-agent/,
    method: "POST",
    response: { success: true },
  },
  {
    pattern: /\/api\/servers\/[^/]+\/groups\/[^/]+\/connections\/[^/]+\/disable-agent/,
    method: "POST",
    response: { success: true },
  },
  {
    pattern: /\/api\/servers\/[^/]+\/groups\/[^/]+\/connections\/[^/]+\/discover/,
    method: "POST",
    response: { tools: mockDiscoveredTools },
  },

  // ── Git ──────────────────────────────────────────────
  {
    pattern: /\/api\/git\/connections\/[^/]+$/,
    method: "DELETE",
    response: { success: true },
  },
  {
    pattern: /\/api\/git\/connections/,
    response: mockGitConnections,
  },
  {
    pattern: /\/api\/git\/servers\/[^/]+\/links$/,
    response: mockGitLinks,
  },
  {
    pattern: /\/api\/git\/servers\/[^/]+\/link$/,
    method: "POST",
    response: { success: true, repo: mockLinkedRepo.repo },
  },
  {
    pattern: /\/api\/git\/servers\/[^/]+\/link/,
    response: mockLinkedRepo,
  },
  {
    pattern: /\/api\/git\/servers\/[^/]+\/repos\//,
    response: mockGitRepos,
  },

  // ── Publish / Deploy ─────────────────────────────────
  {
    pattern: /\/api\/publish\/config\/[^/]+\/[^/]+/,
    response: mockDeployConfig,
  },
  {
    pattern: /\/api\/publish\/history\/[^/]+\/[^/]+/,
    response: mockDeployHistory,
  },
  {
    pattern: /\/api\/publish\/[^/]+$/,
    method: "POST",
    response: {
      id: "dep-new",
      status: "building",
      provider: "vercel",
      requestedAt: new Date().toISOString(),
    },
  },

  // ── Workspace ────────────────────────────────────────
  {
    pattern: /\/api\/servers\/[^/]+\/workspace-templates/,
    response: mockWorkspaceTemplates,
  },
  {
    pattern: /\/api\/servers\/[^/]+\/workspace\/[^/]+$/,
    method: "PUT",
    response: { success: true },
  },
  {
    pattern: /\/api\/servers\/[^/]+\/workspace\/[^/]+$/,
    response: mockWorkspaceConfig,
  },

  // ── Server preferences ───────────────────────────────
  {
    pattern: /\/api\/servers\/[^/]+\/preferences/,
    response: { message: "Updated" },
  },

  // ── Terminal token ───────────────────────────────────
  {
    pattern: /\/api\/servers\/[^/]+\/terminal\/token/,
    method: "POST",
    response: { token: "mock-terminal-token" },
  },
  {
    pattern: /\/api\/servers\/[^/]+\/terminal$/,
    response: {
      terminal: {
        terminalEnabled: true,
        sshEnabled: false,
        hasSshKey: false,
        lastSyncAt: new Date().toISOString(),
        isSovereign: false,
      },
    },
  },

  // ── Server config & status ───────────────────────────
  {
    pattern: /\/api\/servers\/status$/,
    response: () => {
      // Dynamic import would create a circular dep; inline the essentials
      return {
        state: "running",
        plan: "pro",
        hasActiveSubscription: true,
        server: {
          id: "mock-server-1",
          ipAddress: "10.0.0.1",
          domain: "mock-srv.ellul.ai",
          createdAt: new Date(Date.now() - 7 * 86400000).toISOString(),
          performanceStatus: "good",
          size: "s-2vcpu-4gb",
          terminalEnabled: true,
          sshEnabled: true,
          preferredSession: "opencode",
          securityTier: "standard",
          serverPlan: "pro",
          product: "cloud_platform",
        },
        deployments: [],
        aiQuota: { used: 150, limit: 1000, remaining: 850, percentUsed: 15 },
      };
    },
  },
  {
    pattern: /\/api\/servers\/[^/]+\/config$/,
    response: { config: {} },
  },
  {
    pattern: /\/api\/servers\/[^/]+\/agents\/auth-status/,
    response: { authenticated: false },
  },
  {
    pattern: /\/api\/servers\/certificate-quota/,
    response: { used: 0, limit: 10 },
  },
  {
    pattern: /\/api\/servers\/[^/]+\/deployment$/,
    response: { model: "proxied" },
  },
  {
    pattern: /\/api\/servers\/[^/]+\/tier-options/,
    response: { options: [] },
  },

  // ── Stripe ──────────────────────────────────────────
  {
    pattern: /\/api\/stripe\/checkout/,
    method: "POST",
    response: { url: "#mock-checkout" },
  },
  {
    pattern: /\/api\/stripe\/portal/,
    method: "POST",
    response: { url: "#mock-portal" },
  },
  {
    pattern: /\/api\/stripe\/preview-change/,
    method: "POST",
    response: { preview: null },
  },

  // ── Push notifications ───────────────────────────────
  {
    pattern: /\/api\/push\/register/,
    method: "POST",
    response: { success: true },
  },
  {
    pattern: /\/api\/push\/tokens/,
    response: { tokens: [] },
  },
  {
    pattern: /\/api\/push\/preferences/,
    response: { preferences: {} },
  },

  // ── Public key (for secrets encryption) ──────────────
  {
    pattern: /\/api\/servers\/[^/]+\/public-key/,
    response: {
      publicKey: "mock-public-key-base64",
    },
  },

  // ══════════════════════════════════════════════════════
  // VPS-direct routes (/_auth/* - standard tier)
  // ══════════════════════════════════════════════════════

  // ── Database (direct) ────────────────────────────────
  {
    pattern: /\/_auth\/db\/status/,
    response: { available: true, version: "PostgreSQL 16.2" },
  },
  {
    pattern: /\/_auth\/db\/info/,
    response: mockDatabaseInfo,
  },
  {
    pattern: /\/_auth\/db\/list/,
    response: { databases: mockDatabaseList },
  },
  {
    pattern: /\/_auth\/db\/schema/,
    response: { tables: mockDatabaseTables },
  },
  {
    pattern: /\/_auth\/db\/query/,
    method: "POST",
    response: mockQueryResult,
  },
  {
    pattern: /\/_auth\/db\/execute/,
    method: "POST",
    response: { success: true, rowCount: 1, rows: [], command: "UPDATE" },
  },
  {
    pattern: /\/_auth\/db\/provision/,
    method: "POST",
    response: { success: true, database: "app_my_app" },
  },
  {
    pattern: /\/_auth\/db\/delete/,
    method: "POST",
    response: { success: true },
  },
  {
    pattern: /\/_auth\/db\/create/,
    method: "POST",
    response: { success: true },
  },
  {
    pattern: /\/_auth\/db\/drop/,
    method: "POST",
    response: { success: true },
  },
  {
    pattern: /\/_auth\/db\/assign/,
    method: "POST",
    response: { success: true },
  },
  {
    pattern: /\/_auth\/db\/backups/,
    response: { backups: [{ file: "backup-2025-03-15.sql.gz", sizeBytes: 524288 }] },
  },
  {
    pattern: /\/_auth\/db\/backup$/,
    method: "POST",
    response: { success: true, file: "backup-2025-04-07.sql.gz" },
  },
  {
    pattern: /\/_auth\/db\/restore/,
    method: "POST",
    response: { success: true },
  },

  // ── Secrets (direct) ─────────────────────────────────
  {
    pattern: /\/_auth\/secrets\/values/,
    response: { values: mockSecretValues },
  },
  {
    pattern: /\/_auth\/secrets\/bulk/,
    method: "POST",
    response: { success: true },
  },
  {
    pattern: /\/_auth\/secrets\/[^/?]+/,
    method: "DELETE",
    response: { success: true },
  },
  {
    pattern: /\/_auth\/secrets$/,
    method: "POST",
    response: { success: true },
  },
  {
    pattern: /\/_auth\/secrets/,
    response: {
      names: mockSecretNames,
      classifications: mockSecretClassifications,
    },
  },

  // ── SSH Keys (direct) ────────────────────────────────
  {
    pattern: /\/_auth\/(api\/)?keys/,
    response: { keys: [] },
  },

  // ── Audit log (direct) ───────────────────────────────
  {
    pattern: /\/_auth\/audit\/verify/,
    response: { valid: true },
  },
  {
    pattern: /\/_auth\/audit/,
    response: { entries: [] },
  },

  // ── Cross-project access (direct) ────────────────────
  {
    pattern: /\/_auth\/cross-project-access/,
    method: "POST",
    response: { success: true },
  },
  {
    pattern: /\/_auth\/cross-project-access/,
    response: { grants: [] },
  },

  // ── Bridge session & watchdog (direct) ────────────────
  {
    pattern: /\/_auth\/bridge\/session/,
    response: { authenticated: true },
  },
  {
    pattern: /\/_auth\/bridge\/watchdog\/health/,
    response: { healthy: true, agents: [] },
  },
  {
    pattern: /\/_auth\/bridge\/agents\/auth-status/,
    response: { authenticated: false },
  },
  {
    pattern: /\/_auth\/bridge\/restart-services/,
    method: "POST",
    response: { success: true },
  },
];

// ── Interceptor setup ────────────────────────────────────────────────────────

let installed = false;

export function setupMockFetch(): void {
  if (!MOCK_MODE || installed) return;
  installed = true;

  const realFetch = globalThis.fetch;

  globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method?.toUpperCase() || "GET";

    // Only intercept API and VPS-direct calls (not static assets, HMR, etc.)
    if (!url.includes("/api/") && !url.includes("/_auth/")) {
      return realFetch(input, init);
    }

    for (const route of MOCK_ROUTES) {
      if (
        route.pattern.test(url) &&
        (!route.method || route.method === method)
      ) {
        const body =
          typeof route.response === "function"
            ? route.response(url, init)
            : route.response;

        // Simulate realistic network latency
        await new Promise((resolve) =>
          setTimeout(resolve, 80 + Math.random() * 120),
        );

        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Unmatched write operations - return generic success
    if (["PUT", "POST", "PATCH", "DELETE"].includes(method)) {
      await new Promise((resolve) =>
        setTimeout(resolve, 80 + Math.random() * 120),
      );
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Unmatched GET - log and return empty
    console.warn(`[mock-mode] Unmatched route: ${method} ${url}`);
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}
