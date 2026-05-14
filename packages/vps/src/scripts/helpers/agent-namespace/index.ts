// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Per-Project Agent Namespace Script
 *
 * Privileged helper deployed to /usr/local/bin/ellul-agent-namespace.
 * Called via sudo by agent-bridge to manage persistent namespaces per project.
 *
 * Modes:
 *   setup <project>                    — Create persistent namespace (once per project)
 *   enter <project> [opts] -- <cmd>    — Fast nsenter into existing namespace
 *   teardown <project>                 — Destroy namespace and clean up
 *   spawn <project> [opts] <cmd>       — One-shot namespace (creates fresh per invocation)
 *
 * Persistent Namespace Architecture:
 *   Instead of creating a fresh namespace per command (expensive, ~45s on ARM,
 *   concurrent collisions on veth), we create ONE persistent namespace per project
 *   at startup. All subsequent exec calls use nsenter (~<50ms) to enter it.
 *
 *   setup: unshare -> Phases 0-4 -> signal readiness -> sleep infinity (anchor)
 *   enter: nsenter into anchor PID -> source env -> runuser -> exec command
 *   teardown: iptables cleanup -> kill anchor -> clean artifacts
 *
 * DEFAULT-DENY Architecture:
 *   The entire home directory is mounted read-only FIRST, then specific
 *   writable exceptions are layered on top. This is mathematically provable
 *   isolation -- anything not explicitly allowed is denied.
 *
 * Isolation layers:
 *   1. Mount namespace: agent only sees its own project directory
 *   2. PID namespace: agent can only see its own processes
 *   3. Home read-only: entire $SVC_HOME is read-only by default
 *   4. Writable exceptions: only project dir, thread dir
 *   5. Overlayfs layers: .config, .claude, .cursor, .ellul get live reads
 *      from real filesystem with ephemeral writes (discarded on exit)
 *   6. Thread isolation: each thread's CLI state is isolated from other threads
 *   7. tmpfs overlays: shield-data, shielded vaults, IPC token all hidden
 *   8. Cross-project read: source-code-only SNAPSHOT at .shared/<name>
 *      (filtered copy -- .env*, credentials, configs never copied, physically absent)
 *   9. Cross-project preview: scoped DNAT to shared project's preview port
 *      (agent interacts via HOST_IP:port, .preview-url file in .shared/<name>)
 */

export { getNsShellScript } from './ns-shell';

import skeleton from '@vps/templates/helpers/agent-namespace/agent-namespace.sh';
import { validationBlock } from './validation';
import { setupBlock, enterBlock, teardownBlock, spawnBlock } from './lifecycle';

export function getAgentNamespaceScript(): string {
  return skeleton
    .replace('__VALIDATION__', () => validationBlock())
    .replace('__SETUP__', () => setupBlock())
    .replace('__ENTER__', () => enterBlock())
    .replace('__TEARDOWN__', () => teardownBlock())
    .replace('__SPAWN__', () => spawnBlock());
}
