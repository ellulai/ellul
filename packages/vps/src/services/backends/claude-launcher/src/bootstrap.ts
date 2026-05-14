// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Composition root for the Claude OAT injection launcher.
 *
 * Wires production infrastructure adapters (FS token reader, HTTP redeem
 * client, execFileSync executor, stderr fail reporter) into the
 * launchClaude use case. The launcher's main.ts calls this once and
 * runs the use case.
 */

import { launchClaude, type LaunchClaudeDeps } from "./application/launch-claude";
import { FsIpcTokenReader } from "./infrastructure/fs-ipc-token-reader";
import { HttpShieldRedeemClient } from "./infrastructure/http-shield-redeem.client";
import {
  ExecFileSyncExecutor,
  StderrFailureReporter,
} from "./infrastructure/execve-executor";

const SHIELD_IPC_TOKEN_PATH = "/run/shield/internal-agent-bridge.token";
const NS_WRAPPER_BINARY = "/usr/local/bin/ellul-claude-ns";

export interface LauncherConfig {
  readonly tokenPath?: string;
  readonly nsWrapperBinary?: string;
}

export function buildLauncher(config: LauncherConfig = {}): {
  deps: LaunchClaudeDeps;
  nsWrapperBinary: string;
} {
  const fail = new StderrFailureReporter();
  return {
    deps: {
      ipcTokenReader: new FsIpcTokenReader(
        config.tokenPath ?? SHIELD_IPC_TOKEN_PATH,
      ),
      redeemClient: new HttpShieldRedeemClient(),
      executor: new ExecFileSyncExecutor(fail),
      fail,
    },
    nsWrapperBinary: config.nsWrapperBinary ?? NS_WRAPPER_BINARY,
  };
}

export { launchClaude };
