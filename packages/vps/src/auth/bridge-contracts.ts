// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * BridgeContract — single source of truth for postMessage bridge shapes.
 *
 * The console hosts a hidden iframe that loads bridge-client.js; calls
 * flow console -> iframe -> shield HTTP routes, and responses come back
 * verbatim. Historically each caller passed its own `<T>` to `send()`,
 * which is a cast: TypeScript trusted the caller, not the route. A drift
 * — e.g. reading `result.token` from an endpoint that returns
 * `{ codeSessionId, expiresAt, tier }` — compiled cleanly and produced
 * `undefined` at runtime, which in turn broke the realtime WebSocket and
 * left the UI in a fallback re-fetch loop against /_auth/code/session.
 *
 * This file is the contract. The shield routes pin their return shape
 * with `satisfies BridgeResponse<'...'>`; the console's `send()` is
 * overloaded to infer the response from the message key. Adding a new
 * bridge operation MUST add an entry here — unknown keys fall through to
 * the legacy `<T>` overload, so migration is incremental.
 */

export type SecurityTier = "standard" | "web_locked" | "private_locked";

/** POST /_auth/code/session — issues a short-lived code session used to
 * authenticate WS upgrades and requests to the code subdomain. */
export interface CodeSessionResponse {
  codeSessionId: string;
  expiresAt: number;
  tier: SecurityTier;
}

/** Generic token envelope used by *_token endpoints that mint a scoped
 * JWT (code, agent, terminal, preview). */
export interface TokenResponse {
  token: string;
  expiresAt: number;
}

/** POST /_auth/bridge/exchange-code — one-time code for cross-origin
 * iframe session establishment. */
export interface ExchangeCodeResponse {
  code: string;
  expiresAt: number;
}

/** POST /_auth/session/keepalive — liveness probe for the shield
 * session. */
export interface SessionKeepaliveResponse {
  alive: boolean;
  reason?: string;
}

/** Result of the bridge's local `check_session` handler (GET
 * /_auth/bridge/session wrapped in a hasSession flag). */
export interface CheckSessionResponse {
  hasSession: boolean;
}

/**
 * One row in the permission inbox. Fields mirror
 * packages/vps/src/services/auth/sovereign-shield/src/services/permission.service.ts;
 * kept broad here because the console casts to its own local `InboxRequest`
 * shape. Tightening both ends to a shared type is a follow-up.
 */
export interface InboxRequestRecord {
  id: string;
  gate: string;
  threadId: string;
  sandboxId: string | null;
  status: 'pending' | 'granted' | 'denied' | 'revoked' | 'expired' | 'superseded';
  createdAt: number;
  resolvedAt: number | null;
  lastSeenAt: number | null;
  reason: string | null;
  scope: Record<string, unknown> | null;
  requestedBy: Record<string, unknown>;
  resolution: Record<string, unknown> | null;
}

/** GET /_auth/permissions/pending response. */
export interface PermissionListResponse {
  requests: InboxRequestRecord[];
}

/** Mirror of GateType from console gate-client. Server-side schema lives in
 * gates.routes.ts; we keep this here so the bridge contract is the only
 * cross-package surface and clients import from one place. */
export type BridgeGateType =
  | "logs"
  | "env"
  | "db"
  | "db_read"
  | "db_write"
  | "db_migrate"
  | "db_full"
  | "git"
  | "deploy";

export type BridgeGatePolicy = "ask" | "allow_session" | "allow_always" | "never";
export type BridgeGateRespondAction = "grant_timed" | "grant_session" | "grant_always" | "deny";

/** GET /_auth/gates/active response. */
export interface GatesActiveResponse {
  gates: Array<{
    gate: BridgeGateType;
    status: "open" | "closed";
    policy: BridgeGatePolicy;
    expiresAt: number | null;
  }>;
}

/** POST /_auth/gates/request response. */
export interface GateRequestResponse {
  status: "granted" | "already_granted" | "denied" | "pending";
  requestId?: string;
}

/** POST /_auth/gates/respond response — opaque envelope from gate-respond.
 * Caller-shape varies (timed grant vs session grant vs deny ack), so the
 * bridge surface stays unknown-typed and individual callers narrow. */
export interface GateRespondResponse {
  // Server returns various shapes (success, error envelopes, signature
  // requirements). Treat as opaque at the bridge boundary.
  [key: string]: unknown;
}

/** POST /_auth/gates/revoke + /_auth/gates/permissions response. */
export interface GateAckResponse {
  ok?: boolean;
  [key: string]: unknown;
}

/** GET + POST /_auth/context-mode response. */
export interface ContextModeResponse {
  mode: "base" | "preview" | "deploy";
}

/** POST /_auth/tool-permissions + /reset response. */
export interface ToolPermissionAckResponse {
  ok: true;
}

/** GET /_auth/gates/operator-status response — bind state of the three signing keys. */
export interface OperatorStatusResponse {
  bound: boolean;
  publicKey?: string;
  intentMldsa44PublicKey?: string;
  intentSlhdsa128sPublicKey?: string;
}

/** GET /_auth/gates/bind-nonce response. */
export interface OperatorBindNonceResponse {
  nonce: string | null;
  alreadyBound: boolean;
}

/** POST /_auth/gates/bind-operator response. */
export interface OperatorBindOperatorResponse {
  status: "bound";
  [key: string]: unknown;
}

/** GET /_auth/intent/nonce response — short-lived single-use intent nonce
 * issued for a specific (action, resource) tuple. The shield validates the
 * action+resource pair before issuing the nonce, so it cannot be replayed
 * across actions or across resources. */
export interface IntentNonceResponse {
  nonce: string;
  expiresAt: number;
}

/** GET /_auth/permissions/:id response. */
export interface PermissionGetResponse {
  request: InboxRequestRecord;
}

/** GET /_auth/permissions/history response. */
export interface PermissionHistoryResponse {
  requests: InboxRequestRecord[];
}

/** POST /_auth/permissions/:id/seen response. */
export interface PermissionMarkSeenResponse {
  success: boolean;
  lastSeenAt: number;
}

/**
 * Registry of typed bridge operations. Extend as operations move off the
 * legacy `<T>` escape hatch.
 *
 * Keep keys sorted by logical grouping (session, tokens, misc) so diffs
 * read cleanly.
 */
export interface BridgeContract {
  // Session lifecycle
  check_session: { response: CheckSessionResponse };
  session_keepalive: { response: SessionKeepaliveResponse };

  // Token issuance — every *_token / get_code_session MUST be in this
  // block so the console can't drift on token shapes again.
  get_code_session: { response: CodeSessionResponse };
  get_code_token: { response: TokenResponse };
  get_agent_token: { response: TokenResponse };
  get_terminal_token: { response: TokenResponse };
  get_preview_token: { response: TokenResponse };
  get_exchange_code: { response: ExchangeCodeResponse };

  // Permission inbox — REST calls route through the bridge iframe so the
  // PoP Service Worker signs each request. Only /events stays direct.
  permission_list_pending: { response: PermissionListResponse };
  permission_get: { response: PermissionGetResponse };
  permission_history: { response: PermissionHistoryResponse };
  permission_mark_seen: { response: PermissionMarkSeenResponse };

  // Operator-key actions and gate state — same rationale: the console origin
  // has no PoP Service Worker, so direct fetch from the dashboard returns 401
  // (missing_pop_headers). Routing through the bridge iframe lets the SW at
  // {srv}.ellul.ai sign every request. STS minting is folded into the gate
  // calls that need it (gate_request, gate_list_active) so the token never
  // crosses the bridge boundary.
  gate_list_active: { response: GatesActiveResponse };
  gate_request: { response: GateRequestResponse };
  gate_respond: { response: GateRespondResponse };
  gate_revoke: { response: GateAckResponse };
  gate_set_permission: { response: GateAckResponse };

  // Context mode + tool-permission writes — operator-signed, no STS needed.
  context_mode_get: { response: ContextModeResponse };
  context_mode_set: { response: ContextModeResponse };
  tool_permission_set: { response: ToolPermissionAckResponse };
  tool_permission_reset: { response: ToolPermissionAckResponse };

  // Operator-key bind ceremony — these power the resolveSession() loop in
  // apps/console/src/lib/operator-key.ts. operator-status is hit on EVERY
  // sandbox/scope switch; routing through the bridge prevents a 401 →
  // AuthWall flicker on every switch. bind-nonce + bind-operator are part
  // of the post-passkey key-binding ceremony.
  gate_operator_status: { response: OperatorStatusResponse };
  gate_bind_nonce: { response: OperatorBindNonceResponse };
  gate_bind_operator: { response: OperatorBindOperatorResponse };
  intent_nonce: { response: IntentNonceResponse };
}

export type BridgeMessageType = keyof BridgeContract;
export type BridgeResponse<K extends BridgeMessageType> = BridgeContract[K]["response"];
