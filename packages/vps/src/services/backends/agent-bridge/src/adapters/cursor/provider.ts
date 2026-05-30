// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. —
// ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/provider/Layers/CursorProvider.ts

import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

import type {
  CursorModelOptions,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@ellul.ai/types";
import type * as EffectAcpSchema from "../vendor/t3code/effect-acp/schema";
import { Cause, Context, Effect, Equal, Exit, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  collectStreamAsString,
  isCommandMissingCause,
  providerModelsFromSettings,
  type CommandResult,
} from "../../shared/providerSnapshot";
import { makeManagedServerProvider } from "../../shared/makeManagedServerProvider";
import {
  NAMESPACE_ADAPTER_ENV,
  NAMESPACE_HOST_SENTINEL,
  NAMESPACE_PROJECT_ENV,
  NAMESPACE_SCOPE_ID_ENV,
  NAMESPACE_SOFT_HINT_MB_ENV,
} from "../../shared/namespace-spawner";
import { computeWorkloadSliceBudget } from "@vps/shared/memory-budget";
import { IS_ANDROID } from "@vps/shared/platform";
import {
  inventoryCacheKeyForBinary,
  loadInventoryCacheFromDisk,
  persistInventoryCacheToDisk,
} from "../../shared/inventory-cache-disk";
import type { ServerProviderShape } from "../../shared/ServerProvider";
import {
  ServerSettingsService,
  ServerSettingsError,
  type CursorSettings,
} from "../../shared/serverSettings";
import * as fs from "node:fs";
import { logEvent } from "../../shared/event-log";
import * as EffectAcpErrors from "../vendor/t3code/effect-acp/errors";
import { AcpSessionRuntime } from "./acp/AcpSessionRuntime";
import { AcpProjectRuntime } from "./acp/AcpProjectRuntime";
import { safeCwd } from "../../shared/config";

// Targeted debug logger for the cursor probe path. Writes to the bridge's
// debug log so we can see exactly which RPC step in the probe sequence
// stalls in the live service (the standalone reproduction works in <1s
// with the same code path; the bug only manifests inside agent-bridge).
const PROBE_DEBUG_LOG_PATH = "/var/log/ellul/agent-bridge-debug.log";
function probeDebugLog(msg: string): void {
  try {
    fs.appendFileSync(PROBE_DEBUG_LOG_PATH, `[${new Date().toISOString()}] [cursor-probe] ${msg}\n`);
  } catch {}
}

const PROVIDER = "cursor" as const;

// resource-v2 (docs/v2/architecture/resource-v2/03-spawn-routing.md):
// every long-lived `cursor-agent acp` probe spawn carries the routing
// trio so the namespace spawner wraps it in ellul-spawn-scope under
// ellul-user-workload.slice / ellul-probe-cursor-<scope>. Without this
// the spawn would land in the bridge cgroup and pin MemoryHigh.
// Same security envelope as the existing host-bypass path: same binary,
// same egress allowlist, same AppArmor profile.
//
// Soft hint is tier-driven via computeWorkloadSliceBudget. Scope IDs
// combine module-load timestamp + monotonic counter to avoid restart
// collisions.
const PROBE_SOFT_HINT_MB = computeWorkloadSliceBudget(
  Math.max(512, Math.round(nodeOs.totalmem() / (1024 * 1024))),
).probeSoftHintMB;
const PROBE_SCOPE_BOOT_ID = `${Date.now().toString(36)}`;
let _cursorProbeGen = 0;
function nextCursorProbeScopeId(): string {
  return `p${PROBE_SCOPE_BOOT_ID}-${++_cursorProbeGen}`;
}
const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

// Inventory probe is the expensive part of provider status: it spawns
// a host-bypass `cursor-agent acp` runtime, runs initialize +
// authenticate + session/new, reads configOptions, kills the process.
// On a 2 GB VPS that's ~5-6 s per probe and racks up dozens of stranded
// /home/dev/.cursor lock files. Cache the discovered models keyed on
// `cursor-agent` version (+ binary path / endpoint as a safety net) so
// any `agent update` invalidates immediately and a 30 min TTL covers
// the case where the version stays the same but the lab channel
// pushes new models silently.
const INVENTORY_CACHE_TTL_MS = 30 * 60 * 1000;

interface CursorInventoryCacheEntry {
  readonly version: string;
  readonly binaryPath: string;
  readonly apiEndpoint: string;
  readonly fetchedAt: number;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

// Module-local — single provider instance per agent-bridge process.
let cursorInventoryCache: CursorInventoryCacheEntry | null = null;

// Phase C: hydrate L1 from disk on module load. Same envelope as the
// opencode adapter (see ../opencode/provider.ts and
// ../../shared/inventory-cache-disk.ts). The cache file lives at
// /etc/ellul/agent-bridge/inventory/cursor.json.
hydrateCursorInventoryCacheFromDisk();

function hydrateCursorInventoryCacheFromDisk(): void {
  const loaded = loadInventoryCacheFromDisk<CursorInventoryCacheEntry>({
    adapter: "cursor",
    maxAgeMs: INVENTORY_CACHE_TTL_MS,
    validatePayload: validateCursorInventoryPayload,
  });
  if (!loaded) return;
  cursorInventoryCache = loaded.payload;
}

function validateCursorInventoryPayload(raw: unknown): CursorInventoryCacheEntry | null {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as CursorInventoryCacheEntry).version !== "string" ||
    typeof (raw as CursorInventoryCacheEntry).binaryPath !== "string" ||
    typeof (raw as CursorInventoryCacheEntry).apiEndpoint !== "string" ||
    !Number.isFinite((raw as CursorInventoryCacheEntry).fetchedAt) ||
    !Array.isArray((raw as CursorInventoryCacheEntry).models)
  ) {
    return null;
  }
  return raw as CursorInventoryCacheEntry;
}

function readCachedCursorInventory(input: {
  readonly version: string;
  readonly binaryPath: string;
  readonly apiEndpoint: string;
  readonly now: number;
}): ReadonlyArray<ServerProviderModel> | null {
  const cache = cursorInventoryCache;
  if (!cache) return null;
  if (cache.version !== input.version) return null;
  if (cache.binaryPath !== input.binaryPath) return null;
  if (cache.apiEndpoint !== input.apiEndpoint) return null;
  if (input.now - cache.fetchedAt >= INVENTORY_CACHE_TTL_MS) return null;
  return cache.models;
}

function storeCursorInventoryInCache(input: {
  readonly version: string;
  readonly binaryPath: string;
  readonly apiEndpoint: string;
  readonly fetchedAt: number;
  readonly models: ReadonlyArray<ServerProviderModel>;
}): void {
  cursorInventoryCache = { ...input };
  const cacheKey =
    inventoryCacheKeyForBinary(input.binaryPath) ?? `version:${input.version}`;
  persistInventoryCacheToDisk<CursorInventoryCacheEntry>({
    adapter: "cursor",
    cacheKey,
    fetchedAt: input.fetchedAt,
    payload: { ...input },
  });
}

/**
 * Test-only: drop the cached inventory. Real callers should rely on
 * version-change or TTL invalidation.
 */
export function clearCursorInventoryCache(): void {
  cursorInventoryCache = null;
}

const CURSOR_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 60_000;
// Each capability probe is now ONE ACP session/new + setConfigOption
// roundtrip on a single shared cursor-agent process (the multi-session
// probe in discoverCursorModelCapabilitiesViaAcp). No fork/exec, no
// sudo, no namespace re-entry per model — typical wall time is well
// under a second. The 20 s timeout is a wide safety margin for cold-
// start cases (first session pays the initialize+authenticate cost) and
// network-bound model warmups inside cursor-agent. The previous serial
// fan-out (one fresh process per model) inflated this same timeout to
// hide a real CPU/memory contention bug; the multi-session fan-out
// fixes the contention so the timeout no longer needs to absorb fork
// latency.
const CURSOR_ACP_MODEL_CAPABILITY_TIMEOUT = "20 seconds";
// Sessions multiplex on one cursor-agent process; concurrency=4 trades
// off cursor-agent's per-session config-store write serialization
// (cross-session writes are queued internally) against probe wall time.
// Bumping this past ~8 yields diminishing returns and increases
// pressure on cursor-agent's internal scheduler.
const CURSOR_ACP_MODEL_DISCOVERY_CONCURRENCY = 4;
const CURSOR_REFRESH_INTERVAL = "1 hour";
const CURSOR_PARAMETERIZED_MODEL_PICKER_MIN_VERSION_DATE = 2026_04_08;
export const CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES = {
  _meta: {
    parameterizedModelPicker: true,
  },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

export interface CursorProviderShape extends ServerProviderShape {}

export class CursorProvider extends Context.Service<CursorProvider, CursorProviderShape>()(
  "ellul/provider/CursorProvider",
) {}

function buildInitialCursorProviderSnapshot(cursorSettings: CursorSettings): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = getCursorFallbackModels(cursorSettings);

  if (!cursorSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Cursor is disabled in settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking Cursor Agent availability...",
    },
  });
}

interface CursorSessionSelectOption {
  readonly value: string;
  readonly name: string;
}

interface CursorAcpDiscoveredModel {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities;
}

function flattenSessionConfigSelectOptions(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
): ReadonlyArray<CursorSessionSelectOption> {
  if (!configOption || configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry
      ? [{ value: entry.value.trim(), name: entry.name.trim() } satisfies CursorSessionSelectOption]
      : entry.options.map(
          (option) =>
            ({
              value: option.value.trim(),
              name: option.name.trim(),
            }) satisfies CursorSessionSelectOption,
        ),
  );
}

function normalizeCursorReasoningValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case "low":
    case "medium":
    case "high":
    case "max":
      return normalized;
    case "xhigh":
    case "extra-high":
    case "extra high":
      return "xhigh";
    default:
      return undefined;
  }
}

function findCursorModelConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  return configOptions.find((option) => option.category === "model");
}

function getCursorConfigOptionCategory(option: EffectAcpSchema.SessionConfigOption): string {
  return option.category?.trim().toLowerCase() ?? "";
}

function isCursorEffortConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return (
    id === "effort" ||
    id === "reasoning" ||
    name === "effort" ||
    name === "reasoning" ||
    name.includes("effort") ||
    name.includes("reasoning")
  );
}

function findCursorEffortConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): EffectAcpSchema.SessionConfigOption | undefined {
  const candidates = configOptions.filter(
    (option) => option.type === "select" && isCursorEffortConfigOption(option),
  );
  return (
    candidates.find((option) => getCursorConfigOptionCategory(option) === "model_option") ??
    candidates.find((option) => option.id.trim().toLowerCase() === "effort") ??
    candidates.find((option) => getCursorConfigOptionCategory(option) === "thought_level") ??
    candidates[0]
  );
}

function isCursorContextConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "context" || id === "context_size" || name.includes("context");
}

function isCursorFastConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "fast" || name === "fast" || name.includes("fast mode");
}

function isCursorThinkingConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  const id = option.id.trim().toLowerCase();
  const name = option.name.trim().toLowerCase();
  return id === "thinking" || name.includes("thinking");
}

function isBooleanLikeConfigOption(option: EffectAcpSchema.SessionConfigOption): boolean {
  if (option.type === "boolean") {
    return true;
  }
  if (option.type !== "select") {
    return false;
  }
  const values = new Set(
    flattenSessionConfigSelectOptions(option).map((entry) => entry.value.trim().toLowerCase()),
  );
  return values.has("true") && values.has("false");
}

export function buildCursorCapabilitiesFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ModelCapabilities {
  if (!configOptions || configOptions.length === 0) {
    return EMPTY_CAPABILITIES;
  }

  const reasoningConfig = findCursorEffortConfigOption(configOptions);
  const reasoningEffortLevels =
    reasoningConfig?.type === "select"
      ? flattenSessionConfigSelectOptions(reasoningConfig).flatMap((entry) => {
          const normalizedValue = normalizeCursorReasoningValue(entry.value);
          if (!normalizedValue) {
            return [];
          }
          return [
            {
              value: normalizedValue,
              label: entry.name,
              ...(normalizeCursorReasoningValue(reasoningConfig.currentValue) === normalizedValue
                ? { isDefault: true }
                : {}),
            },
          ];
        })
      : [];

  const contextOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorContextConfigOption(option),
  );
  const contextWindowOptions =
    contextOption?.type === "select"
      ? flattenSessionConfigSelectOptions(contextOption).map((entry) => {
          if (contextOption.currentValue === entry.value) {
            return {
              value: entry.value,
              label: entry.name,
              isDefault: true,
            };
          }
          return {
            value: entry.value,
            label: entry.name,
          };
        })
      : [];

  const fastOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorFastConfigOption(option),
  );
  const thinkingOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorThinkingConfigOption(option),
  );

  return {
    reasoningEffortLevels,
    supportsFastMode: fastOption ? isBooleanLikeConfigOption(fastOption) : false,
    supportsThinkingToggle: thinkingOption ? isBooleanLikeConfigOption(thinkingOption) : false,
    contextWindowOptions,
    promptInjectedEffortLevels: [],
  };
}

function buildCursorDiscoveredModels(
  discoveredModels: ReadonlyArray<CursorAcpDiscoveredModel>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  return discoveredModels.flatMap((model) => {
    if (!model.slug || seen.has(model.slug)) {
      return [];
    }
    seen.add(model.slug);
    return [
      {
        slug: model.slug,
        name: model.name,
        isCustom: false,
        capabilities: model.capabilities,
      } satisfies ServerProviderModel,
    ];
  });
}

function hasCursorModelCapabilities(model: Pick<ServerProviderModel, "capabilities">): boolean {
  return (
    (model.capabilities?.reasoningEffortLevels.length ?? 0) > 0 ||
    model.capabilities?.supportsFastMode === true ||
    model.capabilities?.supportsThinkingToggle === true ||
    (model.capabilities?.contextWindowOptions.length ?? 0) > 0 ||
    (model.capabilities?.promptInjectedEffortLevels.length ?? 0) > 0
  );
}

export function buildCursorDiscoveredModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }

  const modelOption = findCursorModelConfigOption(configOptions);
  const modelChoices = flattenSessionConfigSelectOptions(modelOption);
  if (!modelOption || modelChoices.length === 0) {
    return [];
  }

  const currentModelValue =
    modelOption.type === "select" ? modelOption.currentValue?.trim() || undefined : undefined;
  const currentModelCapabilities = buildCursorCapabilitiesFromConfigOptions(configOptions);

  return buildCursorDiscoveredModels(
    modelChoices.map((modelChoice) => ({
      slug: modelChoice.value.trim(),
      name: modelChoice.name.trim(),
      capabilities:
        currentModelValue === modelChoice.value.trim()
          ? currentModelCapabilities
          : EMPTY_CAPABILITIES,
    })),
  );
}

const makeCursorAcpProbeRuntime = (cursorSettings: CursorSettings) =>
  Effect.gen(function* () {
    const probeId = Math.random().toString(36).slice(2, 8);
    probeDebugLog(`probeId=${probeId} BEGIN make runtime`);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    probeDebugLog(`probeId=${probeId} got spawner, building Layer`);
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: {
          command: cursorSettings.binaryPath,
          args: [
            ...(cursorSettings.apiEndpoint ? (["-e", cursorSettings.apiEndpoint] as const) : []),
            "acp",
          ],
          cwd: safeCwd(),
          // Host-mode probe with cgroup confinement. The routing trio
          // routes this spawn through ellul-spawn-scope into
          // ellul-user-workload.slice / ellul-probe-cursor-<scope>; no
          // project namespace nest (probe needs host network) but the
          // process is never a member of the bridge cgroup.
          env: {
            [NAMESPACE_PROJECT_ENV]: NAMESPACE_HOST_SENTINEL,
            [NAMESPACE_ADAPTER_ENV]: PROVIDER,
            [NAMESPACE_SCOPE_ID_ENV]: nextCursorProbeScopeId(),
            [NAMESPACE_SOFT_HINT_MB_ENV]: String(PROBE_SOFT_HINT_MB),
          },
        },
        cwd: safeCwd(),
        clientInfo: { name: "ellul-cursor-provider-probe", version: "0.1.0" },
        authMethodId: "cursor_login",
        clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
        // Instrument every probe RPC so we can see exactly which step
        // stalls. Logs to /var/log/ellul/agent-bridge-debug.log.
        requestLogger: (event) =>
          Effect.sync(() => {
            let detail: string;
            if (event.status === "started") {
              detail = `payload=${JSON.stringify(event.payload).slice(0, 200)}`;
            } else if (event.status === "succeeded") {
              detail = `result=${JSON.stringify(event.result).slice(0, 200)}`;
            } else {
              detail = event.cause
                ? `cause=${Cause.pretty(event.cause).slice(0, 400)}`
                : "cause=(none)";
            }
            probeDebugLog(
              `probeId=${probeId} method=${event.method} status=${event.status} ${detail}`,
            );
          }),
        protocolLogging: {
          logIncoming: true,
          logOutgoing: true,
          logger: (event) =>
            Effect.sync(() => {
              const payload =
                typeof event.payload === "string"
                  ? event.payload.slice(0, 200)
                  : JSON.stringify(event.payload).slice(0, 200);
              probeDebugLog(
                `probeId=${probeId} wire dir=${event.direction} stage=${event.stage} ${payload}`,
              );
            }),
        },
      }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
    );
    probeDebugLog(`probeId=${probeId} Layer built, getting AcpSessionRuntime`);
    const runtime = yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
    probeDebugLog(`probeId=${probeId} runtime obtained`);
    return runtime;
  });

const withCursorAcpProbeRuntime = <A, E, R>(
  cursorSettings: CursorSettings,
  useRuntime: (acp: AcpSessionRuntime["Service"]) => Effect.Effect<A, E, R>,
) => makeCursorAcpProbeRuntime(cursorSettings).pipe(Effect.flatMap(useRuntime), Effect.scoped);

function normalizeCursorConfigOptionToken(value: string | null | undefined): string {
  return (
    value
      ?.trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-") ?? ""
  );
}

function findCursorSelectOptionValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  matcher: (option: CursorSessionSelectOption) => boolean,
): string | undefined {
  return flattenSessionConfigSelectOptions(configOption).find(matcher)?.value;
}

function findCursorBooleanConfigValue(
  configOption: EffectAcpSchema.SessionConfigOption | undefined,
  requested: boolean,
): string | boolean | undefined {
  if (!configOption) {
    return undefined;
  }
  if (configOption.type === "boolean") {
    return requested;
  }
  return findCursorSelectOptionValue(
    configOption,
    (option) => normalizeCursorConfigOptionToken(option.value) === String(requested),
  );
}

export function resolveCursorAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const isAutoSentinel = !trimmed || trimmed.length === 0 || trimmed.toLowerCase() === "auto";
  const base = isAutoSentinel ? "default" : trimmed;
  return base.includes("[") ? base.slice(0, base.indexOf("[")) : base;
}

export function resolveCursorAcpConfigUpdates(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  modelOptions: CursorModelOptions | null | undefined,
): ReadonlyArray<{ readonly configId: string; readonly value: string | boolean }> {
  if (!configOptions || configOptions.length === 0) {
    return [];
  }

  const updates: Array<{ readonly configId: string; readonly value: string | boolean }> = [];

  const reasoningOption = findCursorEffortConfigOption(configOptions);
  const requestedReasoning = normalizeCursorReasoningValue(modelOptions?.reasoning);
  if (reasoningOption && requestedReasoning) {
    const value = findCursorSelectOptionValue(reasoningOption, (option) => {
      const normalizedValue = normalizeCursorReasoningValue(option.value);
      const normalizedName = normalizeCursorReasoningValue(option.name);
      return normalizedValue === requestedReasoning || normalizedName === requestedReasoning;
    });
    if (value) {
      updates.push({ configId: reasoningOption.id, value });
    }
  }

  const contextOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorContextConfigOption(option),
  );
  if (contextOption && modelOptions?.contextWindow) {
    const value = findCursorSelectOptionValue(
      contextOption,
      (option) =>
        normalizeCursorConfigOptionToken(option.value) ===
          normalizeCursorConfigOptionToken(modelOptions.contextWindow) ||
        normalizeCursorConfigOptionToken(option.name) ===
          normalizeCursorConfigOptionToken(modelOptions.contextWindow),
    );
    if (value) {
      updates.push({ configId: contextOption.id, value });
    }
  }

  const fastOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorFastConfigOption(option),
  );
  if (fastOption && typeof modelOptions?.fastMode === "boolean") {
    const value = findCursorBooleanConfigValue(fastOption, modelOptions.fastMode);
    if (value !== undefined) {
      updates.push({ configId: fastOption.id, value });
    }
  }

  const thinkingOption = configOptions.find(
    (option) => option.category === "model_config" && isCursorThinkingConfigOption(option),
  );
  if (thinkingOption && typeof modelOptions?.thinking === "boolean") {
    const value = findCursorBooleanConfigValue(thinkingOption, modelOptions.thinking);
    if (value !== undefined) {
      updates.push({ configId: thinkingOption.id, value });
    }
  }

  return updates;
}

export const discoverCursorModelsViaAcp = (cursorSettings: CursorSettings) =>
  withCursorAcpProbeRuntime(cursorSettings, (acp) =>
    Effect.map(acp.start(), (started) =>
      buildCursorDiscoveredModelsFromConfigOptions(started.sessionSetupResult.configOptions ?? []),
    ),
  );

// Multi-session capability discovery. Spawns ONE host-bypass cursor-agent
// process and opens one ACP session per model on it (cursor-agent's
// `session/new` is in the baseline MUST set per the Agent Client
// Protocol — same primitive the per-project pool uses to multiplex
// threads onto one runtime).
//
// Replaces the prior per-model spawn loop, which forked 26 fresh
// cursor-agent processes serially under sudo+namespace+seccomp. Each
// fork+exec was ~5-6 s on a 2 GB VPS and consumed ~100-200 MB resident,
// hammering the agent-bridge cgroup and starving any concurrent project-
// namespace cursor-agent the user was trying to chat with — surfacing
// as JSON-RPC -32603 "Internal error" in the client. See
// project_cursor_capability_storm.md.
//
// Security envelope is preserved: the spawn passes
// ELLUL_NS_PROJECT=__host__ so the namespace spawner skips namespace
// entry (same as the inventory probe). cursor-agent runs on the host,
// never inside any project's namespace. AcpProjectRuntime is the same
// multi-session ACP layer the per-project pool uses; the runtime type
// is generic — only the spawn input distinguishes "host probe" from
// "project pool". A static security test (cursor.security-invariants)
// asserts both spawn sites carry the host sentinel.
export const discoverCursorModelCapabilitiesViaAcp = (
  cursorSettings: CursorSettings,
  existingModels: ReadonlyArray<ServerProviderModel>,
): Effect.Effect<
  ReadonlyArray<ServerProviderModel>,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const probeId = Math.random().toString(36).slice(2, 8);
      probeDebugLog(`probeId=${probeId} multi-session capability probe BEGIN`);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const runtimeContext = yield* Layer.build(
        AcpProjectRuntime.layer({
          spawn: {
            command: cursorSettings.binaryPath,
            args: [
              ...(cursorSettings.apiEndpoint ? (["-e", cursorSettings.apiEndpoint] as const) : []),
              "acp",
            ],
            cwd: safeCwd(),
            // Host-mode probe with cgroup confinement — same routing as
            // the inventory probe above. cursor-agent never enters a
            // project namespace; the scope wrapper places it in
            // ellul-user-workload.slice rather than the bridge cgroup.
            env: {
              [NAMESPACE_PROJECT_ENV]: NAMESPACE_HOST_SENTINEL,
              [NAMESPACE_ADAPTER_ENV]: PROVIDER,
              [NAMESPACE_SCOPE_ID_ENV]: nextCursorProbeScopeId(),
              [NAMESPACE_SOFT_HINT_MB_ENV]: String(PROBE_SOFT_HINT_MB),
            },
          },
          clientInfo: { name: "ellul-cursor-provider-probe", version: "0.1.0" },
          authMethodId: "cursor_login",
          clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
          requestLogger: (event) =>
            Effect.sync(() => {
              const detail =
                event.status === "succeeded"
                  ? `result=${JSON.stringify(event.result).slice(0, 200)}`
                  : event.status === "failed"
                    ? `cause=${event.cause ? Cause.pretty(event.cause).slice(0, 400) : "(none)"}`
                    : `payload=${JSON.stringify(event.payload).slice(0, 200)}`;
              probeDebugLog(
                `probeId=${probeId} method=${event.method} status=${event.status} ${detail}`,
              );
            }),
          protocolLogging: {
            logIncoming: true,
            logOutgoing: true,
            logger: (event) =>
              Effect.sync(() => {
                const payload =
                  typeof event.payload === "string"
                    ? event.payload.slice(0, 200)
                    : JSON.stringify(event.payload).slice(0, 200);
                probeDebugLog(
                  `probeId=${probeId} wire dir=${event.direction} stage=${event.stage} ${payload}`,
                );
              }),
          },
        }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
      );

      const runtime = yield* Effect.service(AcpProjectRuntime).pipe(
        Effect.provide(runtimeContext),
      );

      // First session both proves the runtime is alive (initialize +
      // authenticate run inside the first newSession) and gives us the
      // inventory + the current model's capabilities for free. Closed
      // immediately after we extract its configOptions — keeping the
      // session open would leak it for the lifetime of the probe.
      // No yield* session.close in this probe path — cursor-agent does not
      // implement `session/close` and returns -32601 ("Method not found").
      // AcpProjectRuntime.closeSessionInternal wraps the request in
      // Effect.ignore, but cursor-agent's error round-trips back as a
      // JSON-RPC defect (Die), which the ignore wrapper does NOT catch
      // — it halts the probe right after the first close attempt
      // (verified live on 178.105.24.155 at 12:19:08 UTC). Sessions
      // instead live for the duration of the probe runtime; the
      // Effect.scoped finalizer below kills cursor-agent and the
      // AcpProjectRuntime layer finalizer drops session state in the
      // dispatch maps. Net effect is identical, with no -32601 trap.
      const initialSession = yield* runtime.newSession({ cwd: safeCwd() });
      const initialConfigOptions = initialSession.sessionSetupResult.configOptions ?? [];

      const modelOption = findCursorModelConfigOption(initialConfigOptions);
      const modelChoices = flattenSessionConfigSelectOptions(modelOption);
      if (!modelOption || modelChoices.length === 0) {
        return [];
      }

      const currentModelValue =
        modelOption.type === "select" ? modelOption.currentValue?.trim() || undefined : undefined;
      const capabilitiesBySlug = new Map<string, ModelCapabilities>();
      if (currentModelValue) {
        capabilitiesBySlug.set(
          currentModelValue,
          buildCursorCapabilitiesFromConfigOptions(initialConfigOptions),
        );
      }

      const targetModelSlugs = new Set(
        existingModels
          .filter((model) => !model.isCustom && !hasCursorModelCapabilities(model))
          .map((model) => model.slug),
      );
      if (targetModelSlugs.size === 0) {
        return buildCursorDiscoveredModels(
          modelChoices.map((modelChoice) => ({
            slug: modelChoice.value.trim(),
            name: modelChoice.name.trim(),
            capabilities: capabilitiesBySlug.get(modelChoice.value.trim()) ?? EMPTY_CAPABILITIES,
          })),
        );
      }

      // Per-model probes share the SAME cursor-agent process via
      // session/new — no fork/exec, no sudo, no namespace re-entry. Bounded
      // concurrency keeps cursor-agent's internal scheduler from queueing
      // dozens of session/setConfigOption requests at once (the agent
      // serializes per-session writes to its config store; cross-session
      // dispatch is fine in parallel). 4 is conservative; bump if probe
      // wall time becomes a constraint.
      const probedCapabilities = yield* Effect.forEach(
        modelChoices,
        (modelChoice) => {
          const modelSlug = modelChoice.value.trim();
          if (!modelSlug || !targetModelSlugs.has(modelSlug) || capabilitiesBySlug.has(modelSlug)) {
            return Effect.void.pipe(
              Effect.as<readonly [string, ModelCapabilities] | undefined>(undefined),
            );
          }

          return Effect.gen(function* () {
            const session = yield* runtime.newSession({ cwd: safeCwd() });
            const probeConfigOptions = session.sessionSetupResult.configOptions ?? [];
            const probeModelOption = findCursorModelConfigOption(probeConfigOptions);
            const probeCurrentModelValue =
              probeModelOption?.type === "select"
                ? probeModelOption.currentValue?.trim() || undefined
                : undefined;
            yield* Effect.annotateCurrentSpan({
              "cursor.acp.model.value": modelSlug,
              "cursor.acp.model.currentValue": probeCurrentModelValue,
              "cursor.acp.config_option_id": probeModelOption?.id ?? modelOption.id,
            });
            const nextConfigOptions =
              probeCurrentModelValue === modelSlug
                ? probeConfigOptions
                : yield* session
                    .setConfigOption(probeModelOption?.id ?? modelOption.id, modelSlug)
                    .pipe(Effect.map((response) => response.configOptions ?? probeConfigOptions));
            // Per-session close is intentionally NOT issued. cursor-agent
            // returns -32601 for session/close (see comment on the initial
            // session above). All session state is dropped when the
            // runtime scope closes at probe end, so leaks are bounded to
            // the probe lifetime (~30 s) regardless.
            return [modelSlug, buildCursorCapabilitiesFromConfigOptions(nextConfigOptions)] as const;
          }).pipe(
            Effect.timeout(CURSOR_ACP_MODEL_CAPABILITY_TIMEOUT),
            Effect.retry({ times: 2 }),
            Effect.withSpan("cursor-acp-model-capability-probe"),
            Effect.catchCause((cause) =>
              Effect.logWarning("Cursor ACP capability probe failed", {
                modelSlug,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        },
        { concurrency: CURSOR_ACP_MODEL_DISCOVERY_CONCURRENCY },
      );

      for (const entry of probedCapabilities) {
        if (!entry) {
          continue;
        }
        capabilitiesBySlug.set(entry[0], entry[1]);
      }

      probeDebugLog(`probeId=${probeId} multi-session capability probe COMPLETE`);

      return buildCursorDiscoveredModels(
        modelChoices.map((modelChoice) => ({
          slug: modelChoice.value.trim(),
          name: modelChoice.name.trim(),
          capabilities: capabilitiesBySlug.get(modelChoice.value.trim()) ?? EMPTY_CAPABILITIES,
        })),
      );
    }).pipe(Effect.withSpan("cursor-acp-model-capability-discovery")),
  );

export function getCursorFallbackModels(
  cursorSettings: Pick<CursorSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], PROVIDER, cursorSettings.customModels, EMPTY_CAPABILITIES);
}

// `cursor-agent about` is a Node CLI (launcher → node + index.js). On Android
// the proot + engine stdio-proxy + cold-boot I/O load make 8s too tight,
// yielding a spurious "installed but timed out". Give the device headroom.
const ABOUT_TIMEOUT_MS = IS_ANDROID ? 30_000 : 8_000;

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g, "");
}

function extractAboutField(plain: string, key: string): string | undefined {
  const regex = new RegExp(`^${key}\\s{2,}(.+)$`, "mi");
  const match = regex.exec(plain);
  return match?.[1]?.trim();
}

export interface CursorAboutResult {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

function joinProviderMessages(...messages: ReadonlyArray<string | undefined>): string | undefined {
  const parts = messages
    .map((message) => message?.trim())
    .filter((message): message is string => Boolean(message));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function buildCursorProviderSnapshot(input: {
  readonly checkedAt: string;
  readonly cursorSettings: CursorSettings;
  readonly parsed: CursorAboutResult;
  readonly discoveredModels?: ReadonlyArray<ServerProviderModel>;
  readonly discoveryWarning?: string;
}): ServerProvider {
  const message = joinProviderMessages(input.parsed.message, input.discoveryWarning);
  return buildServerProvider({
    provider: PROVIDER,
    enabled: input.cursorSettings.enabled,
    checkedAt: input.checkedAt,
    models: providerModelsFromSettings(
      input.discoveredModels ?? [],
      PROVIDER,
      input.cursorSettings.customModels,
      EMPTY_CAPABILITIES,
    ),
    probe: {
      installed: true,
      version: input.parsed.version,
      status:
        input.discoveryWarning && input.parsed.status === "ready" ? "warning" : input.parsed.status,
      auth: input.parsed.auth,
      ...(message ? { message } : {}),
    },
  });
}

interface CursorAboutJsonPayload {
  readonly cliVersion?: unknown;
  readonly subscriptionTier?: unknown;
  readonly userEmail?: unknown;
}

export function parseCursorVersionDate(version: string | null | undefined): number | undefined {
  const match = version?.trim().match(/^(\d{4})\.(\d{2})\.(\d{2})(?:\b|-|$)/);
  if (!match) {
    return undefined;
  }
  const [, year, month, day] = match;
  return Number(`${year}${month}${day}`);
}

export function parseCursorCliConfigChannel(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "channel" in parsed &&
      typeof parsed.channel === "string"
    ) {
      const channel = parsed.channel.trim().toLowerCase();
      return channel.length > 0 ? channel : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function toTitleCaseWords(value: string): string {
  return value
    .split(/[\s_-]+/g)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function cursorSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    case "business":
      return "Business";
    case "enterprise":
      return "Enterprise";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function cursorAuthMetadata(
  subscriptionType: string | undefined,
): Pick<ServerProviderAuth, "label" | "type"> | undefined {
  if (!subscriptionType) {
    return undefined;
  }
  const subscriptionLabel = cursorSubscriptionLabel(subscriptionType);
  return {
    type: subscriptionType,
    label: `Cursor ${subscriptionLabel ?? toTitleCaseWords(subscriptionType)} Subscription`,
  };
}

function parseCursorAboutJsonPayload(raw: string): CursorAboutJsonPayload | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as CursorAboutJsonPayload;
  } catch {
    return undefined;
  }
}

function hasOwn(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isCursorAboutJsonFormatUnsupported(result: CommandResult): boolean {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    lowerOutput.includes("unknown option '--format'") ||
    lowerOutput.includes("unexpected argument '--format'") ||
    lowerOutput.includes("unrecognized option '--format'") ||
    lowerOutput.includes("unknown argument '--format'")
  );
}

function readCursorCliConfigChannel(): string | undefined {
  try {
    const configPath = nodePath.join(nodeOs.homedir(), ".cursor", "cli-config.json");
    return parseCursorCliConfigChannel(nodeFs.readFileSync(configPath, "utf8"));
  } catch {
    return undefined;
  }
}

export function getCursorParameterizedModelPickerUnsupportedMessage(input: {
  readonly version: string | null | undefined;
  readonly channel: string | null | undefined;
}): string | undefined {
  const reasons: Array<string> = [];
  const versionDate = parseCursorVersionDate(input.version);
  if (
    versionDate !== undefined &&
    versionDate < CURSOR_PARAMETERIZED_MODEL_PICKER_MIN_VERSION_DATE
  ) {
    reasons.push(
      `Cursor Agent CLI version ${input.version} is too old for Cursor ACP parameterized model picker`,
    );
  }

  const normalizedChannel = input.channel?.trim().toLowerCase();
  if (
    normalizedChannel !== undefined &&
    normalizedChannel.length > 0 &&
    normalizedChannel !== "lab"
  ) {
    reasons.push(
      `Cursor Agent CLI channel is ${JSON.stringify(input.channel)}, but parameterized model picker is only available on the lab channel`,
    );
  }

  if (reasons.length === 0) {
    return undefined;
  }

  return `${reasons.join(". ")}. Run \`agent set-channel lab && agent update\` and use Cursor Agent CLI 2026.04.08 or newer.`;
}

export function parseCursorAboutOutput(result: CommandResult): CursorAboutResult {
  const jsonPayload = parseCursorAboutJsonPayload(result.stdout);
  if (jsonPayload) {
    const version =
      typeof jsonPayload.cliVersion === "string" ? jsonPayload.cliVersion.trim() : null;
    const hasUserEmailField = hasOwn(jsonPayload, "userEmail");
    const userEmail =
      typeof jsonPayload.userEmail === "string" ? jsonPayload.userEmail.trim() : undefined;
    const subscriptionType =
      typeof jsonPayload.subscriptionTier === "string"
        ? jsonPayload.subscriptionTier.trim()
        : undefined;
    const authMetadata = cursorAuthMetadata(subscriptionType);

    if (hasUserEmailField && jsonPayload.userEmail == null) {
      return {
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
      };
    }

    if (!userEmail) {
      if (result.code === 0) {
        return {
          version,
          status: "ready",
          auth: {
            status: "unknown",
            ...authMetadata,
          },
        };
      }
      return {
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: "Could not verify Cursor Agent authentication status.",
      };
    }

    const lowerEmail = userEmail.toLowerCase();
    if (
      lowerEmail === "not logged in" ||
      lowerEmail.includes("login required") ||
      lowerEmail.includes("authentication required")
    ) {
      return {
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
      };
    }

    return {
      version,
      status: "ready",
      auth: {
        status: "authenticated",
        ...authMetadata,
      },
    };
  }

  const combined = `${result.stdout}\n${result.stderr}`;
  const lowerOutput = combined.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "The `agent about` command is unavailable in this version of the Cursor Agent CLI.",
    };
  }

  const plain = stripAnsi(combined);
  const version = extractAboutField(plain, "CLI Version") ?? null;
  const userEmail = extractAboutField(plain, "User Email");

  if (userEmail === undefined) {
    if (result.code === 0) {
      return { version, status: "ready", auth: { status: "unknown" } };
    }
    return {
      version,
      status: "warning",
      auth: { status: "unknown" },
      message: "Could not verify Cursor Agent authentication status.",
    };
  }

  const lowerEmail = userEmail.toLowerCase();
  if (
    lowerEmail === "not logged in" ||
    lowerEmail.includes("login required") ||
    lowerEmail.includes("authentication required")
  ) {
    return {
      version,
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Cursor Agent is not authenticated. Run `agent login` and try again.",
    };
  }

  return { version, status: "ready", auth: { status: "authenticated" } };
}

const runCursorCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cursorSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.cursor),
    );
    const command = ChildProcess.make(cursorSettings.binaryPath, [...args], {
      shell: process.platform === "win32",
      // Host-level probe — bypasses the per-project namespace wrapper.
      env: {
        ...process.env,
        [NAMESPACE_PROJECT_ENV]: NAMESPACE_HOST_SENTINEL,
      },
    });

    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    return { stdout, stderr, code: exitCode } satisfies CommandResult;
  }).pipe(Effect.scoped);

const runCursorAboutCommand = Effect.gen(function* () {
  const jsonResult = yield* runCursorCommand(["about", "--format", "json"]);
  if (!isCursorAboutJsonFormatUnsupported(jsonResult)) {
    return jsonResult;
  }
  return yield* runCursorCommand(["about"]);
});

export const checkCursorProviderStatus = Effect.fn("checkCursorProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const cursorSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.cursor),
    );
    const checkedAt = new Date().toISOString();
    const fallbackModels = getCursorFallbackModels(cursorSettings);

    if (!cursorSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Cursor is disabled in settings.",
        },
      });
    }

    const aboutProbe = yield* runCursorAboutCommand.pipe(
      Effect.timeoutOption(ABOUT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(aboutProbe)) {
      const error = aboutProbe.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: cursorSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Cursor Agent CLI (`agent`) is not installed or not on PATH."
            : `Failed to execute Cursor Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      });
    }

    if (Option.isNone(aboutProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: cursorSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Cursor Agent CLI is installed but timed out while running `agent about`.",
        },
      });
    }

    const parsed = parseCursorAboutOutput(aboutProbe.success.value);
    const parameterizedModelPickerUnsupportedMessage =
      getCursorParameterizedModelPickerUnsupportedMessage({
        version: parsed.version,
        channel: readCursorCliConfigChannel(),
      });
    if (parameterizedModelPickerUnsupportedMessage) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: cursorSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: parsed.version,
          status: "error",
          auth: parsed.auth,
          message:
            parsed.auth.status === "unauthenticated" && parsed.message
              ? `${parameterizedModelPickerUnsupportedMessage} ${parsed.message}`
              : parameterizedModelPickerUnsupportedMessage,
        },
      });
    }
    let discoveredModels = Option.none<ReadonlyArray<ServerProviderModel>>();
    let discoveryWarning: string | undefined;
    const isFreeSubscription =
      parsed.auth.status === "authenticated" &&
      "type" in parsed.auth &&
      typeof parsed.auth.type === "string" &&
      parsed.auth.type.toLowerCase() === "free";
    if (parsed.auth.status !== "unauthenticated" && !isFreeSubscription) {
      // Cache hit: skip the entire spawn pipeline. Cache key includes
      // version + binaryPath + apiEndpoint so any of those changing
      // forces a fresh probe; the 30 min TTL is the safety net for the
      // "same version, new model rolled out by Cursor" case.
      const now = Date.now();
      if (parsed.version) {
        const cached = readCachedCursorInventory({
          version: parsed.version,
          binaryPath: cursorSettings.binaryPath,
          apiEndpoint: cursorSettings.apiEndpoint ?? "",
          now,
        });
        if (cached) {
          logEvent("cursor.providerProbe.inventoryCacheHit", {
            version: parsed.version,
            ageMs: now - (cursorInventoryCache?.fetchedAt ?? now),
            modelCount: cached.length,
          });
          discoveredModels = Option.some(cached);
        }
      }

      if (Option.isNone(discoveredModels)) {
        const discoveryExit = yield* Effect.exit(
          discoverCursorModelsViaAcp(cursorSettings).pipe(
            Effect.timeoutOption(CURSOR_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
          ),
        );
        if (Exit.isFailure(discoveryExit)) {
          yield* Effect.logWarning("Cursor ACP model discovery failed", {
            cause: Cause.pretty(discoveryExit.cause),
          });
          discoveryWarning = "Cursor ACP model discovery failed. Check server logs for details.";
        } else if (Option.isNone(discoveryExit.value)) {
          discoveryWarning = `Cursor ACP model discovery timed out after ${CURSOR_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`;
        } else if (discoveryExit.value.value.length === 0) {
          discoveryWarning = "Cursor ACP model discovery returned no built-in models.";
        } else {
          discoveredModels = discoveryExit.value;
          if (parsed.version) {
            storeCursorInventoryInCache({
              version: parsed.version,
              binaryPath: cursorSettings.binaryPath,
              apiEndpoint: cursorSettings.apiEndpoint ?? "",
              fetchedAt: now,
              models: discoveryExit.value.value,
            });
            logEvent("cursor.providerProbe.inventoryCacheStore", {
              version: parsed.version,
              modelCount: discoveryExit.value.value.length,
            });
          }
        }
      }
    }
    return buildCursorProviderSnapshot({
      checkedAt,
      cursorSettings,
      parsed,
      discoveredModels: Option.getOrElse(
        Option.filter(discoveredModels, (models) => models.length > 0),
        () => [] as const,
      ),
      ...(discoveryWarning ? { discoveryWarning } : {}),
    });
  },
);

export const CursorProviderLive = Layer.effect(
  CursorProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const checkProvider = checkCursorProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<CursorSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.cursor),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.cursor),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: buildInitialCursorProviderSnapshot,
      checkProvider,
      enrichSnapshot: ({ settings, snapshot, publishSnapshot }) => {
        if (
          !settings.enabled ||
          snapshot.auth.status === "unauthenticated" ||
          !snapshot.models.some((model) => !model.isCustom && !hasCursorModelCapabilities(model))
        ) {
          // Cache hit path: every model already has caps, so re-running
          // discovery would produce the same result. Without this guard
          // every snapshot publish would trigger a full probe — which
          // pre-fix manifested as a 26-process storm starving user
          // sessions (project_cursor_capability_storm.md).
          return Effect.void;
        }

        return discoverCursorModelCapabilitiesViaAcp(settings, snapshot.models).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.flatMap((discoveredModels) => {
            if (discoveredModels.length === 0) {
              return Effect.void;
            }

            // Promote the inventory cache entry to "enriched" by writing
            // the now-with-capabilities models back. Preserves the
            // existing `fetchedAt` so the 30 min TTL clock isn't reset
            // and keeps the same cache key (version + binaryPath +
            // apiEndpoint) — we're upgrading the same entry, not
            // creating a new one. After this, `checkCursorProviderStatus`
            // hits the cache, snapshot.models all carry caps, the
            // `some(!hasCaps)` guard above short-circuits, and no probe
            // runs for the rest of the TTL window.
            const cache = cursorInventoryCache;
            const apiEndpoint = settings.apiEndpoint ?? "";
            if (
              cache &&
              cache.binaryPath === settings.binaryPath &&
              cache.apiEndpoint === apiEndpoint
            ) {
              storeCursorInventoryInCache({
                version: cache.version,
                binaryPath: cache.binaryPath,
                apiEndpoint: cache.apiEndpoint,
                fetchedAt: cache.fetchedAt,
                models: discoveredModels,
              });
              logEvent("cursor.providerProbe.capabilitiesCacheStore", {
                version: cache.version,
                modelCount: discoveredModels.length,
              });
            }

            return publishSnapshot({
              ...snapshot,
              models: providerModelsFromSettings(
                discoveredModels,
                PROVIDER,
                settings.customModels,
                EMPTY_CAPABILITIES,
              ),
            });
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("Cursor ACP background capability enrichment failed", {
              models: snapshot.models.map((model) => model.slug),
              cause: Cause.pretty(cause),
            }).pipe(Effect.asVoid),
          ),
        );
      },
      refreshInterval: CURSOR_REFRESH_INTERVAL,
    });
  }),
);
