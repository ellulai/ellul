// SPDX-License-Identifier: BUSL-1.1
import { describe, it, expect } from "vitest";
import {
  mapAgentToLlmProvider,
  credentialFieldsFor,
  enrichProvider,
  extractApiKey,
  hasByokKey,
  resolveApiKeySubmission,
  resolveRevoke,
  enrichProvidersForTenant,
} from "./provider-credentials";

// Mirror of the shared features-routes validation (reused at the call site).
const VALIDATE = { re: /^[A-Za-z0-9_\-+/=.]+$/, maxLen: 512 };

describe("mapAgentToLlmProvider", () => {
  it("maps api-key agents to their LLM provider", () => {
    expect(mapAgentToLlmProvider("claudeAgent")).toBe("anthropic");
    expect(mapAgentToLlmProvider("codex")).toBe("openai");
    expect(mapAgentToLlmProvider("grokAgent")).toBe("xai");
  });
  it("returns null for sign-in / multi-provider agents", () => {
    expect(mapAgentToLlmProvider("cursor")).toBeNull();
    expect(mapAgentToLlmProvider("opencode")).toBeNull();
    expect(mapAgentToLlmProvider("zeroclaw")).toBeNull();
  });
});

describe("credentialFieldsFor", () => {
  it("advertises a secret apiKey field for api-key agents", () => {
    const f = credentialFieldsFor("claudeAgent");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ key: "apiKey", secret: true });
    expect(f[0]!.label).toMatch(/Anthropic/);
  });
  it("advertises nothing for non-api-key agents", () => {
    expect(credentialFieldsFor("cursor")).toEqual([]);
    expect(credentialFieldsFor("opencode")).toEqual([]);
  });
});

const claudeBase = { provider: "claudeAgent", auth: { status: "unauthenticated" }, models: [] } as never;
const cursorBase = { provider: "cursor", auth: { status: "unauthenticated" }, models: [] } as never;

describe("enrichProvider", () => {
  it("sets acceptsApiKey + credentialFields for api-key agents", () => {
    const e = enrichProvider(claudeBase);
    expect(e.acceptsApiKey).toBe(true);
    expect(e.credentialFields).toHaveLength(1);
  });
  it("acceptsApiKey:false + empty fields for non-api-key agents", () => {
    const e = enrichProvider(cursorBase);
    expect(e.acceptsApiKey).toBe(false);
    expect(e.credentialFields).toEqual([]);
  });
  it("byokAuthenticated upgrades auth.status to authenticated for api-key agents", () => {
    expect(enrichProvider(claudeBase, true).auth.status).toBe("authenticated");
    expect(enrichProvider(claudeBase, false).auth.status).toBe("unauthenticated");
  });
  it("does not upgrade non-api-key agents even if byokAuthenticated", () => {
    expect(enrichProvider(cursorBase, true).auth.status).toBe("unauthenticated");
  });
  it("never downgrades a native (OAuth) authenticated provider", () => {
    const oauth = { provider: "claudeAgent", auth: { status: "authenticated" }, models: [] } as never;
    expect(enrichProvider(oauth, false).auth.status).toBe("authenticated");
  });
});

describe("hasByokKey", () => {
  it("true when the mapped LLM provider's key is connected", () => {
    expect(hasByokKey("claudeAgent", { anthropic: { connected: true } })).toBe(true);
    expect(hasByokKey("codex", { openai: { connected: true } })).toBe(true);
  });
  it("false when absent / disconnected / non-api-key agent", () => {
    expect(hasByokKey("claudeAgent", { anthropic: { connected: false } })).toBe(false);
    expect(hasByokKey("claudeAgent", {})).toBe(false);
    expect(hasByokKey("cursor", { anthropic: { connected: true } })).toBe(false);
  });
});

describe("extractApiKey", () => {
  it("reads the value under the given field key", () => {
    expect(extractApiKey({ apiKey: "sk-ant-abc123" }, "apiKey", VALIDATE)).toBe("sk-ant-abc123");
  });
  it("does NOT fall back to a differently-named field (validates against credentialFields)", () => {
    expect(extractApiKey({ key: "sk-or-xyz" }, "apiKey", VALIDATE)).toBeNull();
  });
  it("rejects missing / empty / undefined", () => {
    expect(extractApiKey({}, "apiKey", VALIDATE)).toBeNull();
    expect(extractApiKey(undefined, "apiKey", VALIDATE)).toBeNull();
    expect(extractApiKey({ apiKey: "" }, "apiKey", VALIDATE)).toBeNull();
  });
  it("rejects malformed keys (bad chars, too long)", () => {
    expect(extractApiKey({ apiKey: "has spaces" }, "apiKey", VALIDATE)).toBeNull();
    expect(extractApiKey({ apiKey: "x".repeat(513) }, "apiKey", VALIDATE)).toBeNull();
  });
});

describe("resolveApiKeySubmission", () => {
  it("resolves an api-key agent + valid key to its LLM provider", () => {
    expect(resolveApiKeySubmission("claudeAgent", { apiKey: "sk-ant-abc" }, VALIDATE)).toEqual({
      ok: true,
      providerId: "anthropic",
      apiKey: "sk-ant-abc",
    });
  });
  it("rejects a non-api-key agent", () => {
    expect(resolveApiKeySubmission("cursor", { apiKey: "sk-x" }, VALIDATE)).toMatchObject({ ok: false });
  });
  it("rejects missing / wrong-field / malformed keys", () => {
    expect(resolveApiKeySubmission("codex", {}, VALIDATE)).toMatchObject({ ok: false });
    expect(resolveApiKeySubmission("codex", { wrong: "sk-x" }, VALIDATE)).toMatchObject({ ok: false });
    expect(resolveApiKeySubmission("codex", { apiKey: "has spaces" }, VALIDATE)).toMatchObject({ ok: false });
  });
});

describe("resolveRevoke", () => {
  it("resolves an api-key agent to its LLM provider", () => {
    expect(resolveRevoke("grokAgent")).toEqual({ ok: true, providerId: "xai" });
  });
  it("rejects a non-api-key agent", () => {
    expect(resolveRevoke("opencode")).toMatchObject({ ok: false });
  });
});

describe("enrichProvidersForTenant", () => {
  const providers = [
    { provider: "claudeAgent", auth: { status: "unauthenticated" }, models: [] },
    { provider: "cursor", auth: { status: "unauthenticated" }, models: [] },
  ] as never[];
  it("is a no-op (passthrough) outside tenant mode", () => {
    const out = enrichProvidersForTenant(providers, {
      tenantMode: false,
      connected: { anthropic: { connected: true } },
    });
    expect(out).toBe(providers as never);
    expect(out[0]!.acceptsApiKey).toBeUndefined();
  });
  it("enriches + reflects byok key presence in tenant mode", () => {
    const out = enrichProvidersForTenant(providers, {
      tenantMode: true,
      connected: { anthropic: { connected: true } },
    });
    expect(out[0]!.acceptsApiKey).toBe(true);
    expect(out[0]!.auth.status).toBe("authenticated");
    expect(out[1]!.acceptsApiKey).toBe(false);
  });
  it("leaves auth unauthenticated when the byok key is absent", () => {
    const out = enrichProvidersForTenant(providers, { tenantMode: true, connected: {} });
    expect(out[0]!.auth.status).toBe("unauthenticated");
  });
});
