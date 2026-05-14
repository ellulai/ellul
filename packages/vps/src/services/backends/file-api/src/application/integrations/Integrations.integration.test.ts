// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Cross-stack integration test — the one test that actually crosses the
 * VPS ↔ control-plane boundary.
 *
 * Spins up a real Node `http.Server` standing in for `apps/api`, serves a
 * realistic `IntegrationsResponse` from it, points the VPS integrations
 * service at that URL (via the `PATHS.API_URL` file), and lets the service
 * fetch + augment with local file-system signals. The result is then fed
 * through the SHARED resolver from `@ellul.ai/chat-actions`, and the
 * final `ResolvedAction[]` list is asserted end-to-end.
 *
 * If this test passes, three boundaries are working:
 *   1. Control-plane contract (response shape)
 *   2. VPS service fetch + merge with local git/migration signals
 *   3. Shared resolver availability rules
 *
 * Any drift between packages surfaces as a test failure here — exactly
 * what cross-stack integration is supposed to catch.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { IntegrationsResponse } from "@ellul.ai/types";
import { getAvailableActions } from "@ellul.ai/chat-actions";

// Hoisted so `vi.mock('../../config', …)` factory can reference the same tmp
// paths used by the test bodies.
const PATH_FIXTURES = vi.hoisted(() => {
  const fsModule = require("fs") as typeof import("fs");
  const osModule = require("os") as typeof import("os");
  const pathModule = require("path") as typeof import("path");
  const tmp = fsModule.mkdtempSync(
    pathModule.join(osModule.tmpdir(), "integrations-e2e-"),
  );
  return {
    tmpRoot: tmp,
    SERVER_ID_FILE: pathModule.join(tmp, "server-id"),
    API_URL_FILE: pathModule.join(tmp, "api-url"),
    AI_PROXY_TOKEN_FILE: pathModule.join(tmp, "ai-proxy-token"),
  };
});

vi.mock("../../config", () => ({
  HOME: "/tmp",
  ROOT_DIR: "/tmp/test-projects",
  PATHS: {
    SERVER_ID: PATH_FIXTURES.SERVER_ID_FILE,
    API_URL: PATH_FIXTURES.API_URL_FILE,
    AI_PROXY_TOKEN: PATH_FIXTURES.AI_PROXY_TOKEN_FILE,
  },
}));

vi.mock("@vps/shared/shield-client", () => ({
  callShieldInternal: vi.fn(async () =>
    new Response(JSON.stringify({ exists: false }), { status: 200 }),
  ),
  setShieldServiceName: vi.fn(),
}));

import {
  getIntegrations,
  invalidateIntegrationsCache,
} from "./Integrations";

// ─── Mock control-plane server ──────────────────────────────────────────────

let server: http.Server;
let serverUrl: string;
let receivedBearer = "";
let receivedAppName = "";
let nextBody: IntegrationsResponse | null = null;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = http.createServer((req, res) => {
      receivedBearer = req.headers.authorization ?? "";
      const u = new URL(req.url ?? "/", "http://localhost");
      receivedAppName = u.searchParams.get("sandboxId") ?? "";
      if (nextBody) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(nextBody));
      } else {
        res.writeHead(500);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        serverUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });

  fs.writeFileSync(PATH_FIXTURES.SERVER_ID_FILE, "srv_e2e");
  fs.writeFileSync(PATH_FIXTURES.API_URL_FILE, serverUrl);
  fs.writeFileSync(PATH_FIXTURES.AI_PROXY_TOKEN_FILE, "tok_e2e");
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(PATH_FIXTURES.tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  invalidateIntegrationsCache();
  receivedBearer = "";
  receivedAppName = "";
  nextBody = null;
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-"));
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(
    path.join(dir, ".git", "config"),
    '[remote "origin"]\n\turl = git@github.com:me/app.git\n',
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ scripts: { "db:migrate": "drizzle-kit migrate" } }),
  );
  return dir;
}

function response(overrides: Partial<IntegrationsResponse["state"]> = {}): IntegrationsResponse {
  return {
    sandboxId: "sbx-e2e12345/app",
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
      ...overrides,
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("integrations — cross-stack", () => {
  it("fetches control-plane state, augments with local signals, and resolves actions", async () => {
    nextBody = response({
      gitProviders: ["github"],
      hasLinkedRepo: true,
      deployProviders: ["vercel"],
      hasDeployConfig: true,
    });
    const projectDir = makeProject();

    const result = await getIntegrations("sbx-e2e12345/app", projectDir);

    // 1. Real HTTP call reached the mock control plane.
    expect(receivedBearer).toBe("Bearer tok_e2e");
    expect(receivedAppName).toBe("sbx-e2e12345/app");

    // 2. Service merged the response with local signals.
    expect(result.state.gitProviders).toEqual(["github"]);
    expect(result.state.hasLinkedRepo).toBe(true); // CP=true AND .git/config=true
    expect(result.state.hasMigrations).toBe(true); // from package.json scan

    // 3. Shared resolver returns the expected action list. db-push is
    // hidden — no dataProviders connected, shield has no local database.
    const available = getAvailableActions(result.state, {
      currentContext: "workspace",
    });
    const ids = available.map((a) => a.id).sort();
    expect(ids).toEqual(["deploy", "git-push"]);

    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("downgrades hasLinkedRepo when the VPS has no local git remote", async () => {
    nextBody = response({
      gitProviders: ["github"],
      hasLinkedRepo: true,
    });
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "bare-"));

    const result = await getIntegrations("sbx-e2e12345/app", projectDir);
    const ids = getAvailableActions(result.state, {
      currentContext: "workspace",
    }).map((a) => a.id);

    // Provider connected at the platform but no local remote — resolver hides git-push.
    expect(result.state.hasLinkedRepo).toBe(false);
    expect(ids).not.toContain("git-push");

    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("produces an empty action list when the control plane is unreachable", async () => {
    nextBody = null; // server returns 500
    const projectDir = makeProject();

    const result = await getIntegrations("sbx-e2e12345/app", projectDir);
    const available = getAvailableActions(result.state, {
      currentContext: "workspace",
    });

    // Fail-soft: no providers, no actions, UI hides the dropdown.
    expect(available).toEqual([]);

    fs.rmSync(projectDir, { recursive: true, force: true });
  });
});
