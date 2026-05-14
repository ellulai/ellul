// SPDX-License-Identifier: MIT

import type { ContextModeResponse } from "@ellul.ai/vps/auth/bridge-contracts";
import type { OperatorKeyApi } from "./operator-key";
import type { BridgeSender } from "./gate-client";

export type ContextMode = "base" | "preview" | "deploy";

export interface ContextModeClient {
  getContextMode(project: string): Promise<{ mode: ContextMode }>;
  setContextMode(
    project: string,
    mode: ContextMode,
  ): Promise<{ mode: ContextMode }>;
}

export interface ContextModeClientError extends Error {
  status?: number;
}

// Routes through the iframe bridge — the console origin has no PoP
// Service Worker, so direct fetch returns 401 missing_pop_headers. The
// bridge SW at {srv}.ellul.ai signs every request. Operator signature
// payload format must mirror sovereign-shield's context.routes.ts
// construction; the bridge transports it unchanged so the signature
// (which covers the canonical payload string) cannot be tampered.
export function makeContextModeClient(
  _serverDomain: string,
  operatorKey: OperatorKeyApi,
  bridgeSend: BridgeSender,
  isLockedTier: boolean,
): ContextModeClient {
  return {
    async getContextMode(project) {
      const result: ContextModeResponse = await bridgeSend("context_mode_get", {
        project,
      });
      return { mode: result.mode };
    },

    async setContextMode(project, mode) {
      const data: Record<string, unknown> = { project, mode };
      if (isLockedTier) {
        const payload = new TextEncoder().encode(`context-mode|${project}|${mode}`);
        const { signature, timestamp } = await operatorKey.sign(payload);
        data.operatorSignature = signature;
        data.operatorTimestamp = timestamp;
      }
      const result: ContextModeResponse = await bridgeSend("context_mode_set", data);
      return { mode: result.mode };
    },
  };
}
