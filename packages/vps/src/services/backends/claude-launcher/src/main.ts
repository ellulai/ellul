// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// ellul-claude-launch — entry point. Composition root + use case
// invocation. Process image is replaced via execve into ellul-claude-ns
// after the OAT redeem; bridge never holds the token.

import {
  CLAUDE_LAUNCH_TRACE_ENV,
  claudeLaunchTrace,
} from "../../../shared/claude-launch-trace";
import { buildLauncher, launchClaude } from "./bootstrap";

async function main(): Promise<void> {
  const traceId = process.env[CLAUDE_LAUNCH_TRACE_ENV] ?? "no-trace";
  claudeLaunchTrace("launcher", traceId, "enter", {
    pid: process.pid,
    ppid: process.ppid,
    argc: process.argv.length - 2,
    hasIssuance: process.env.CLAUDE_OAT_ISSUANCE_TOKEN ? true : false,
    hasNsProject: process.env.ELLUL_NS_PROJECT ? true : false,
    nsProject: process.env.ELLUL_NS_PROJECT ?? null,
    user: process.env.USER ?? null,
    home: process.env.HOME ?? null,
  });
  const { deps, nsWrapperBinary } = buildLauncher();
  await launchClaude(deps, {
    inheritedEnv: process.env,
    claudeArgs: process.argv.slice(2),
    nsWrapperBinary,
    traceId,
  });
}

main().catch((err) => {
  const traceId = process.env[CLAUDE_LAUNCH_TRACE_ENV] ?? "no-trace";
  claudeLaunchTrace("launcher", traceId, "unhandled-error", {
    error: (err as Error).message,
  });
  process.stderr.write(
    `[ellul-claude-launch] unhandled error: ${
      (err as Error).stack ?? (err as Error).message
    }\n`,
  );
  process.exit(1);
});
