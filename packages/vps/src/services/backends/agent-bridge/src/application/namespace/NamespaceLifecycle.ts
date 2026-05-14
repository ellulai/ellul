// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.
//
// Pre-warms per-project namespaces and reaps idle pool entries on a
// tier-aware cadence. Sizing constants live in `@vps/shared/memory-budget`;
// never inline a TTL here.

import * as fs from "fs";
import * as os from "node:os";
import { computeAdapterPoolProfile } from "@vps/shared/memory-budget";
import { PROJECT_NAME_RE, PROJECTS_DIR } from "../../config";
import { logEvent, serializeError } from "../../shared/event-log";
import { join } from "path";
import {
  isNamespaceAvailable,
  isNamespaceRunning,
  setupNamespace,
} from "./NamespaceSpawn";
import { writeMcpConfigs } from "../reconciliation/ZeroclawAgent";
import {
  EllulNamespacedClient,
  isNsdClientEnabled,
} from "./EllulNamespacedClient";
import {
  sweepCursorIdleAgents,
  sweepOpenCodeIdleServers,
  sweepZeroClawIdleDaemons,
} from "../../adapters/runtime";
import {
  makeCgroupHygieneAssertion,
  type CgroupHygieneAssertionShape,
} from "../runtime-control/CgroupHygieneAssertion";

const POOL_PROFILE = computeAdapterPoolProfile(
  Math.max(512, Math.round(os.totalmem() / (1024 * 1024))),
);
const RECONCILE_INTERVAL_MS = POOL_PROFILE.reconcileIntervalMs;
const OPENCODE_IDLE_TTL_MS = POOL_PROFILE.opencodeIdleTtlMs;
const CURSOR_IDLE_TTL_MS = POOL_PROFILE.cursorIdleTtlMs;
const ZEROCLAW_IDLE_TTL_MS = POOL_PROFILE.zeroclawIdleTtlMs;

let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let reconciling = false;

// Cgroup hygiene assertion. Runs on every reconcile tick so we only carry
// one timer. Module-instantiated so the firstSeen tracker persists across
// ticks (sustained > 30 s escalates to CRITICAL). No-op on non-Linux /
// non-cgroup-v2 / dev hosts where resolveCgroupAbsolutePath returns null.
const cgroupHygiene: CgroupHygieneAssertionShape = makeCgroupHygieneAssertion();

function getDesiredProjects(): string[] {
  try {
    return fs.readdirSync(PROJECTS_DIR).filter((d) => PROJECT_NAME_RE.test(d));
  } catch {
    return [];
  }
}

async function reconcile(): Promise<void> {
  if (reconciling || !isNamespaceAvailable()) return;
  reconciling = true;
  const startedAt = Date.now();
  let warm = 0;
  let cold = 0;
  let failed = 0;
  try {
    const projects = getDesiredProjects();
    for (const project of projects) {
      if (isNamespaceRunning(project)) {
        warm++;
        continue;
      }
      cold++;
      try {
        await setupNamespace(project);
        writeMcpConfigs(join(PROJECTS_DIR, project), project);
        console.log(`[Lifecycle] Pre-warmed namespace for ${project}`);
      } catch (err) {
        failed++;
        logEvent("ns.lifecycle.prewarmFail", { project, ...serializeError(err) });
        console.warn(
          `[Lifecycle] Pre-warm failed for ${project}:`,
          (err as Error).message,
        );
      }
    }

    // Reap idle OpenCode pool servers. Cheap (in-memory map walk) and
    // tied to the same tick so we don't have to run a second timer.
    let opencodeSweep: { readonly evicted: number; readonly retained: number } = {
      evicted: 0,
      retained: 0,
    };
    try {
      opencodeSweep = await sweepOpenCodeIdleServers(OPENCODE_IDLE_TTL_MS);
    } catch (err) {
      logEvent("opencode.serverPool.sweepError", serializeError(err));
    }

    // Same idle reaping for the Cursor ACP pool. Same tick, same
    // tradeoff: per-project cursor-agent processes get reaped after the
    // configured TTL.
    let cursorSweep: { readonly evicted: number; readonly retained: number } = {
      evicted: 0,
      retained: 0,
    };
    try {
      cursorSweep = await sweepCursorIdleAgents(CURSOR_IDLE_TTL_MS);
    } catch (err) {
      logEvent("cursor.serverPool.sweepError", serializeError(err));
    }

    // Same idle reaping for the ZeroClaw daemon pool. Closes the loop
    // on the orphan-daemon regression: even if a session.release was
    // missed (e.g. bridge crash), the next reconcile tick will reap
    // any daemon whose refCount has been zero past the TTL.
    let zeroclawSweep: { readonly evicted: number; readonly retained: number } = {
      evicted: 0,
      retained: 0,
    };
    try {
      zeroclawSweep = await sweepZeroClawIdleDaemons(ZEROCLAW_IDLE_TTL_MS);
    } catch (err) {
      logEvent("zeroclaw.daemonPool.sweepError", serializeError(err));
    }

    // Cgroup hygiene check on the same tick. Read-only; runs off the
    // bridge's own /proc + /sys/fs/cgroup. Any PID in the bridge cgroup
    // that isn't bridge-self or a transient sudo→spawn-scope→systemd-run
    // wrapper triggers a violation event (WARN on first detection,
    // CRITICAL when sustained). Failures here are swallowed — hygiene
    // is observability, never load-bearing.
    let hygieneViolations = 0;
    let hygieneCritical = 0;
    try {
      const violations = await cgroupHygiene.check();
      hygieneViolations = violations.length;
      hygieneCritical = violations.filter((v) => v.severity === "critical").length;
    } catch (err) {
      logEvent("bridge.cgroup.checkError", serializeError(err));
    }

    logEvent("ns.lifecycle.reconcile", {
      warm,
      cold,
      failed,
      total: projects.length,
      durationMs: Date.now() - startedAt,
      opencodeEvicted: opencodeSweep.evicted,
      opencodeRetained: opencodeSweep.retained,
      cursorEvicted: cursorSweep.evicted,
      cursorRetained: cursorSweep.retained,
      zeroclawEvicted: zeroclawSweep.evicted,
      zeroclawRetained: zeroclawSweep.retained,
      hygieneViolations,
      hygieneCritical,
    });
  } finally {
    reconciling = false;
  }
}

/**
 * Idempotent: no-op if the namespace is already running, full setup
 * otherwise. Safe to fire-and-forget — failures are logged.
 */
export async function prewarmProjectNamespace(project: string): Promise<void> {
  if (!isNamespaceAvailable()) {
    logEvent("ns.lifecycle.prewarm.skip", {
      project,
      reason: "namespace-script-missing",
    });
    return;
  }
  if (!PROJECT_NAME_RE.test(project)) {
    logEvent("ns.lifecycle.prewarm.skip", { project, reason: "invalid-project-name" });
    return;
  }
  if (isNamespaceRunning(project)) {
    logEvent("ns.lifecycle.prewarm.alreadyWarm", { project });
    return;
  }
  const startedAt = Date.now();
  try {
    await setupNamespace(project);
    logEvent("ns.lifecycle.prewarm.done", {
      project,
      durationMs: Date.now() - startedAt,
    });
    /* Observe-only attest after a successful prewarm. Fire-and-forget on
     * a 5s delay so the namespace anchor's stale-check window passes;
     * ATTEST failures here are pure observability, never block. */
    if (isNsdClientEnabled()) {
      setTimeout(() => {
        void runShadowAttest(project);
      }, 5_000).unref?.();
    }
  } catch (err) {
    logEvent("ns.lifecycle.prewarm.fail", {
      project,
      durationMs: Date.now() - startedAt,
      ...serializeError(err),
    });
  }
}

/**
 * Shadow attest. Fires after every successful prewarm; emits
 * `nsd.attest.{ok|mismatch|unreachable}` events. Never throws — caller
 * uses `void runShadowAttest(...)`.
 */
async function runShadowAttest(project: string): Promise<void> {
  const client = await EllulNamespacedClient.tryConnect(project);
  if (!client) return;
  try {
    const res = await client.attest();
    if (!res.ok) {
      logEvent("nsd.attest.unreachable", {
        project,
        errcode: res.errcode ?? null,
        errorMessage: res.errorMessage ?? null,
      });
      return;
    }
    if (res.matches) {
      logEvent("nsd.attest.ok", {
        project,
        mountinfoDigest: res.mountinfoDigest ?? null,
      });
    } else {
      logEvent("nsd.attest.mismatch", {
        project,
        nMismatches: res.mismatches?.length ?? 0,
        firstMismatch: res.mismatches?.[0] ?? null,
        mountinfoDigest: res.mountinfoDigest ?? null,
      });
    }
  } catch (err) {
    logEvent("nsd.attest.unreachable", {
      project,
      ...serializeError(err),
    });
  } finally {
    client.close();
  }
}

export function startNamespaceLifecycle(): void {
  if (!isNamespaceAvailable()) {
    logEvent("ns.lifecycle.skip", { reason: "namespace-script-missing" });
    console.log("[Lifecycle] Namespace isolation not available — skipping");
    return;
  }
  const projects = getDesiredProjects();
  logEvent("ns.lifecycle.start", {
    projectCount: projects.length,
    intervalMs: RECONCILE_INTERVAL_MS,
    poolProfile: POOL_PROFILE,
  });
  console.log(
    `[Lifecycle] Starting reconciliation for ${projects.length} project(s)`,
  );
  reconcile().catch((err) =>
    console.warn("[Lifecycle] Initial reconcile error:", (err as Error).message),
  );
  reconcileTimer = setInterval(() => {
    reconcile().catch((err) =>
      console.warn("[Lifecycle] Reconcile error:", (err as Error).message),
    );
  }, RECONCILE_INTERVAL_MS);
  if (reconcileTimer.unref) reconcileTimer.unref();
}

export function stopNamespaceLifecycle(): void {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}

/** Fire-and-forget reconcile request. Idempotent. */
export function triggerImmediateReconcile(): void {
  // setImmediate decouples from caller's stack so a slow setupNamespace
  // can't back-pressure the projection commit.
  setImmediate(() => {
    reconcile().catch((err) =>
      logEvent("ns.lifecycle.triggerError", serializeError(err)),
    );
  });
}
