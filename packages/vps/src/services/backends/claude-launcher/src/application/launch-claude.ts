// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Launcher use case: exchange CLAUDE_OAT_ISSUANCE_TOKEN for the actual
// OAT, then execve into ellul-claude-ns. Each phase emits a trace line.

import { claudeLaunchTrace } from "../../../../shared/claude-launch-trace";
import {
  buildExecEnv,
  isValidIssuanceToken,
} from "../domain/exec-plan";
import type {
  Executor,
  FailureReporter,
  IpcTokenReader,
  ShieldRedeemClient,
} from "./ports";

export interface LaunchClaudeInput {
  readonly inheritedEnv: NodeJS.ProcessEnv;
  readonly claudeArgs: readonly string[];
  readonly nsWrapperBinary: string;
  readonly traceId: string;
}

export interface LaunchClaudeDeps {
  readonly ipcTokenReader: IpcTokenReader;
  readonly redeemClient: ShieldRedeemClient;
  readonly executor: Executor;
  readonly fail: FailureReporter;
}

export async function launchClaude(
  deps: LaunchClaudeDeps,
  input: LaunchClaudeInput,
): Promise<never> {
  const tr = input.traceId;
  const issuanceToken = input.inheritedEnv.CLAUDE_OAT_ISSUANCE_TOKEN;
  if (!isValidIssuanceToken(issuanceToken)) {
    claudeLaunchTrace("launcher", tr, "token-invalid", {
      hasToken: Boolean(issuanceToken),
      tokenLen: issuanceToken?.length ?? 0,
    });
    deps.fail.fail(
      2,
      "CLAUDE_OAT_ISSUANCE_TOKEN env var missing or malformed (expected 32 hex chars). Bridge must mint an issuance token before spawning the launcher.",
    );
  }
  claudeLaunchTrace("launcher", tr, "token-validated", {
    tokenLen: issuanceToken!.length,
  });

  let serviceToken: string;
  const ipcStartedAt = Date.now();
  try {
    serviceToken = deps.ipcTokenReader.read();
  } catch (err) {
    claudeLaunchTrace("launcher", tr, "ipc-token-read-fail", {
      latencyMs: Date.now() - ipcStartedAt,
      error: (err as Error).message,
      errno: (err as NodeJS.ErrnoException).code ?? null,
    });
    deps.fail.fail(
      3,
      `Cannot read shield IPC token: ${(err as Error).message}. Ensure the launcher's process inherits the shield-ipc supplementary group from agent-bridge.`,
    );
  }
  claudeLaunchTrace("launcher", tr, "ipc-token-read-ok", {
    latencyMs: Date.now() - ipcStartedAt,
    serviceTokenLen: serviceToken.length,
  });

  let oat: string;
  const redeemStartedAt = Date.now();
  claudeLaunchTrace("launcher", tr, "redeem-start", {});
  try {
    oat = await deps.redeemClient.redeem(issuanceToken!, serviceToken);
  } catch (err) {
    claudeLaunchTrace("launcher", tr, "redeem-fail", {
      latencyMs: Date.now() - redeemStartedAt,
      error: (err as Error).message,
    });
    deps.fail.fail(
      4,
      `OAT redeem failed: ${(err as Error).message}. The issuance token may have expired (60s TTL) or already been redeemed (single-use).`,
    );
  }
  claudeLaunchTrace("launcher", tr, "redeem-ok", {
    latencyMs: Date.now() - redeemStartedAt,
    oatLen: oat.length,
    oatPrefix: oat.slice(0, 12),
  });

  const env = buildExecEnv(input.inheritedEnv, oat);
  claudeLaunchTrace("launcher", tr, "execve", {
    target: input.nsWrapperBinary,
    argc: input.claudeArgs.length,
    envHasOat: Boolean(env.CLAUDE_CODE_OAUTH_TOKEN),
    envHasNsProject: Boolean(env.ELLUL_NS_PROJECT),
    envDroppedIssuance: !env.CLAUDE_OAT_ISSUANCE_TOKEN,
  });
  deps.executor.exec(input.nsWrapperBinary, input.claudeArgs, env);
}
