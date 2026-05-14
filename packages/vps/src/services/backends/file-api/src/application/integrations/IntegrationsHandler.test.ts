// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * HTTP-less handler tests.
 *
 * Exercises every branch of `handleGetIntegrations` and
 * `handleInvalidateIntegrations`: missing identifier (400), unknown
 * directory (404), service failure (502), and the happy path (200).
 * The resolveProjectDir injection keeps the tests hermetic — no
 * dependency on the VPS project-tree layout.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../../config", () => ({
  ROOT_DIR: "/tmp/test-projects",
  PATHS: {
    SERVER_ID: "/tmp/nonexistent",
    API_URL: "/tmp/nonexistent",
    AI_PROXY_TOKEN: "/tmp/nonexistent",
  },
}));

vi.mock("./Integrations", () => ({
  getIntegrations: vi.fn(),
  invalidateIntegrationsCache: vi.fn(),
}));

import {
  handleGetIntegrations,
  handleInvalidateIntegrations,
} from "./IntegrationsHandler";
import {
  getIntegrations,
  invalidateIntegrationsCache,
} from "./Integrations";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const passthrough = (id: string) => (id ? id : null);
const deny = (_: string) => null;

const emptyResponse = {
  sandboxId: "sbx-abc1234/my-app",
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
  computedAt: 1,
};

// ─── handleGetIntegrations ──────────────────────────────────────────────────

describe("handleGetIntegrations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 400 when the identifier is missing", async () => {
    const result = await handleGetIntegrations("", passthrough);
    expect(result.status).toBe(400);
  });

  it("returns 404 when the project cannot be resolved", async () => {
    const result = await handleGetIntegrations("unknown", deny);
    expect(result.status).toBe(404);
  });

  it("returns 200 with the service response on the happy path", async () => {
    vi.mocked(getIntegrations).mockResolvedValue(emptyResponse);
    const result = await handleGetIntegrations(
      "sbx-abc1234/my-app",
      passthrough,
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.body.sandboxId).toBe("sbx-abc1234/my-app");
    }
  });

  it("returns 502 when the service throws", async () => {
    vi.mocked(getIntegrations).mockRejectedValue(new Error("upstream"));
    const result = await handleGetIntegrations(
      "sbx-abc1234/my-app",
      passthrough,
    );
    expect(result.status).toBe(502);
    if (result.status === 502) {
      expect(result.body.error).toContain("upstream");
    }
  });
});

// ─── handleInvalidateIntegrations ───────────────────────────────────────────

describe("handleInvalidateIntegrations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 400 when the identifier is missing", () => {
    const result = handleInvalidateIntegrations("", passthrough);
    expect(result.status).toBe(400);
    expect(invalidateIntegrationsCache).not.toHaveBeenCalled();
  });

  it("returns 404 when the project cannot be resolved", () => {
    const result = handleInvalidateIntegrations("unknown", deny);
    expect(result.status).toBe(404);
    expect(invalidateIntegrationsCache).not.toHaveBeenCalled();
  });

  it("returns 200 and clears the service cache for the resolved path", () => {
    const result = handleInvalidateIntegrations(
      "sbx-abc1234/my-app",
      passthrough,
    );
    expect(result.status).toBe(200);
    expect(invalidateIntegrationsCache).toHaveBeenCalledWith(
      "sbx-abc1234/my-app",
    );
  });
});
