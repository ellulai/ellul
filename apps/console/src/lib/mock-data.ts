// SPDX-License-Identifier: MIT

import type { ServerStatus } from "@/contexts/DashboardContext";
import type { ApiSandbox } from "@/contexts/AppsListContext";
import type { Session } from "@/lib/auth-client";

export const MOCK_MODE = process.env.NEXT_PUBLIC_MOCK_MODE === "true";

// ── Auth & Session ───────────────────────────────────────────────────────────

export const mockSession: Session = {
  user: {
    id: "mock-user-1",
    email: "contributor@ellul.ai",
    name: "Demo User",
    image: null,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  session: {
    id: "mock-session-1",
    userId: "mock-user-1",
    expiresAt: new Date(Date.now() + 86400000),
    token: "mock-token",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
};

// ── Server Status ────────────────────────────────────────────────────────────

export const mockServerStatus: ServerStatus = {
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
  deployments: [
    {
      name: "my-app",
      url: "https://mock-dev.ellul.app",
      port: 3000,
      stack: "Next.js",
      summary: "Frontend app",
      createdAt: new Date().toISOString(),
    },
  ],
  aiQuota: {
    used: 150,
    limit: 1000,
    remaining: 850,
    percentUsed: 15,
    resetsIn: "29 days",
    resetAt: new Date(Date.now() + 29 * 86400000).toISOString(),
  },
};

// ── Apps ──────────────────────────────────────────────────────────────────────

export const mockSandboxes: ApiSandbox[] = [
  {
    id: "sbx-mock001",
    displayName: "Mock Sandbox",
    path: "/home/coder/projects/sbx-mock001",
    pinned: false,
    createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    activeApp: "my-app",
    apps: [
      {
        directory: "sbx-mock001/my-app",
        sandboxId: "sbx-mock001",
        subdir: "my-app",
        name: "my-app",
        path: "/home/coder/projects/sbx-mock001/my-app",
        framework: "next",
        type: "frontend",
        previewable: true,
        port: 3000,
        scripts: ["dev", "build", "start"],
        hasPackageJson: true,
        isMonorepo: false,
        workspacePackages: [],
        projectId: null,
      },
      {
        directory: "sbx-mock001/api-server",
        sandboxId: "sbx-mock001",
        subdir: "api-server",
        name: "api-server",
        path: "/home/coder/projects/sbx-mock001/api-server",
        framework: "express",
        type: "backend",
        previewable: false,
        port: 3001,
        scripts: ["dev", "start"],
        hasPackageJson: true,
        isMonorepo: false,
        workspacePackages: [],
        projectId: null,
      },
    ],
  },
];

// ── Preview ──────────────────────────────────────────────────────────────────

import type { PreviewStatus } from "@/hooks/useCurrentApp";

export const mockPreview: PreviewStatus = {
  active: true,
  app: "my-app",
  activated: true,
  port: 3000,
  phase: "ready",
};

// ── Git Connections ──────────────────────────────────────────────────────────

export const mockGitConnections = {
  connections: [
    {
      id: "gc-1",
      provider: "github",
      providerUsername: "demo-user",
      providerAvatarUrl: null,
      scope: "repo",
      connectedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    },
  ],
  availableProviders: ["github", "gitlab", "bitbucket"],
};

// ── Integration Connections (deploy + data providers) ────────────────────────

export const mockIntegrationConnections = {
  connections: [
    {
      id: "ic-1",
      provider: "vercel",
      providerUsername: "demo-team",
      providerAvatarUrl: null,
      providerAccountId: "team_demo",
      connectedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    },
  ],
  availableProviders: ["vercel", "cloudflare-workers", "supabase"],
};

// ── Linked Repos ─────────────────────────────────────────────────────────────

export const mockLinkedRepo = {
  linked: true,
  repo: {
    id: "repo-1",
    provider: "github",
    repoFullName: "demo-user/my-app",
    repoUrl: "https://github.com/demo-user/my-app",
    defaultBranch: "main",
    isPrivate: false,
    credentialsSynced: true,
    linkedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    lastPushAt: new Date(Date.now() - 3600000).toISOString(),
  },
};

// All linked repos by app name (for OverviewPage /api/git/servers/:id/links)
export const mockGitLinks = {
  repos: {
    "my-app": {
      provider: "github",
      repoFullName: "demo-user/my-app",
      repoUrl: "https://github.com/demo-user/my-app",
      defaultBranch: "main",
      isPrivate: false,
      linkedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      lastPushAt: new Date(Date.now() - 3600000).toISOString(),
    },
  },
};

// ── Git Repos (repo picker) ──────────────────────────────────────────────────

export const mockGitRepos = {
  repos: [
    {
      name: "my-app",
      fullName: "demo-user/my-app",
      url: "https://github.com/demo-user/my-app",
      sshUrl: "git@github.com:demo-user/my-app.git",
      isPrivate: false,
      defaultBranch: "main",
      description: "A Next.js starter application",
      updatedAt: new Date(Date.now() - 86400000).toISOString(),
    },
    {
      name: "landing-page",
      fullName: "demo-user/landing-page",
      url: "https://github.com/demo-user/landing-page",
      sshUrl: "git@github.com:demo-user/landing-page.git",
      isPrivate: false,
      defaultBranch: "main",
      description: "Marketing landing page",
      updatedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    },
    {
      name: "private-api",
      fullName: "demo-user/private-api",
      url: "https://github.com/demo-user/private-api",
      sshUrl: "git@github.com:demo-user/private-api.git",
      isPrivate: true,
      defaultBranch: "main",
      description: "Internal API server",
      updatedAt: new Date(Date.now() - 5 * 86400000).toISOString(),
    },
  ],
};

// ── Deploy Config & History ──────────────────────────────────────────────────

export const mockDeployConfig = {
  provider: "vercel",
  connectionId: "ic-1",
  providerProjectId: "prj_demo123",
  branch: "main",
  framework: "nextjs",
};

export const mockDeployHistory = {
  records: [
    {
      id: "dep-1",
      status: "ready" as const,
      provider: "vercel",
      url: "https://my-app-demo.vercel.app",
      providerDashboardUrl: "https://vercel.com/demo-team/my-app",
      errorMessage: null,
      requestedAt: new Date(Date.now() - 3600000).toISOString(),
      readyAt: new Date(Date.now() - 3500000).toISOString(),
      gitRef: "main",
      commitSha: "a1b2c3d4",
    },
    {
      id: "dep-2",
      status: "error" as const,
      provider: "vercel",
      url: null,
      providerDashboardUrl: null,
      errorMessage: "Build failed: missing dependency 'sharp'",
      requestedAt: new Date(Date.now() - 86400000).toISOString(),
      readyAt: null,
      gitRef: "feature/images",
      commitSha: "e5f6a7b8",
    },
  ],
};

// ── Workspace Config ─────────────────────────────────────────────────────────

export const mockWorkspaceConfig = { config: null };
export const mockWorkspaceTemplates = { templates: [] };

// ── Database ─────────────────────────────────────────────────────────────────

export const mockDatabaseTables = [
  {
    name: "users",
    columns: [
      { name: "id", type: "serial", nullable: false, default: null },
      { name: "email", type: "varchar(255)", nullable: false, default: null },
      { name: "name", type: "varchar(100)", nullable: true, default: null },
      { name: "created_at", type: "timestamptz", nullable: false, default: "now()" },
    ],
    rowCount: 42,
  },
  {
    name: "posts",
    columns: [
      { name: "id", type: "serial", nullable: false, default: null },
      { name: "user_id", type: "integer", nullable: false, default: null },
      { name: "title", type: "varchar(255)", nullable: false, default: null },
      { name: "body", type: "text", nullable: true, default: null },
      { name: "published", type: "boolean", nullable: false, default: "false" },
      { name: "created_at", type: "timestamptz", nullable: false, default: "now()" },
    ],
    rowCount: 128,
  },
  {
    name: "comments",
    columns: [
      { name: "id", type: "serial", nullable: false, default: null },
      { name: "post_id", type: "integer", nullable: false, default: null },
      { name: "author", type: "varchar(100)", nullable: false, default: null },
      { name: "body", type: "text", nullable: false, default: null },
      { name: "created_at", type: "timestamptz", nullable: false, default: "now()" },
    ],
    rowCount: 356,
  },
];

export const mockQueryResult = {
  rows: [
    { id: "1", email: "alice@example.com", name: "Alice", created_at: "2025-01-15T10:30:00Z" },
    { id: "2", email: "bob@example.com", name: "Bob", created_at: "2025-02-20T14:15:00Z" },
    { id: "3", email: "charlie@example.com", name: "Charlie", created_at: "2025-03-10T09:45:00Z" },
  ],
  rowCount: 3,
  command: "SELECT",
};

export const mockDatabaseInfo = {
  database: "app_my_app",
  ownerRole: "shield_my_app_owner",
  appRole: "shield_my_app_app",
  readonlyRole: "shield_my_app_readonly",
  exists: true,
  sizeBytes: 1048576,
};

export const mockDatabaseList = [
  {
    label: "my-app",
    dbName: "app_my_app",
    sizeBytes: 1048576,
    createdAt: Date.now() - 5 * 86400000,
    isPreview: false,
    isDeployed: false,
  },
];

// ── Secrets ──────────────────────────────────────────────────────────────────

export const mockSecretNames = ["DATABASE_URL", "OPENAI_API_KEY", "STRIPE_SECRET_KEY", "NEXT_PUBLIC_APP_URL"];

export const mockSecretClassifications: Record<string, "secret" | "plain"> = {
  DATABASE_URL: "secret",
  OPENAI_API_KEY: "secret",
  STRIPE_SECRET_KEY: "secret",
  NEXT_PUBLIC_APP_URL: "plain",
};

export const mockSecretValues: Record<string, string> = {
  DATABASE_URL: "postgresql://shield_my_app_app:****@localhost:5432/app_my_app",
  OPENAI_API_KEY: "sk-mock-xxxxxxxxxxxxxxxxxxxx",
  STRIPE_SECRET_KEY: "sk_test_mock_xxxxxxxxxxxxxxxxxxxx",
  NEXT_PUBLIC_APP_URL: "https://mock-dev.ellul.app",
};

// ── Integration Groups ──────────────────────────────────────────────────────

export const mockIntegrationGroups = {
  groups: [
    {
      id: "grp-database",
      name: "Database",
      iconKey: "database",
      routeRole: "db-default",
      position: 0,
      isSystemDefined: false,
      connections: [
        {
          id: "conn-neon",
          providerKind: "neon",
          adapterType: "mcp",
          displayName: "Neon Production",
          agentExposure: "enabled",
          isDefaultRoute: true,
          connectionStatus: "connected",
          mcpUrl: "https://mcp.neon.tech",
          lastHealthCheck: new Date(Date.now() - 120000).toISOString(),
          lastDiscoveryAt: new Date(Date.now() - 120000).toISOString(),
          lastSuccessfulDiscoveryAt: new Date(Date.now() - 120000).toISOString(),
        },
        {
          id: "conn-supabase",
          providerKind: "supabase",
          adapterType: "oauth",
          displayName: "Supabase Staging",
          agentExposure: "enabled",
          isDefaultRoute: false,
          connectionStatus: "connected",
          oauthProvider: "supabase",
        },
      ],
    },
    {
      id: "grp-deploy",
      name: "Deploy",
      iconKey: "rocket",
      routeRole: "deploy-default",
      position: 1,
      isSystemDefined: false,
      connections: [
        {
          id: "conn-vercel",
          providerKind: "vercel",
          adapterType: "oauth",
          displayName: "Vercel Team",
          agentExposure: "enabled",
          isDefaultRoute: true,
          connectionStatus: "connected",
          oauthProvider: "vercel",
        },
      ],
    },
    {
      id: "grp-git",
      name: "Source Control",
      iconKey: "git-branch",
      routeRole: "git-default",
      position: 2,
      isSystemDefined: false,
      connections: [
        {
          id: "conn-github",
          providerKind: "github",
          adapterType: "oauth",
          displayName: "demo-user",
          agentExposure: "enabled",
          isDefaultRoute: true,
          connectionStatus: "connected",
          oauthProvider: "github",
        },
      ],
    },
    {
      id: "grp-payments",
      name: "Payments",
      iconKey: "key",
      routeRole: null,
      position: 3,
      isSystemDefined: false,
      connections: [
        {
          id: "conn-stripe",
          providerKind: "stripe",
          adapterType: "mcp",
          displayName: "Stripe API",
          agentExposure: "enabled",
          isDefaultRoute: false,
          connectionStatus: "connected",
          mcpUrl: "https://mcp.stripe.dev",
        },
      ],
    },
  ],
};

// Mock discovered tools for the Neon MCP connection
export const mockDiscoveredTools = [
  {
    id: "tool-1",
    toolName: "query",
    description: "Execute SQL queries",
    systemCapability: "database:read",
    confidence: "high",
    classificationReason: "SQL and query keywords with read-only semantics",
    approvalStatus: "approved",
    callCount: 12,
    lastUsedAt: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    id: "tool-2",
    toolName: "insert",
    description: "Insert records into tables",
    systemCapability: "database:write",
    confidence: "high",
    classificationReason: "Insert keyword indicates write operation",
    approvalStatus: "approved",
    callCount: 3,
  },
  {
    id: "tool-3",
    toolName: "admin_exec",
    description: "Execute administrative commands",
    systemCapability: "external:admin",
    confidence: "low",
    classificationReason: "No clear classification - admin keyword ambiguous",
    approvalStatus: "quarantined",
    callCount: 0,
  },
  {
    id: "tool-4",
    toolName: "drop_all",
    description: "Drop all tables in the database",
    systemCapability: "database:schema",
    confidence: "high",
    classificationReason: "Drop keyword indicates schema-level destructive operation",
    approvalStatus: "rejected",
    callCount: 0,
  },
];

// ── VPS Bridge Responses ─────────────────────────────────────────────────────

export const mockVpsBridgeResponses: Record<string, unknown> = {
  // Settings & access
  get_settings: {
    desktopViewMode: "focus",
    uiMode: "pro",
    terminalEnabled: true,
    sshEnabled: false,
  },
  get_preview_token: {
    token: "mock-preview-token",
    expiresAt: new Date(Date.now() + 300000).toISOString(),
  },

  // Database
  db_status: { available: true, version: "PostgreSQL 16.2" },
  db_info: mockDatabaseInfo,
  db_list: { databases: mockDatabaseList },
  db_schema: { tables: mockDatabaseTables },
  db_query: mockQueryResult,
  db_execute: { success: true, rowCount: 1 },
  db_create: { success: true },
  db_drop: { success: true },
  db_assign: { success: true },
  db_provision: { success: true, database: "app_my_app" },
  db_delete: { success: true },
  db_backups: { backups: [{ file: "backup-2025-03-15.sql.gz", sizeBytes: 524288 }] },
  db_backup: { success: true, file: "backup-2025-04-07.sql.gz" },
  db_restore: { success: true },

  // Secrets
  list_secrets: { names: mockSecretNames, classifications: mockSecretClassifications },
  read_secret_values: { values: mockSecretValues },
  set_secret: { success: true },
  delete_secret: { success: true },
  secrets_exposures: { exposures: [] },

  // Git (bridge-based operations)
  authorize_git_link: { authorized: true, token: "mock-confirm-token" },

  // Audit log
  audit_log: { entries: [] },
  audit_verify: { valid: true },

  // Cross-project
  cross_project_access: { grants: [] },

  // Watchdog / agents
  watchdog_health: { healthy: true, agents: [] },
  agents_auth_status: { authenticated: false },
};
