// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Static per-sandbox agent-token auth for B2B "Sandbox-as-a-Service" mode.
//
// A tenant sandbox is provisioned with a single high-entropy agent token,
// injected by the provisioning tenant profile (D5) to a root-owned file
// readable by the bridge + file-api service user (default /etc/ellul/agent-token,
// override AGENT_TOKEN_PATH). Its presence is the signal that this instance runs
// in tenant mode; first-party servers never have it (they use sovereign-shield).
//
// Both the agent-bridge (WS `?_agent_token=`) and file-api (`Authorization:
// Bearer`) validate the same token here, constant-time. This replaces the
// shield passkey/PoP/forward-auth envelope (which is for ellul.ai's own human
// users) with a headless M2M-appropriate check; the Incus micro-VM remains the
// isolation boundary.

import * as fs from "fs";
import * as crypto from "crypto";

const TOKEN_PATH = process.env.AGENT_TOKEN_PATH || "/etc/ellul/agent-token";

let cached: { token: string; mtimeMs: number } | null = null;

/** Read the injected tenant agent token, or null when not in tenant mode. */
export function readTenantAgentToken(): string | null {
  try {
    const stat = fs.statSync(TOKEN_PATH);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.token;
    const token = fs.readFileSync(TOKEN_PATH, "utf8").trim();
    if (!token) {
      cached = null;
      return null;
    }
    cached = { token, mtimeMs: stat.mtimeMs };
    return token;
  } catch {
    cached = null;
    return null;
  }
}

/** True iff this instance runs in B2B tenant mode (a static agent token is present). */
export function isTenantMode(): boolean {
  return readTenantAgentToken() !== null;
}

/** Constant-time compare of a presented token against the injected tenant token. */
export function verifyTenantAgentToken(presented: string | null | undefined): boolean {
  if (!presented) return false;
  const expected = readTenantAgentToken();
  if (!expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Avoid a length oracle: take the same time as a real compare.
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}
