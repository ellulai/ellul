// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";

// ─── Role compatibility (mirrors CreateGroupModal ROUTE_ROLE_OPTIONS) ────────

const ROLE_COMPATIBLE_PROVIDERS: Record<string, string[]> = {
  "db-default": ["supabase", "neon", "planetscale", "turso", "custom"],
  "deploy-default": ["vercel", "custom"],
  "cloudflare-default": ["cloudflare_workers", "custom"],
  "payments-default": ["stripe", "custom"],
  "git-default": ["github", "gitlab", "bitbucket"],
};

function isCompatible(role: string, providerKind: string): boolean {
  const compatible = ROLE_COMPATIBLE_PROVIDERS[role];
  return compatible ? compatible.includes(providerKind) : false;
}

// ─── Resolved group state helpers ────────────────────────────────────────────

interface MockConnection {
  id: string;
  providerKind: string;
  agentExposure: "enabled" | "disabled";
  isDefaultRoute: boolean;
  connectionStatus: string;
}

interface MockGroup {
  id: string;
  name: string;
  routeRole: string | null;
  connections: MockConnection[];
}

type RouteStatus = "valid" | "missing_default" | "unhealthy" | "no_role";

function resolveRouteStatus(group: MockGroup): RouteStatus {
  if (!group.routeRole) return "no_role";
  const defaultConn = group.connections.find((c) => c.isDefaultRoute);
  if (!defaultConn) return "missing_default";
  if (defaultConn.connectionStatus !== "connected") return "unhealthy";
  return "valid";
}

function getDefaultConnection(group: MockGroup): MockConnection | undefined {
  return group.connections.find((c) => c.isDefaultRoute);
}

function getAgentVisibleConnections(group: MockGroup): MockConnection[] {
  return group.connections.filter((c) => c.agentExposure === "enabled");
}

function hasMultipleDefaults(group: MockGroup): boolean {
  return group.connections.filter((c) => c.isDefaultRoute).length > 1;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Role Compatibility", () => {
  it("neon is compatible with db-default", () => {
    expect(isCompatible("db-default", "neon")).toBe(true);
  });

  it("supabase is compatible with db-default", () => {
    expect(isCompatible("db-default", "supabase")).toBe(true);
  });

  it("vercel is NOT compatible with db-default", () => {
    expect(isCompatible("db-default", "vercel")).toBe(false);
  });

  it("github is compatible with git-default", () => {
    expect(isCompatible("git-default", "github")).toBe(true);
  });

  it("gitlab is compatible with git-default", () => {
    expect(isCompatible("git-default", "gitlab")).toBe(true);
  });

  it("stripe is NOT compatible with any system role", () => {
    expect(isCompatible("db-default", "stripe")).toBe(false);
    expect(isCompatible("deploy-default", "stripe")).toBe(false);
    expect(isCompatible("git-default", "stripe")).toBe(false);
  });

  it("custom is compatible with db-default and deploy-default", () => {
    expect(isCompatible("db-default", "custom")).toBe(true);
    expect(isCompatible("deploy-default", "custom")).toBe(true);
  });

  it("custom is NOT compatible with git-default", () => {
    expect(isCompatible("git-default", "custom")).toBe(false);
  });

  it("unknown role returns false for any provider", () => {
    expect(isCompatible("unknown-role", "neon")).toBe(false);
    expect(isCompatible("unknown-role", "vercel")).toBe(false);
  });

  it("vercel is compatible with deploy-default", () => {
    expect(isCompatible("deploy-default", "vercel")).toBe(true);
  });

  it("cloudflare_workers is compatible with cloudflare-default", () => {
    expect(isCompatible("cloudflare-default", "cloudflare_workers")).toBe(true);
  });

  it("cloudflare_workers is NOT compatible with deploy-default", () => {
    expect(isCompatible("deploy-default", "cloudflare_workers")).toBe(false);
  });
});

describe("Resolved Group State", () => {
  it("group with healthy default has routeStatus 'valid'", () => {
    const group: MockGroup = {
      id: "grp-1",
      name: "Database",
      routeRole: "db-default",
      connections: [
        { id: "c1", providerKind: "neon", agentExposure: "enabled", isDefaultRoute: true, connectionStatus: "connected" },
      ],
    };
    expect(resolveRouteStatus(group)).toBe("valid");
  });

  it("group without default has routeStatus 'missing_default'", () => {
    const group: MockGroup = {
      id: "grp-2",
      name: "Database",
      routeRole: "db-default",
      connections: [
        { id: "c1", providerKind: "neon", agentExposure: "enabled", isDefaultRoute: false, connectionStatus: "connected" },
      ],
    };
    expect(resolveRouteStatus(group)).toBe("missing_default");
  });

  it("group with unhealthy default has routeStatus 'unhealthy'", () => {
    const group: MockGroup = {
      id: "grp-3",
      name: "Database",
      routeRole: "db-default",
      connections: [
        { id: "c1", providerKind: "neon", agentExposure: "enabled", isDefaultRoute: true, connectionStatus: "error" },
      ],
    };
    expect(resolveRouteStatus(group)).toBe("unhealthy");
  });

  it("group without routeRole has routeStatus 'no_role'", () => {
    const group: MockGroup = {
      id: "grp-4",
      name: "Payments",
      routeRole: null,
      connections: [
        { id: "c1", providerKind: "stripe", agentExposure: "enabled", isDefaultRoute: false, connectionStatus: "connected" },
      ],
    };
    expect(resolveRouteStatus(group)).toBe("no_role");
  });

  it("empty group with routeRole has routeStatus 'missing_default'", () => {
    const group: MockGroup = {
      id: "grp-5",
      name: "Deploy",
      routeRole: "deploy-default",
      connections: [],
    };
    expect(resolveRouteStatus(group)).toBe("missing_default");
  });

  it("only one default per group allowed", () => {
    const group: MockGroup = {
      id: "grp-6",
      name: "Database",
      routeRole: "db-default",
      connections: [
        { id: "c1", providerKind: "neon", agentExposure: "enabled", isDefaultRoute: true, connectionStatus: "connected" },
        { id: "c2", providerKind: "supabase", agentExposure: "enabled", isDefaultRoute: false, connectionStatus: "connected" },
      ],
    };
    expect(hasMultipleDefaults(group)).toBe(false);

    const badGroup: MockGroup = {
      ...group,
      connections: [
        { id: "c1", providerKind: "neon", agentExposure: "enabled", isDefaultRoute: true, connectionStatus: "connected" },
        { id: "c2", providerKind: "supabase", agentExposure: "enabled", isDefaultRoute: true, connectionStatus: "connected" },
      ],
    };
    expect(hasMultipleDefaults(badGroup)).toBe(true);
  });

  it("getDefaultConnection returns the default connection", () => {
    const group: MockGroup = {
      id: "grp-7",
      name: "Database",
      routeRole: "db-default",
      connections: [
        { id: "c1", providerKind: "neon", agentExposure: "enabled", isDefaultRoute: false, connectionStatus: "connected" },
        { id: "c2", providerKind: "supabase", agentExposure: "enabled", isDefaultRoute: true, connectionStatus: "connected" },
      ],
    };
    expect(getDefaultConnection(group)?.id).toBe("c2");
  });

  it("getDefaultConnection returns undefined when none set", () => {
    const group: MockGroup = {
      id: "grp-8",
      name: "Payments",
      routeRole: null,
      connections: [
        { id: "c1", providerKind: "stripe", agentExposure: "enabled", isDefaultRoute: false, connectionStatus: "connected" },
      ],
    };
    expect(getDefaultConnection(group)).toBeUndefined();
  });
});

describe("Agent Exposure Independence", () => {
  it("default connection can be agent-disabled", () => {
    const group: MockGroup = {
      id: "grp-9",
      name: "Database",
      routeRole: "db-default",
      connections: [
        { id: "c1", providerKind: "neon", agentExposure: "disabled", isDefaultRoute: true, connectionStatus: "connected" },
      ],
    };
    // Route still valid - agentExposure is independent from default routing
    expect(resolveRouteStatus(group)).toBe("valid");
    expect(getAgentVisibleConnections(group)).toHaveLength(0);
  });

  it("non-default connection can be agent-enabled", () => {
    const group: MockGroup = {
      id: "grp-10",
      name: "Database",
      routeRole: "db-default",
      connections: [
        { id: "c1", providerKind: "neon", agentExposure: "enabled", isDefaultRoute: true, connectionStatus: "connected" },
        { id: "c2", providerKind: "supabase", agentExposure: "enabled", isDefaultRoute: false, connectionStatus: "connected" },
      ],
    };
    expect(getAgentVisibleConnections(group)).toHaveLength(2);
  });

  it("disabled connection has no agent tools", () => {
    const group: MockGroup = {
      id: "grp-11",
      name: "Database",
      routeRole: "db-default",
      connections: [
        { id: "c1", providerKind: "neon", agentExposure: "disabled", isDefaultRoute: true, connectionStatus: "connected" },
        { id: "c2", providerKind: "supabase", agentExposure: "disabled", isDefaultRoute: false, connectionStatus: "connected" },
      ],
    };
    expect(getAgentVisibleConnections(group)).toHaveLength(0);
  });

  it("mixed exposure filters correctly", () => {
    const group: MockGroup = {
      id: "grp-12",
      name: "Database",
      routeRole: "db-default",
      connections: [
        { id: "c1", providerKind: "neon", agentExposure: "enabled", isDefaultRoute: true, connectionStatus: "connected" },
        { id: "c2", providerKind: "supabase", agentExposure: "disabled", isDefaultRoute: false, connectionStatus: "connected" },
        { id: "c3", providerKind: "turso", agentExposure: "enabled", isDefaultRoute: false, connectionStatus: "connected" },
      ],
    };
    const visible = getAgentVisibleConnections(group);
    expect(visible).toHaveLength(2);
    expect(visible.map((c) => c.id)).toEqual(["c1", "c3"]);
  });

  it("pending connection with agent enabled still shows as agent-visible", () => {
    const group: MockGroup = {
      id: "grp-13",
      name: "Deploy",
      routeRole: "deploy-default",
      connections: [
        { id: "c1", providerKind: "vercel", agentExposure: "enabled", isDefaultRoute: true, connectionStatus: "pending" },
      ],
    };
    expect(getAgentVisibleConnections(group)).toHaveLength(1);
    // But route is unhealthy since default is not connected
    expect(resolveRouteStatus(group)).toBe("unhealthy");
  });
});
