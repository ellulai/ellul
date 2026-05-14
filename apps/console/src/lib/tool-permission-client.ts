// SPDX-License-Identifier: MIT

import type { ToolPermissionAckResponse } from "@ellul.ai/vps/auth/bridge-contracts";
import type { OperatorKeyApi } from "./operator-key";
import type { BridgeSender } from "./gate-client";

export type ToolPermissionLevel = "ask" | "allow_session" | "allow_always" | "never";

export interface ToolPermissionClient {
  setToolPermission(
    connectionId: string,
    toolName: string,
    permission: ToolPermissionLevel,
  ): Promise<{ ok: true }>;
  resetToolPermission(
    connectionId: string,
    toolName: string,
  ): Promise<{ ok: true }>;
}

export interface ToolPermissionClientError extends Error {
  status?: number;
}

// Routes through the iframe bridge — same rationale as gate-client and
// context-mode-client. Operator signature payload format must mirror
// sovereign-shield's tool-permission.routes.ts (server appends
// `|${operatorTimestamp}` before verify); the bridge transports the
// canonical payload + signature unchanged.
export function makeToolPermissionClient(
  _serverDomain: string,
  operatorKey: OperatorKeyApi,
  bridgeSend: BridgeSender,
  isLockedTier: boolean,
): ToolPermissionClient {
  return {
    async setToolPermission(connectionId, toolName, permission) {
      const data: Record<string, unknown> = { connectionId, toolName, permission };
      if (isLockedTier) {
        const payload = new TextEncoder().encode(
          `tool-permission|${connectionId}|${toolName}|${permission}`,
        );
        const { signature, timestamp } = await operatorKey.sign(payload);
        data.operatorSignature = signature;
        data.operatorTimestamp = timestamp;
      }
      const result: ToolPermissionAckResponse = await bridgeSend(
        "tool_permission_set",
        data,
      );
      return result;
    },

    async resetToolPermission(connectionId, toolName) {
      const data: Record<string, unknown> = { connectionId, toolName };
      if (isLockedTier) {
        const payload = new TextEncoder().encode(
          `tool-permission-reset|${connectionId}|${toolName}`,
        );
        const { signature, timestamp } = await operatorKey.sign(payload);
        data.operatorSignature = signature;
        data.operatorTimestamp = timestamp;
      }
      const result: ToolPermissionAckResponse = await bridgeSend(
        "tool_permission_reset",
        data,
      );
      return result;
    },
  };
}
