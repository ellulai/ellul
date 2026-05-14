// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Single chokepoint that pairs the launcher binary path with a freshly-
// minted OAT issuance token + ELLUL_NS_PROJECT + traceId.

import { randomBytes } from "node:crypto";

import type { ThreadId } from "@ellul.ai/types";

import {
  CLAUDE_LAUNCH_TRACE_ENV,
  claudeLaunchTrace,
} from "../../../../../shared/claude-launch-trace";
import { getClaudeOatBridgeModule } from "../../credentials/claude-oat/public";
import type { ClaudeAgentSettings } from "../../shared/serverSettings";

export interface LaunchEnv {
  readonly launcherPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly oatStateAtIssuance: string;
  readonly traceId: string;
}

export interface MintLaunchEnvInput {
  readonly threadId: ThreadId | string;
  readonly projectId: string;
  readonly settings: ClaudeAgentSettings;
  readonly mode: "pro" | "lite" | "thread-title";
}

// Returns null when shield is unreachable; caller surfaces a process error.
export async function mintLaunchEnv(
  input: MintLaunchEnvInput,
): Promise<LaunchEnv | null> {
  const traceId = randomBytes(8).toString("hex");
  const startedAt = Date.now();
  const oatModule = getClaudeOatBridgeModule();
  claudeLaunchTrace("bridge", traceId, "oat-issue-start", {
    mode: input.mode,
    projectId: input.projectId,
    threadId: String(input.threadId),
  });

  let issuance: Awaited<ReturnType<typeof oatModule.issueToken>>;
  try {
    issuance = await oatModule.issueToken({
      threadId: input.threadId as string,
      project: input.projectId,
    });
  } catch (err) {
    claudeLaunchTrace("bridge", traceId, "oat-issue-throw", {
      latencyMs: Date.now() - startedAt,
      error: (err as Error).message,
    });
    return null;
  }
  if (!issuance) {
    claudeLaunchTrace("bridge", traceId, "oat-issue-null", {
      latencyMs: Date.now() - startedAt,
    });
    return null;
  }
  claudeLaunchTrace("bridge", traceId, "oat-issue-ok", {
    latencyMs: Date.now() - startedAt,
    state: issuance.state,
    issuanceLen: issuance.issuanceToken.length,
    expiresAt: issuance.expiresAt,
  });

  // Redeem the issuance token for the actual OAT in-process.
  // Previously the launcher (a separate Node.js process) did this via
  // execFileSync, adding an extra process layer that broke the SDK's
  // stdin/stdout pipe delivery. Redeeming here keeps the spawn chain
  // identical to Codex: SDK → claude-ns.sh → exec sudo → namespace.
  const redeemStartedAt = Date.now();
  let oat: string | null;
  try {
    oat = await oatModule.redeemToken(issuance.issuanceToken);
  } catch (err) {
    claudeLaunchTrace("bridge", traceId, "oat-redeem-throw", {
      latencyMs: Date.now() - redeemStartedAt,
      error: (err as Error).message,
    });
    return null;
  }
  if (!oat) {
    claudeLaunchTrace("bridge", traceId, "oat-redeem-null", {
      latencyMs: Date.now() - redeemStartedAt,
    });
    return null;
  }
  claudeLaunchTrace("bridge", traceId, "oat-redeem-ok", {
    latencyMs: Date.now() - redeemStartedAt,
    oatLen: oat.length,
  });

  return {
    launcherPath: input.settings.launcherPath,
    env: {
      ...process.env,
      ELLUL_NS_PROJECT: input.projectId,
      CLAUDE_CODE_OAUTH_TOKEN: oat,
      [CLAUDE_LAUNCH_TRACE_ENV]: traceId,
    },
    oatStateAtIssuance: issuance.state,
    traceId,
  };
}
