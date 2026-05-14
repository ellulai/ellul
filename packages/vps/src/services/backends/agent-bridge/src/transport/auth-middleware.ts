// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { IncomingMessage } from "http";

import { extractAgentToken, validateAgentToken, verifyPopChallenge } from "../auth";

export interface AuthGateSuccess {
  readonly ok: true;
  readonly sessionId: string;
}

export interface AuthGateFailure {
  readonly ok: false;
  readonly code: number;
  readonly reason: string;
}

export type AuthGateResult = AuthGateSuccess | AuthGateFailure;

export async function gateWsUpgrade(req: IncomingMessage): Promise<AuthGateResult> {
  const token = extractAgentToken(req.url);
  if (!token) return { ok: false, code: 401, reason: "missing agent token" };
  const { valid, sessionId } = await validateAgentToken(token);
  if (!valid || !sessionId) return { ok: false, code: 401, reason: "invalid agent token" };
  return { ok: true, sessionId };
}

export interface PopVerdict {
  readonly valid: boolean;
  readonly hostile: boolean;
  readonly reason?: string;
}

export async function gatePopChallenge(
  sessionId: string,
  challenge: string,
  signature: string,
): Promise<PopVerdict> {
  const result = await verifyPopChallenge(sessionId, challenge, signature);
  if (result.valid) return { valid: true, hostile: false };
  const reason = result.reason ?? "unknown";
  const hostile = reason === "signature_invalid" || reason === "nonce_reused";
  return { valid: false, hostile, reason };
}
