// SPDX-License-Identifier: MIT

import { requiresIntentSignature } from "@ellul.ai/pqc-types";
import type {
  BridgeMessageType,
  BridgeResponse,
  GateAckResponse,
  GateRequestResponse,
  GateRespondResponse,
  GatesActiveResponse,
} from "@ellul.ai/vps/auth/bridge-contracts";
import type { OperatorKeyApi } from "./operator-key";

export type GateType =
  | "logs"
  | "env"
  | "db"
  | "db_read"
  | "db_write"
  | "db_migrate"
  | "db_full"
  | "git"
  | "deploy";
export type GatePermission = "ask" | "allow_session" | "allow_always" | "never";
export type GateRespondAction =
  | "grant_timed"
  | "grant_session"
  | "grant_always"
  | "deny";

export interface GateClient {
  respondToGate(args: {
    requestId: string;
    gate: GateType | string;
    project: string | null;
    action: GateRespondAction;
    metadata?: Record<string, unknown>;
  }): Promise<GateRespondResponse>;
  revokeGate(args: { gate: GateType; project: string }): Promise<GateAckResponse>;
  setGatePermission(args: {
    gate: GateType;
    project: string;
    permission: GatePermission;
  }): Promise<GateAckResponse>;
  grantGate(args: {
    gate: GateType;
    project: string;
    action: "grant_timed" | "grant_session";
  }): Promise<GateRespondResponse | GateRequestResponse>;
  fetchGates(project: string): Promise<GatesActiveResponse>;
}

export interface GateClientError extends Error {
  status?: number;
  code?: string;
  classified?: boolean;
  requiredSignatureType?: string;
}

/**
 * Bridge sender — matches the overloaded signature exposed by useVpsBridge().
 * Typed-key calls return the contract's response shape; unknown keys fall
 * back to the generic <T> overload (currently unused by gate-client).
 */
export interface BridgeSender {
  <K extends BridgeMessageType>(
    type: K,
    data?: Record<string, unknown>,
  ): Promise<BridgeResponse<K>>;
  <T = unknown>(type: string, data?: Record<string, unknown>): Promise<T>;
}

// Map shield error envelopes into the GateClientError shape callers expect.
// Bridge transport rejects with `new Error(parsed.error)` — we have no status
// code on that path, so callers should rely on `code` / message text instead
// of `status`. Backwards-compat: status stays undefined for bridge errors.
function wrapBridgeError(err: unknown): GateClientError {
  if (err instanceof Error) {
    const wrapped = err as GateClientError;
    return wrapped;
  }
  const e: GateClientError = new Error(String(err));
  return e;
}

export function makeGateClient(
  _serverDomain: string,
  operatorKey: OperatorKeyApi,
  bridgeSend: BridgeSender,
  isLockedTier: boolean,
): GateClient {
  return {
    async respondToGate({ requestId, gate, project, action, metadata }) {
      const bridgeData: Record<string, unknown> = {
        gateRequestId: requestId,
        action,
      };
      if (metadata !== undefined) bridgeData.metadata = metadata;

      if (isLockedTier) {
        const metadataJson = JSON.stringify(metadata ?? {});
        const payload = new TextEncoder().encode(
          `gate-respond|${requestId}|${action}|${metadataJson}`,
        );
        const signed = await operatorKey.sign(payload);
        bridgeData.operatorSignature = signed.signature;
        bridgeData.operatorTimestamp = signed.timestamp;

        const needsIntent = action !== "deny" && requiresIntentSignature(gate);
        if (needsIntent) {
          const intent = await operatorKey.signIntent(gate, project);
          bridgeData.intentSignature = intent.intentSignature;
          bridgeData.intentNonce = intent.intentNonce;
          bridgeData.intentType = intent.intentType;
        }
      }

      try {
        const result = await bridgeSend("gate_respond", bridgeData);
        return result;
      } catch (e) {
        throw wrapBridgeError(e);
      }
    },

    async revokeGate({ gate, project }) {
      const data: Record<string, unknown> = { gate, project };
      if (isLockedTier) {
        const payload = new TextEncoder().encode(`gate-revoke|${gate}|${project}`);
        const { signature, timestamp } = await operatorKey.sign(payload);
        data.operatorSignature = signature;
        data.operatorTimestamp = timestamp;
      }
      try {
        return await bridgeSend("gate_revoke", data);
      } catch (e) {
        throw wrapBridgeError(e);
      }
    },

    async setGatePermission({ gate, project, permission }) {
      const data: Record<string, unknown> = { gate, project, policy: permission };
      if (isLockedTier) {
        const payload = new TextEncoder().encode(
          `gate-permission|${gate}|${project}|${permission}`,
        );
        const { signature, timestamp } = await operatorKey.sign(payload);
        data.operatorSignature = signature;
        data.operatorTimestamp = timestamp;
      }
      try {
        return await bridgeSend("gate_set_permission", data);
      } catch (e) {
        throw wrapBridgeError(e);
      }
    },

    async grantGate({ gate, project, action }) {
      // No browser-facing /gates/grant endpoint; synthesize via /request +
      // /respond. Auto-short-circuit paths (already_granted / policy auto-grant
      // / auto-deny) return without a sign.
      let requestBody: GateRequestResponse;
      try {
        requestBody = await bridgeSend("gate_request", {
          project,
          gate,
          reason: "Proactive grant from dashboard",
        });
      } catch (e) {
        throw wrapBridgeError(e);
      }

      if (
        requestBody.status === "granted" ||
        requestBody.status === "already_granted"
      ) {
        return requestBody;
      }
      if (requestBody.status === "denied") {
        const err: GateClientError = new Error(
          "Gate request auto-denied by policy",
        );
        err.status = 403;
        throw err;
      }
      if (!requestBody.requestId) {
        throw new Error("Gate request returned pending without a requestId");
      }
      return this.respondToGate({
        requestId: requestBody.requestId,
        gate,
        project,
        action,
      });
    },

    async fetchGates(project) {
      try {
        return await bridgeSend("gate_list_active", { project });
      } catch (e) {
        throw wrapBridgeError(e);
      }
    },

  };
}

