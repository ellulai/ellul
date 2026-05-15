// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { GrokSettings } from "../../../shared/serverSettings";
import type { AcpSpawnInput } from "../../cursor/acp/AcpSessionRuntime";

type GrokAcpRuntimeGrokSettings = Pick<GrokSettings, "binaryPath">;

export function buildGrokAcpSpawnInput(
  grokSettings: GrokAcpRuntimeGrokSettings | null | undefined,
  cwd: string,
  additionalEnv?: Readonly<Record<string, string>>,
): AcpSpawnInput {
  return {
    command: grokSettings?.binaryPath || "grok",
    args: ["agent", "stdio"],
    cwd,
    ...(additionalEnv ? { env: additionalEnv } : {}),
  };
}
