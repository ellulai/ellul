// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.
//
// Namespace-aware ChildProcessSpawner — replaces NodeChildProcessSpawner.layer
// in every adapter's platform layer. Guarantees no subprocess escapes the
// per-project namespace sandbox: every Command passes through the
// `sudo ellul-agent-namespace enter --project <p>` wrapper before exec.
//
// Fail-closed contract:
// - Every Command reaching .spawn() must carry `ELLUL_NS_PROJECT` in its
//   options.env. The value is either the sandbox id the process should live
//   in (`sbx-xxxxxxx`) or the explicit host-bypass sentinel
//   (NAMESPACE_HOST_SENTINEL) for host-level spawns like provider health
//   checks that must run outside any per-project namespace.
// - If missing, spawn fails with a PlatformError rather than invoking the
//   underlying Node spawner. Impossible for a vendored adapter to accidentally
//   bypass namespace isolation — either the adapter sets the env or nothing
//   runs. Bypassing the wrapper is an explicit, greppable opt-in.
//
// Rationale for env-sentinel over Context service: the spawner sits inside an
// Effect dependency graph with Scope-only requirements; adding a new service
// requirement to the `.spawn()` Effect breaks its signature. Reading the
// project from the Command itself keeps the signature clean and means the
// value flows with the Command through the full build/pipe/prefix combinator
// chain.

import { Effect, Layer } from "effect";
import * as PlatformError from "effect/PlatformError";
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { randomBytes } from "crypto";
import { writeFileSync, unlinkSync } from "fs";

import { logEvent } from "./event-log";
import { capabilities } from "@vps/shared/platform";

export const NAMESPACE_PROJECT_ENV = "ELLUL_NS_PROJECT";

// Explicit opt-in for host-level spawns (provider probes / version checks).
// Sandbox ids match /^sbx-[a-z0-9]{7}$/, so this value cannot collide with
// a real sandbox. Only set this on spawns that MUST run outside any
// per-project namespace — anything user-facing should carry a real sbx id.
export const NAMESPACE_HOST_SENTINEL = "__host__";

// resource-v2 (docs/v2/architecture/resource-v2/03-spawn-routing.md):
// Pool processes additionally pass adapter / scope-id / soft-hint so the
// spawner can wrap with `sudo ellul-spawn-scope <slice> <unit> <props> --`.
// All three must be set together; if any is missing the spawner falls back
// to the legacy namespace-only wrap.
export const NAMESPACE_ADAPTER_ENV = "ELLUL_NS_ADAPTER";
export const NAMESPACE_SCOPE_ID_ENV = "ELLUL_NS_SCOPE_ID";
export const NAMESPACE_SOFT_HINT_MB_ENV = "ELLUL_NS_SOFT_HINT_MB";

// Comma-separated list of env var names to forward through the namespace
// boundary. The spawner writes their values to a temp file and passes
// --env-file to the namespace script, which sources it inside the namespace
// after runuser -l has reset the environment. Adapters opt in by setting
// this key in additionalEnv alongside the vars they want forwarded.
export const NAMESPACE_FORWARD_ENV = "ELLUL_NS_FWD";
export const NAMESPACE_CWD_ENV = "ELLUL_NS_CWD";

const NS_INTERNAL_KEYS = new Set([
  NAMESPACE_PROJECT_ENV,
  NAMESPACE_ADAPTER_ENV,
  NAMESPACE_SCOPE_ID_ENV,
  NAMESPACE_SOFT_HINT_MB_ENV,
  NAMESPACE_FORWARD_ENV,
]);

const ENV_VAR_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const MAX_ENV_FILE_BYTES = 65_536;

export function extractForwardEnv(
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<string, string> | null {
  const raw = env[NAMESPACE_FORWARD_ENV];
  if (!raw) return null;
  const keys = raw.split(",").map((k) => k.trim()).filter(Boolean);
  const result = new Map<string, string>();
  for (const key of keys) {
    if (NS_INTERNAL_KEYS.has(key)) continue;
    if (!ENV_VAR_NAME_RE.test(key)) continue;
    const value = env[key];
    if (value !== undefined) result.set(key, value);
  }
  return result.size > 0 ? result : null;
}

function writeNsEnvFile(vars: ReadonlyMap<string, string>): string {
  const suffix = randomBytes(8).toString("hex");
  const filePath = `/tmp/.ns-env-${suffix}`;
  const lines: string[] = [];
  let totalBytes = 0;
  for (const [key, value] of vars) {
    const escaped = value.replace(/'/g, "'\\''");
    const line = `export ${key}='${escaped}'`;
    totalBytes += Buffer.byteLength(line) + 1;
    if (totalBytes > MAX_ENV_FILE_BYTES) break;
    lines.push(line);
  }
  writeFileSync(filePath, lines.join("\n") + "\n", { mode: 0o600 });
  return filePath;
}

function cleanupEnvFile(path: string | null): void {
  if (!path) return;
  try { unlinkSync(path); } catch {}
}

const NAMESPACE_WRAPPER_COMMAND = "sudo";
const NAMESPACE_WRAPPER_ARGS = ["-n", "ellul-agent-namespace", "enter"] as const;
const SPAWN_SCOPE_BIN = "/usr/local/bin/ellul-spawn-scope";

const ADAPTER_ALLOWLIST = new Set(["claude", "opencode", "cursor", "codex", "grok"]);
const SANDBOX_ID_RE = /^sbx-[a-z0-9]{7}$/;
const SCOPE_ID_RE = /^[a-zA-Z0-9_-]{1,32}$/;

// Argv tokens that mark a long-lived adapter mode. Any spawn carrying one
// of these in its argv is required to be cgroup-confined — pure host
// bypass would land it in the bridge's cgroup and pin MemoryHigh, which is
// the failure mode resource-v2 is designed to eliminate.
//
// These are the exact argv tokens used by the four supported adapters
// today: opencode `serve`, cursor `acp` (often preceded by `-e <endpoint>`),
// and codex `app-server`. Adding to this set is a deliberate widening of
// the lockdown — keep it tight.
const LONG_LIVED_HOST_MODE_ARGS = new Set(["serve", "acp", "app-server"]);

function hasLongLivedArgvMarker(args: ReadonlyArray<string>): string | null {
  for (const a of args) if (LONG_LIVED_HOST_MODE_ARGS.has(a)) return a;
  return null;
}

// Cap argv summary so prompts (which can be multi-KB) don't end up in the
// event log. argv items beyond MAX_ARGV are summarized; each item is
// truncated at MAX_ARG_BYTES.
const MAX_ARGV = 16;
const MAX_ARG_BYTES = 64;

function summarizeArgv(args: ReadonlyArray<string>): {
  argv: Array<string>;
  argvLen: number;
} {
  const argv = args.slice(0, MAX_ARGV).map((a) =>
    a.length > MAX_ARG_BYTES ? a.slice(0, MAX_ARG_BYTES) + `…[+${a.length - MAX_ARG_BYTES}]` : a,
  );
  return { argv, argvLen: args.length };
}

/**
 * Build the systemd-run-wrapped argv for a pool spawn. Output:
 *   sudo -n /usr/local/bin/ellul-spawn-scope
 *     ellul-user-workload-sbx-<project>.slice
 *     ellul-pool-sbx-<project>-<adapter>-<scopeId>
 *     MemoryHigh=<hint>M,MemorySwapMax=0,TasksMax=512
 *     --
 *     /usr/local/bin/ellul-agent-namespace enter <project> --
 *     <inner cmd> <args...>
 *
 * The leading `sudo -n /usr/local/bin/...` becomes the wrapper command + args
 * passed to ChildProcess.prefix; ChildProcess.prefix prepends them to the
 * existing command argv.
 *
 * Exported for unit tests.
 */
export function buildScopeWrappedArgs(project: string, routing: ScopeRouting): Array<string> {
  const short = project.replace(/^sbx-/, "");
  const slice = `ellul-user-workload-sbx-${short}.slice`;
  const unit = `ellul-pool-sbx-${short}-${routing.adapter}-${routing.scopeId}`;
  const props = `MemoryHigh=${routing.softHintMB}M,MemorySwapMax=0,TasksMax=512`;
  return [
    "-n",
    SPAWN_SCOPE_BIN,
    slice,
    unit,
    props,
    "--",
    "/usr/local/bin/ellul-agent-namespace",
    "enter",
    project,
    "--",
  ];
}

/**
 * Build the systemd-run-wrapped argv for a host-mode probe spawn. Output:
 *   sudo -n /usr/local/bin/ellul-spawn-scope
 *     ellul-user-workload.slice
 *     ellul-probe-<adapter>-<scopeId>
 *     MemoryHigh=<hint>M,MemorySwapMax=0,TasksMax=512
 *     --
 *     <inner cmd> <args...>
 *
 * Differs from buildScopeWrappedArgs in two ways:
 *   1. Slice is the shared host-mode slice (probes don't belong to a sandbox).
 *   2. No `ellul-agent-namespace enter` step — probes need real host network
 *      to reach upstream provider endpoints. The cgroup is the only
 *      additional confinement; seccomp/AppArmor/egress-iptables continue to
 *      be the same envelope this binary always runs under (host-mode).
 *
 * The contract is: anything that would have been a long-lived host bypass
 * (and therefore landed in the bridge cgroup) routes through this builder
 * instead. Bridge cgroup membership becomes invariant (control plane only).
 *
 * Exported for unit tests.
 */
export function buildHostScopeWrappedArgs(routing: ScopeRouting): Array<string> {
  const slice = "ellul-user-workload.slice";
  const unit = `ellul-probe-${routing.adapter}-${routing.scopeId}`;
  const props = `MemoryHigh=${routing.softHintMB}M,MemorySwapMax=0,TasksMax=512`;
  return [
    "-n",
    SPAWN_SCOPE_BIN,
    slice,
    unit,
    props,
    "--",
  ];
}

function readProjectFromCommand(command: ChildProcess.Command): string | undefined {
  const leftmost = command._tag === "PipedCommand" ? firstStandardCommand(command) : command;
  return leftmost.options.env?.[NAMESPACE_PROJECT_ENV];
}

export interface ScopeRouting {
  adapter: string;
  scopeId: string;
  softHintMB: number;
}

/**
 * Read pool-routing env vars and validate. Returns:
 *   - null:           none set, legacy namespace-only wrap
 *   - "malformed":    any missing or invalid; caller fails closed
 *   - ScopeRouting:   all three valid; use for systemd-run wrap
 *
 * Exported for unit tests; the spawner uses the same function path.
 */
export function readScopeRoutingFromEnv(env: Readonly<Record<string, string | undefined>>): ScopeRouting | null | "malformed" {
  const adapter = env[NAMESPACE_ADAPTER_ENV];
  const scopeId = env[NAMESPACE_SCOPE_ID_ENV];
  const softHintRaw = env[NAMESPACE_SOFT_HINT_MB_ENV];
  if (!adapter && !scopeId && !softHintRaw) return null;
  if (!adapter || !scopeId || !softHintRaw) return "malformed";
  if (!ADAPTER_ALLOWLIST.has(adapter)) return "malformed";
  if (!SCOPE_ID_RE.test(scopeId)) return "malformed";
  const softHintMB = Number.parseInt(softHintRaw, 10);
  if (!Number.isFinite(softHintMB) || softHintMB <= 0 || softHintMB > 8192) return "malformed";
  return { adapter, scopeId, softHintMB };
}

function readScopeRouting(command: ChildProcess.Command): ScopeRouting | null | "malformed" {
  const leftmost = firstStandardCommand(command);
  return readScopeRoutingFromEnv(leftmost.options.env ?? {});
}

function firstStandardCommand(command: ChildProcess.Command): ChildProcess.StandardCommand {
  let cur: ChildProcess.Command = command;
  while (cur._tag === "PipedCommand") cur = cur.left;
  return cur;
}

function inspectCommandShape(command: ChildProcess.Command): {
  command: string;
  args: ReadonlyArray<string>;
  cwd: string | undefined;
  envKeys: Array<string>;
  isPiped: boolean;
} {
  const leftmost = firstStandardCommand(command);
  return {
    command: leftmost.command,
    args: leftmost.args,
    cwd: leftmost.options.cwd,
    envKeys: leftmost.options.env ? Object.keys(leftmost.options.env) : [],
    isPiped: command._tag === "PipedCommand",
  };
}

// The wrapper unconditionally applies the outer seccomp-BPF filter
// (mount/unshare/ptrace/module-load denied) plus mount/PID/net namespace
// isolation, AppArmor's apparmor_restrict_unprivileged_userns, $SVC_USER
// drop, NoNewPrivileges, and the iptables egress allowlist. Adapter
// behavior cannot widen that boundary — any adapter that tries to spawn
// bwrap or otherwise call mount(2) will SIGTRAP / exit 133. Per-adapter
// configuration (Claude SDK `sandbox.enabled: false`, codex
// `sandbox: 'danger-full-access'`) is how adapters avoid hitting that
// floor; the kernel filter is the floor itself.
export const NamespaceChildProcessSpawnerLive = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const inner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return ChildProcessSpawner.make((command) => {
      const project = readProjectFromCommand(command);
      const shape = inspectCommandShape(command);
      const argSummary = summarizeArgv(shape.args);
      if (!project) {
        // Hard fail — every adapter spawn must declare its sandbox or use
        // the host sentinel. Log the violation with the command shape so we
        // can find the missing call site fast.
        logEvent("ns.spawner.missingProject", {
          command: shape.command,
          isPiped: shape.isPiped,
          envKeys: shape.envKeys,
          ...argSummary,
        });
        return Effect.fail(
          new PlatformError.BadArgument({
            module: "NamespaceChildProcessSpawner",
            method: "spawn",
            description:
              `${NAMESPACE_PROJECT_ENV} env is required. ` +
              `Every adapter spawn must declare its project so the process enters the correct namespace. ` +
              `For host-level spawns (probes / health checks) set ${NAMESPACE_PROJECT_ENV}=${NAMESPACE_HOST_SENTINEL}.`,
          }),
        ) as unknown as Effect.Effect<never, PlatformError.PlatformError, never>;
      }
      if (project === NAMESPACE_HOST_SENTINEL) {
        if (!capabilities.namespaces) {
          logEvent("ns.spawner.hostDirectBypass", {
            command: shape.command,
            cwd: shape.cwd,
            ...argSummary,
          });
          return inner.spawn(command).pipe(
            Effect.tapError((cause) =>
              Effect.sync(() =>
                logEvent("ns.spawner.hostDirectBypassError", {
                  command: shape.command,
                  cause: String(cause),
                }),
              ),
            ),
          ) as ReturnType<typeof inner.spawn>;
        }

        const hostRouting = readScopeRouting(command);
        if (hostRouting === "malformed") {
          logEvent("ns.spawner.malformedScopeRouting", {
            project: NAMESPACE_HOST_SENTINEL,
            command: shape.command,
            envKeys: shape.envKeys,
          });
          return Effect.fail(
            new PlatformError.BadArgument({
              module: "NamespaceChildProcessSpawner",
              method: "spawn",
              description:
                `Probe spawn requires ${NAMESPACE_ADAPTER_ENV} ∈ {claude,opencode,cursor,codex}, ` +
                `${NAMESPACE_SCOPE_ID_ENV} matching [a-zA-Z0-9_-]{1,32}, ` +
                `${NAMESPACE_SOFT_HINT_MB_ENV} ∈ (0, 8192]. ` +
                `Set all three or none. ` +
                `Spec: docs/v2/architecture/resource-v2/03-spawn-routing.md`,
            }),
          ) as unknown as Effect.Effect<never, PlatformError.PlatformError, never>;
        }

        // Phase E lockdown: known long-lived adapter modes (serve / acp /
        // app-server) may not run in pure host-bypass — without cgroup
        // confinement they land in the bridge's cgroup and pin MemoryHigh,
        // which is the failure mode resource-v2 is designed to eliminate.
        // The fix is to set the probe routing vars so the spawn flows
        // through ellul-spawn-scope into ellul-user-workload.slice /
        // ellul-probe-<adapter>-<scope>. Short-lived host commands
        // (--version, --help, about, etc.) keep working unchanged.
        if (!hostRouting) {
          const marker = hasLongLivedArgvMarker(shape.args);
          if (marker) {
            logEvent("ns.spawner.uncontainedLongLivedHost", {
              command: shape.command,
              cwd: shape.cwd,
              envKeys: shape.envKeys,
              marker,
              ...argSummary,
            });
            return Effect.fail(
              new PlatformError.BadArgument({
                module: "NamespaceChildProcessSpawner",
                method: "spawn",
                description:
                  `Host-bypass forbidden for long-lived argv '${marker}' on ${shape.command}. ` +
                  `Long-lived processes must be cgroup-confined: set ${NAMESPACE_ADAPTER_ENV}, ` +
                  `${NAMESPACE_SCOPE_ID_ENV}, and ${NAMESPACE_SOFT_HINT_MB_ENV} so the spawn flows ` +
                  `through ellul-spawn-scope into ellul-user-workload.slice. ` +
                  `Spec: docs/v2/architecture/resource-v2/03-spawn-routing.md`,
              }),
            ) as unknown as Effect.Effect<never, PlatformError.PlatformError, never>;
          }
        }

        if (hostRouting) {
          // Host-mode + cgroup-confined. No namespace nest (probes need real
          // host network for upstream provider RPCs); the spawn-scope wrap
          // moves the process into ellul-user-workload.slice so it is never
          // a member of the bridge cgroup. Same security envelope as
          // existing host bypass otherwise — same binary, same egress
          // allowlist, same AppArmor profile.
          const hostWrapperArgs = buildHostScopeWrappedArgs(hostRouting);
          const hostWrapped = ChildProcess.prefix(
            command,
            NAMESPACE_WRAPPER_COMMAND,
            hostWrapperArgs,
          );
          logEvent("ns.spawner.hostScope", {
            adapter: hostRouting.adapter,
            scopeId: hostRouting.scopeId,
            softHintMB: hostRouting.softHintMB,
            command: shape.command,
            cwd: shape.cwd,
            envKeys: shape.envKeys,
            ...argSummary,
            wrapper: NAMESPACE_WRAPPER_COMMAND,
            wrapperArgs: hostWrapperArgs,
          });
          return inner.spawn(hostWrapped).pipe(
            Effect.tapError((cause) =>
              Effect.sync(() =>
                logEvent("ns.spawner.hostScopeSpawnError", {
                  adapter: hostRouting.adapter,
                  scopeId: hostRouting.scopeId,
                  command: shape.command,
                  cause: String(cause),
                }),
              ),
            ),
          ) as ReturnType<typeof inner.spawn>;
        }

        logEvent("ns.spawner.hostBypass", {
          command: shape.command,
          cwd: shape.cwd,
          envKeys: shape.envKeys,
          ...argSummary,
        });
        return inner.spawn(command).pipe(
          Effect.tapError((cause) =>
            Effect.sync(() =>
              logEvent("ns.spawner.hostSpawnError", {
                command: shape.command,
                cause: String(cause),
              }),
            ),
          ),
        ) as ReturnType<typeof inner.spawn>;
      }
      // Validate sandbox id format (defense-in-depth — wrapper script also validates).
      if (!SANDBOX_ID_RE.test(project)) {
        logEvent("ns.spawner.invalidProject", { project, command: shape.command, ...argSummary });
        return Effect.fail(
          new PlatformError.BadArgument({
            module: "NamespaceChildProcessSpawner",
            method: "spawn",
            description: `${NAMESPACE_PROJECT_ENV}='${project}' must match /^sbx-[a-z0-9]{7}$/`,
          }),
        ) as unknown as Effect.Effect<never, PlatformError.PlatformError, never>;
      }

      if (!capabilities.namespaces) {
        logEvent("ns.spawner.directBypass", {
          project,
          command: shape.command,
          cwd: shape.cwd,
          ...argSummary,
        });
        return inner.spawn(command).pipe(
          Effect.tapError((cause) =>
            Effect.sync(() =>
              logEvent("ns.spawner.directBypassError", {
                project,
                command: shape.command,
                cause: String(cause),
              }),
            ),
          ),
        ) as ReturnType<typeof inner.spawn>;
      }

      const routing = readScopeRouting(command);
      if (routing === "malformed") {
        // Pool callers must set adapter + scopeId + softHintMB consistently.
        // Mixed presence is a programming error — fail closed rather than
        // silently degrade (which would put the process in the bridge cgroup,
        // exactly the failure mode v2 fixes).
        logEvent("ns.spawner.malformedScopeRouting", {
          project,
          command: shape.command,
          envKeys: shape.envKeys,
        });
        return Effect.fail(
          new PlatformError.BadArgument({
            module: "NamespaceChildProcessSpawner",
            method: "spawn",
            description:
              `Pool spawn requires ${NAMESPACE_ADAPTER_ENV} ∈ {claude,opencode,cursor,codex}, ` +
              `${NAMESPACE_SCOPE_ID_ENV} matching [a-zA-Z0-9_-]{1,32}, ` +
              `${NAMESPACE_SOFT_HINT_MB_ENV} ∈ (0, 8192]. ` +
              `Set all three or none. ` +
              `Spec: docs/v2/architecture/resource-v2/03-spawn-routing.md`,
          }),
        ) as unknown as Effect.Effect<never, PlatformError.PlatformError, never>;
      }

      const wrapperArgs: Array<string> = routing
        ? buildScopeWrappedArgs(project, routing)
        : [...NAMESPACE_WRAPPER_ARGS, project, "--"];

      // Forward adapter-requested env vars through the namespace boundary
      // via the shell script's --env-file mechanism. Without this, runuser -l
      // resets the environment and drops all bridge-injected vars.
      const leftmost = firstStandardCommand(command);
      const leftmostEnv = leftmost.options.env ?? {};
      const forwardVars = extractForwardEnv(leftmostEnv);
      const commandCwd = leftmost.options.cwd;
      const allVars: Map<string, string> = forwardVars
        ? new Map(forwardVars)
        : new Map();
      if (commandCwd) {
        allVars.set(NAMESPACE_CWD_ENV, commandCwd);
      }
      let envFilePath: string | null = null;
      if (allVars.size > 0) {
        envFilePath = writeNsEnvFile(allVars);
        wrapperArgs.splice(wrapperArgs.length - 1, 0, "--env-file", envFilePath);
      }

      const wrapped = ChildProcess.prefix(command, NAMESPACE_WRAPPER_COMMAND, wrapperArgs);
      logEvent("ns.spawner.wrap", {
        project,
        adapter: routing?.adapter,
        scopeId: routing?.scopeId,
        softHintMB: routing?.softHintMB,
        command: shape.command,
        cwd: shape.cwd,
        envKeys: shape.envKeys,
        ...argSummary,
        wrapper: NAMESPACE_WRAPPER_COMMAND,
        wrapperArgs,
        scopeRouted: routing !== null,
        envFile: envFilePath !== null,
        envFileKeys: allVars.size > 0 ? [...allVars.keys()] : [],
      });
      return inner.spawn(wrapped).pipe(
        Effect.tapError((cause) =>
          Effect.sync(() => {
            cleanupEnvFile(envFilePath);
            logEvent("ns.spawner.spawnError", {
              project,
              adapter: routing?.adapter,
              scopeId: routing?.scopeId,
              command: shape.command,
              cause: String(cause),
            });
          }),
        ),
      ) as ReturnType<typeof inner.spawn>;
    });
  }),
).pipe(Layer.provide(NodeChildProcessSpawner.layer));
