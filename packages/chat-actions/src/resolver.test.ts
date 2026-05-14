// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Shared resolver tests. Because both `apps/console` and
 * `packages/vps-ui` consume this module, these tests cover the behaviour
 * that matters for BOTH surfaces at once — drift between console and
 * chat is physically impossible.
 */

import { describe, it, expect } from "vitest";
import type {
  ActionContext,
  IntegrationState,
  ResolvedAction,
} from "@ellul.ai/types";
import { ACTIONS } from "./registry";
import { getAvailableActions, resolveActions } from "./resolver";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const FULL: IntegrationState = {
  deployProviders: ["vercel"],
  dataProviders: ["supabase"],
  gitProviders: ["github"],
  cloudflareProviders: ["cloudflare_workers"],
  paymentProviders: ["stripe"],
  hasLinkedRepo: true,
  hasDeployConfig: true,
  hasDatabase: true,
  hasMigrations: true,
};

const EMPTY: IntegrationState = {
  deployProviders: [],
  dataProviders: [],
  gitProviders: [],
  cloudflareProviders: [],
  paymentProviders: [],
  hasLinkedRepo: false,
  hasDeployConfig: false,
  hasDatabase: false,
  hasMigrations: false,
};

const WORKSPACE: ActionContext = { currentContext: "workspace" };
const DATABASE: ActionContext = { currentContext: "database" };
const INTEGRATIONS: ActionContext = { currentContext: "integrations" };
const NONSENSE: ActionContext = { currentContext: "vault" };

const ids = (xs: ResolvedAction[]) => xs.map((a) => a.id).sort();

// ─── Registry shape invariants ──────────────────────────────────────────────

describe("registry", () => {
  it("every entry has a unique id", () => {
    const seen = new Set<string>();
    for (const a of ACTIONS) {
      expect(seen.has(a.id)).toBe(false);
      seen.add(a.id);
    }
  });

  it("every entry carries a context, integrationCategory, and gateType", () => {
    for (const a of ACTIONS) {
      expect(a.context).toBeTruthy();
      expect(a.integrationCategory).toBeTruthy();
      expect(a.gateType).toBeTruthy();
    }
  });
});

// ─── Workspace context ──────────────────────────────────────────────────────

describe("resolver — workspace", () => {
  it("returns deploy, git-push, db-push when everything is connected", () => {
    expect(ids(getAvailableActions(FULL, WORKSPACE))).toEqual([
      "db-push",
      "deploy",
      "git-push",
    ]);
  });

  it("returns nothing when integrations are empty", () => {
    expect(getAvailableActions(EMPTY, WORKSPACE)).toEqual([]);
  });

  it("hides deploy when provider exists but no deploy config", () => {
    const state = { ...FULL, hasDeployConfig: false };
    expect(ids(getAvailableActions(state, WORKSPACE))).not.toContain("deploy");
  });

  it("hides git-push when provider exists but no linked repo", () => {
    const state = { ...FULL, hasLinkedRepo: false };
    expect(ids(getAvailableActions(state, WORKSPACE))).not.toContain(
      "git-push",
    );
  });

  it("hides db-push when migrations are missing", () => {
    const state = { ...FULL, hasMigrations: false };
    expect(ids(getAvailableActions(state, WORKSPACE))).not.toContain("db-push");
  });

  it("accepts a shield-only database (no external provider) for db-push", () => {
    const state = { ...EMPTY, hasDatabase: true, hasMigrations: true };
    expect(ids(getAvailableActions(state, WORKSPACE))).toContain("db-push");
  });
});

// ─── Database context ───────────────────────────────────────────────────────

describe("resolver — database", () => {
  it("requires a selection for destructive per-table actions", () => {
    const resolved = resolveActions(FULL, DATABASE);
    expect(
      resolved.find((a) => a.id === "db-drop-table")?.available,
    ).toBe(false);
  });

  it("surfaces destructive per-table actions once a table is selected", () => {
    const ctx: ActionContext = {
      currentContext: "database",
      selection: { type: "table", name: "users" },
    };
    const resolved = resolveActions(FULL, ctx);
    expect(
      resolved.find((a) => a.id === "db-drop-table")?.available,
    ).toBe(true);
  });

  it("exposes backup / restore / run-migration without a selection", () => {
    const resolved = resolveActions(FULL, DATABASE);
    expect(resolved.find((a) => a.id === "db-backup")?.available).toBe(true);
    expect(resolved.find((a) => a.id === "db-restore")?.available).toBe(true);
    expect(
      resolved.find((a) => a.id === "db-run-migration")?.available,
    ).toBe(true);
  });
});

// ─── Integrations context ──────────────────────────────────────────────────

describe("resolver — integrations", () => {
  it("surfaces provision/sync only when a data provider is connected", () => {
    expect(ids(getAvailableActions(FULL, INTEGRATIONS))).toEqual(
      expect.arrayContaining(["db-provision", "credentials-sync"]),
    );
    expect(getAvailableActions(EMPTY, INTEGRATIONS)).toEqual([]);
  });
});

// ─── Unknown context ────────────────────────────────────────────────────────

describe("resolver — unknown context", () => {
  it("returns an empty list when the context has no registered actions", () => {
    expect(resolveActions(FULL, NONSENSE)).toEqual([]);
    expect(getAvailableActions(FULL, NONSENSE)).toEqual([]);
  });
});

// ─── Reason propagation ─────────────────────────────────────────────────────

describe("resolver — unavailableReason", () => {
  it("emits a reason for every unavailable action", () => {
    const resolved = resolveActions(EMPTY, WORKSPACE);
    const unavailable = resolved.filter((a) => !a.available);
    expect(unavailable.length).toBeGreaterThan(0);
    for (const action of unavailable) {
      expect(action.unavailableReason).toBeTruthy();
    }
  });
});
