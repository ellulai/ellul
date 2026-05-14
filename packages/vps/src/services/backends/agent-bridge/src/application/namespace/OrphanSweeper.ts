// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Bridge-startup sweep of orphaned agent subprocesses.
//
// When the bridge dies (SIGKILL, OOM kill, kernel panic, manual restart),
// the agent SDK subprocesses it spawned (opencode serves, claude SDK
// helpers, codex App Server, cursor-agent ACP) are reparented to PID 1.
// systemd's KillMode for the bridge unit is `process` (so anchors and
// sessions survive a graceful restart) — which means a hard kill leaves
// every adapter child running until the kernel reaps it. None of those
// processes know the bridge is gone, none of them exit, none of them get
// re-adopted on the next start. Within a few restart cycles a 2 GB box
// has 7+ opencode serves at 150 MB each, 3+ stale claude helpers, etc.,
// then OOM-kills critical services (sshd, then the kernel reboots).
//
// The fix is a one-shot sweep at bridge startup: list every agent binary
// owned by the service user whose parent is now PID 1 (orphaned), kill
// it. The bridge has just started, so no live session can own these —
// any process matching the criteria is from a dead predecessor.
//
// We DO NOT touch:
//   - processes whose PPID is the current bridge PID (live children)
//   - processes whose PPID points to anchor/setup scripts (pre-warmed
//     namespaces, intentionally long-lived)
//   - any binary outside the agent allowlist below

import { execSync } from "child_process";
import { logEvent, serializeError } from "../../shared/event-log";

// Strict allowlist: only these binaries get swept. Each entry is the
// canonical absolute path the bridge spawns (or, for codex, its native
// child binary path). Substrings of /proc/<pid>/cmdline are matched
// exactly. Anything else — system services, user shells, sshd, etc. —
// is untouched even if PPID is 1.
const SWEEPABLE_BINARIES: ReadonlyArray<string> = [
  // OpenCode serve daemons
  "/usr/local/libexec/ellul/opencode",
  "/usr/local/bin/opencode",
  // Claude SDK helper subprocess (Anthropic's claude binary)
  "/home/dev/.node/bin/claude",
  // Codex Node wrapper + Rust binary it execs
  "/home/dev/.node/bin/codex",
  "@openai/codex-linux-x64",
  "@openai/codex-linux-arm64",
  // Cursor ACP agent
  "/usr/local/bin/cursor-agent",
  "/usr/local/lib/cursor-agent/index.js",
];

// `opencode serve` daemons live INSIDE per-project namespaces, spawned
// through the namespace anchor. Their PPID at host level resolves to
// the anchor (long-lived, intentionally outlives the bridge), not PID 1
// — so the PPID-based filter above wouldn't match them. At bridge
// startup we know the new pool has zero live entries, so any
// `opencode serve` process owned by the service user is from a previous
// bridge incarnation and must be reaped to free its ~240 MB Bun
// footprint. Match against the canonical `serve --hostname=...
// --port=N` argv shape so we never touch one-shot probes (e.g.
// `opencode --version`).
const OPENCODE_SERVE_REGEX = /\bopencode\s+serve\b/;

// Same situation for `cursor-agent acp`: spawned per project namespace
// through the anchor, PPID resolves to the anchor (not PID 1). At
// bridge startup the cursor pool is empty, so any cursor-agent matching
// the canonical pool spawn shape is a leftover from a prior bridge and
// must be reaped before the new pool starts spawning fresh ones.
//
// The canonical argv (built by buildCursorAcpSpawnInput) is exactly
// `<binary> acp` or `<binary> -e <endpoint> acp`. We anchor the
// `cursor-agent` identifier to a binary segment (preceded by `/` or
// start-of-line) so a stray flag like `--cursor-agent-foo` can't
// accidentally match. Then we accept either the bare `acp` final
// argument or the `-e <endpoint> acp` form, with the `acp` token at
// the end of the cmdline. This excludes one-shot probes
// (`cursor-agent about --format json`, `cursor-agent --version`).
const CURSOR_AGENT_ACP_REGEX =
  /(?:^|\/)cursor-agent\b(?:\s+-e\s+\S+)?\s+acp\b\s*$/m;

// `zeroclaw daemon` matches the same situation: spawned per-project
// inside the namespace anchor, host PPID resolves to the anchor (not
// PID 1), so the standard PPID-based filter misses it. At bridge
// startup the new daemon pool has zero entries, so any zeroclaw
// daemon owned by SVC_USER is a leftover from a prior incarnation
// and must be reaped before the pool tries to bind the same port.
//
// We anchor `zeroclaw` to a binary segment (preceded by `/` or
// start-of-line) so a stray `--zeroclaw-foo` flag can't accidentally
// match, then require the literal `daemon` subcommand. This excludes
// one-shot probes (`zeroclaw --version`, `zeroclaw chat`).
const ZEROCLAW_DAEMON_REGEX = /(?:^|\/)zeroclaw\b\s+daemon\b/m;

interface ProcessInfo {
  readonly pid: number;
  readonly ppid: number;
  readonly cmdline: string;
  readonly user: string;
}

function listProcesses(): Array<ProcessInfo> {
  // ps output is more portable than walking /proc on systems that
  // restrict /proc visibility (we run with hidepid=2). The bridge runs
  // as the service user; its own /proc/<pid> entries are visible.
  try {
    const out = execSync("ps -eo pid,ppid,user,cmd --no-headers", {
      encoding: "utf8",
      timeout: 5000,
    });
    return out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
        if (!match) return null;
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          user: match[3]!,
          cmdline: match[4]!,
        } satisfies ProcessInfo;
      })
      .filter((info): info is ProcessInfo => info !== null);
  } catch (err) {
    logEvent("orphan.sweep.list.fail", serializeError(err));
    return [];
  }
}

function isSweepable(cmdline: string): boolean {
  return SWEEPABLE_BINARIES.some((needle) => cmdline.includes(needle));
}

export function sweepOrphanedAgentProcesses(): void {
  const currentPid = process.pid;
  const startedAt = Date.now();
  const processes = listProcesses();
  if (processes.length === 0) {
    logEvent("orphan.sweep.skip", { reason: "ps-empty" });
    return;
  }

  // Build a set of "live ancestor" PIDs we must NOT touch:
  //   - the bridge itself (current PID)
  //   - the bridge's spawned namespace anchors (under /run/.ns-<project>/)
  //
  // Anchors are children of systemd (PPID=1) but they are intentionally
  // long-lived and shared across bridge restarts. They are easy to
  // identify by cmdline (`unshare ... ns-anchor`). We add their PIDs to
  // the live-ancestor set so any agent process that was spawned through
  // an anchor is preserved if it is still in use — but that is actually
  // never the case at bridge startup: every adapter creates its agent
  // session AFTER startSession is called by the user, so at the moment
  // this sweep runs, the only agent processes alive are leftovers.
  const liveAncestors = new Set<number>([currentPid, 1]);

  let swept = 0;
  let preserved = 0;
  let sweptOpenCodeServe = 0;
  let sweptCursorAgentAcp = 0;
  let sweptZeroClawDaemon = 0;
  const sweptPids: Array<number> = [];
  const svcUser = process.env.SVC_USER;

  // Hard guard for the opencode-serve / cursor-agent sweep: SVC_USER
  // MUST be set so we can constrain reaping to processes owned by THIS
  // bridge's service user. Without it we'd happily SIGTERM an opencode
  // serve or cursor-agent some other user (or operator on a shared box)
  // started for diagnostic work. The namespace-spawned bridge ALWAYS
  // has SVC_USER from systemd; if it's unset we're either in an
  // unsupported deployment or someone is running the bridge by hand —
  // log loudly and skip the namespaced branches rather than risk a
  // wrong kill.
  const opencodeSweepSafe = typeof svcUser === "string" && svcUser.length > 0;
  if (!opencodeSweepSafe) {
    logEvent("orphan.sweep.opencode.skipped", {
      reason: "SVC_USER unset; refusing to sweep opencode serve without owner constraint",
    });
    logEvent("orphan.sweep.cursor.skipped", {
      reason: "SVC_USER unset; refusing to sweep cursor-agent acp without owner constraint",
    });
    logEvent("orphan.sweep.zeroclaw.skipped", {
      reason: "SVC_USER unset; refusing to sweep zeroclaw daemon without owner constraint",
    });
  }

  for (const proc of processes) {
    // Special case: `opencode serve` daemons inside namespaces have a
    // PPID chain that doesn't bottom out at PID 1, so the standard
    // sweepable check below misses them. At bridge startup the pool has
    // zero entries — any `opencode serve` owned by the service user is
    // a leftover from a prior incarnation. Kill before the pool starts
    // spawning fresh ones.
    if (OPENCODE_SERVE_REGEX.test(proc.cmdline)) {
      if (!opencodeSweepSafe) continue;
      if (proc.user !== svcUser) continue;
      if (liveAncestors.has(proc.pid)) continue;
      if (proc.ppid === currentPid) {
        // The bridge just started; we don't have any live opencode
        // children yet. This branch is defense-in-depth — should never
        // happen at startup.
        preserved++;
        continue;
      }
      try {
        process.kill(proc.pid, "SIGTERM");
        sweptPids.push(proc.pid);
        swept++;
        sweptOpenCodeServe++;
      } catch {
        // ESRCH / EPERM — fine.
      }
      continue;
    }

    // Same handling for `cursor-agent ... acp`: spawned per-project
    // through the namespace anchor, so PPID-based detection misses it.
    // At bridge startup the cursor pool is empty — any cursor-agent
    // matching the canonical `acp` argv shape is a leftover. Reap
    // before the new pool starts spawning.
    if (CURSOR_AGENT_ACP_REGEX.test(proc.cmdline)) {
      if (!opencodeSweepSafe) continue;
      if (proc.user !== svcUser) continue;
      if (liveAncestors.has(proc.pid)) continue;
      if (proc.ppid === currentPid) {
        preserved++;
        continue;
      }
      try {
        process.kill(proc.pid, "SIGTERM");
        sweptPids.push(proc.pid);
        swept++;
        sweptCursorAgentAcp++;
      } catch {
        // ESRCH / EPERM — fine.
      }
      continue;
    }

    // Same handling for `zeroclaw daemon`: spawned per-project through
    // the namespace anchor, PPID resolves to the anchor (not PID 1).
    // The new daemon pool has zero entries at bridge startup, so any
    // zeroclaw daemon owned by SVC_USER is a leftover that holds its
    // port (18800-18899) and would force every fresh spawn into an
    // EADDRINUSE loop until the OS reaped it. Kill before the new
    // pool tries to allocate.
    if (ZEROCLAW_DAEMON_REGEX.test(proc.cmdline)) {
      if (!opencodeSweepSafe) continue;
      if (proc.user !== svcUser) continue;
      if (liveAncestors.has(proc.pid)) continue;
      if (proc.ppid === currentPid) {
        preserved++;
        continue;
      }
      try {
        process.kill(proc.pid, "SIGTERM");
        sweptPids.push(proc.pid);
        swept++;
        sweptZeroClawDaemon++;
      } catch {
        // ESRCH / EPERM — fine.
      }
      continue;
    }

    if (!isSweepable(proc.cmdline)) continue;
    if (liveAncestors.has(proc.pid)) continue;
    // Only sweep agent processes whose parent is PID 1 (dead bridge
    // reparented them) OR whose parent is a daemon-like systemd-run
    // descendant. The current bridge PID is not yet in PPID chain for
    // anything (we haven't spawned a session yet).
    if (proc.ppid !== 1 && !liveAncestors.has(proc.ppid)) continue;
    if (proc.ppid === currentPid) {
      preserved++;
      continue;
    }
    try {
      process.kill(proc.pid, "SIGTERM");
      sweptPids.push(proc.pid);
      swept++;
    } catch {
      // ESRCH (already gone) and EPERM (not ours) are both fine — log
      // and continue.
    }
  }

  // Give SIGTERM 500 ms to land, then SIGKILL stragglers.
  if (sweptPids.length > 0) {
    setTimeout(() => {
      for (const pid of sweptPids) {
        try {
          process.kill(pid, 0); // alive?
          process.kill(pid, "SIGKILL");
        } catch {
          // already dead — fine
        }
      }
    }, 500);
  }

  logEvent("orphan.sweep.done", {
    swept,
    preserved,
    sweptOpenCodeServe,
    sweptCursorAgentAcp,
    sweptZeroClawDaemon,
    durationMs: Date.now() - startedAt,
    sweptPids,
  });
}
