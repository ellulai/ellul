// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Minimal ServerConfig stub — fields consumed by ported t3code adapters.
// Real t3code has a richer `ServerConfig` context service; we provide just
// what the vendored adapters read at startSession/sendTurn time.

import { Context } from "effect";
import * as os from "node:os";
import * as path from "node:path";

export function safeCwd(): string {
  try { return process.cwd(); } catch { return process.env.HOME ?? "/home/dev"; }
}

export interface ServerConfigShape {
  readonly attachmentsDir: string;
  readonly cwd: string;
  readonly svcHome: string;
  readonly providerEventLogPath?: string;
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "ellul/shared/ServerConfig",
) {}

export const defaultServerConfig: ServerConfigShape = {
  attachmentsDir: path.join(os.homedir(), ".ellul", "attachments"),
  cwd: safeCwd(),
  svcHome: process.env.HOME ?? os.homedir(),
};
