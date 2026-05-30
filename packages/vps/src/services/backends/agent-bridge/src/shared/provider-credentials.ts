// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// BYOK provider-auth helpers (pure). `ellul.getProviders` speaks the agent
// surface (ProviderKind: claudeAgent/codex/…), while the credential store keys
// by the underlying LLM provider (ProviderId: anthropic/openai/…). These map
// between the two and build the credential-field spec the console renders.
//
// v1 covers api-key agents only (claudeAgent/codex/grokAgent). cursor (sign-in),
// opencode + zeroclaw (multi-provider) advertise no field and reject submit.

import type { ProviderKind, ServerProvider, ServerProviderCredentialField } from "@ellul.ai/types";
import type { ProviderId } from "../internal-http/features-routes";

/** Canonical credential field key the console returns in `credentials`. */
export const API_KEY_FIELD = "apiKey";

/** Agent → underlying LLM api-key provider. Agents without a single BYOK key are absent. */
const AGENT_LLM_PROVIDER: Partial<Record<ProviderKind, ProviderId>> = {
  claudeAgent: "anthropic",
  codex: "openai",
  grokAgent: "xai",
};

const LLM_LABEL: Record<ProviderId, string> = {
  anthropic: "Anthropic API key",
  openai: "OpenAI API key",
  google: "Google AI API key",
  openrouter: "OpenRouter API key",
  xai: "xAI API key",
};

const LLM_PLACEHOLDER: Record<ProviderId, string> = {
  anthropic: "sk-ant-…",
  openai: "sk-…",
  google: "AIza…",
  openrouter: "sk-or-…",
  xai: "xai-…",
};

/** Map an agent ProviderKind to its LLM api-key provider, or null if it takes no key. */
export function mapAgentToLlmProvider(kind: ProviderKind): ProviderId | null {
  return AGENT_LLM_PROVIDER[kind] ?? null;
}

/** Field spec the console renders for this provider. Empty when it accepts no api key. */
export function credentialFieldsFor(kind: ProviderKind): ServerProviderCredentialField[] {
  const llm = AGENT_LLM_PROVIDER[kind];
  if (!llm) return [];
  return [{ key: API_KEY_FIELD, label: LLM_LABEL[llm], secret: true, placeholder: LLM_PLACEHOLDER[llm] }];
}

/**
 * Add the additive BYOK fields to a ServerProvider (getProviders / submit /
 * revoke results). When the provider accepts an api key AND one is present
 * (`byokAuthenticated`), reports `auth.status: "authenticated"` — because the
 * agent's native probe (e.g. claude's OAuth snapshot) does NOT reflect a pasted
 * ANTHROPIC_API_KEY, yet that key is what submit/revoke control and what the
 * agent will use. Only upgrades unauthenticated→authenticated; never downgrades
 * a native (subscription/OAuth) login.
 */
export function enrichProvider(p: ServerProvider, byokAuthenticated = false): ServerProvider {
  const fields = credentialFieldsFor(p.provider);
  const acceptsApiKey = fields.length > 0;
  const auth =
    acceptsApiKey && byokAuthenticated ? { ...p.auth, status: "authenticated" as const } : p.auth;
  return { ...p, acceptsApiKey, credentialFields: fields, auth };
}

/** Is the BYOK api key for this agent present in the connector store (env)? */
export function hasByokKey(
  kind: ProviderKind,
  connected: Record<string, { connected: boolean }>,
): boolean {
  const llm = mapAgentToLlmProvider(kind);
  return llm ? (connected[llm]?.connected ?? false) : false;
}

/**
 * Read + validate the api key from the customer's `credentials` map by the
 * provider's advertised field key (no single-value guessing), then apply the
 * shared format check. Returns null if missing or malformed.
 */
export function extractApiKey(
  credentials: Record<string, string> | undefined,
  fieldKey: string,
  validate: { re: RegExp; maxLen: number },
): string | null {
  const raw = credentials?.[fieldKey];
  if (typeof raw !== "string" || raw.length === 0) return null;
  if (raw.length > validate.maxLen || !validate.re.test(raw)) return null;
  return raw;
}

export type ApiKeyResolution =
  | { ok: true; providerId: ProviderId; apiKey: string }
  | { ok: false; error: string };

/**
 * Resolve + validate a submitApiKey request: the provider must be an api-key
 * agent, and `credentials` must carry a valid value under the agent's advertised
 * field key. Pure → the handler's decision logic is directly testable.
 */
export function resolveApiKeySubmission(
  provider: ProviderKind,
  credentials: Record<string, string>,
  validate: { re: RegExp; maxLen: number },
): ApiKeyResolution {
  const providerId = mapAgentToLlmProvider(provider);
  if (!providerId) return { ok: false, error: `Provider ${provider} does not accept an API key` };
  const fields = credentialFieldsFor(provider);
  const apiKey = extractApiKey(credentials, fields[0]!.key, validate);
  if (!apiKey) return { ok: false, error: "Missing or malformed API key" };
  return { ok: true, providerId, apiKey };
}

/** Resolve a revokeAuth request to the LLM provider whose key to clear. */
export function resolveRevoke(
  provider: ProviderKind,
): { ok: true; providerId: ProviderId } | { ok: false; error: string } {
  const providerId = mapAgentToLlmProvider(provider);
  if (!providerId) return { ok: false, error: `Provider ${provider} does not accept an API key` };
  return { ok: true, providerId };
}

/**
 * Tenant-mode provider enrichment: advertise acceptsApiKey + credentialFields and
 * reflect BYOK key presence in auth.status. No-op outside tenant mode (so the
 * human-facing getProviders is unchanged). Pure — caller supplies the IO results.
 */
export function enrichProvidersForTenant(
  providers: ReadonlyArray<ServerProvider>,
  opts: { tenantMode: boolean; connected: Record<string, { connected: boolean }> },
): ServerProvider[] {
  if (!opts.tenantMode) return providers as ServerProvider[];
  return providers.map((p) => enrichProvider(p, hasByokKey(p.provider, opts.connected)));
}
