// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/provider/Layers/OpenCodeProvider.ts

import type {
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "@ellul.ai/types";
import { Cause, Context, Data, Effect, Equal, Layer, Stream } from "effect";

import { ServerConfig } from "../../shared/config";
import * as os from "node:os";

import {
  NAMESPACE_ADAPTER_ENV,
  NAMESPACE_HOST_SENTINEL,
  NAMESPACE_PROJECT_ENV,
  NAMESPACE_SCOPE_ID_ENV,
  NAMESPACE_SOFT_HINT_MB_ENV,
} from "../../shared/namespace-spawner";
import { computeWorkloadSliceBudget } from "@vps/shared/memory-budget";
import {
  inventoryCacheKeyForBinary,
  loadInventoryCacheFromDisk,
  persistInventoryCacheToDisk,
} from "../../shared/inventory-cache-disk";
import {
  ServerSettingsService,
  type OpenCodeSettings,
} from "../../shared/serverSettings";
import { makeManagedServerProvider } from "../../shared/makeManagedServerProvider";
import {
  buildServerProvider,
  nonEmptyTrimmed,
  parseGenericCliVersion,
  providerModelsFromSettings,
} from "../../shared/providerSnapshot";
import type { ServerProviderShape } from "../../shared/ServerProvider";
import { compareCliVersions } from "../../shared/cliVersion";
import {
  OpenCodeRuntime,
  openCodeRuntimeErrorDetail,
  type OpenCodeInventory,
} from "./runtime";
import { logEvent } from "../../shared/event-log";
import type { Agent, ProviderListResponse } from "@opencode-ai/sdk/v2";

export interface OpenCodeProviderShape extends ServerProviderShape {}

export class OpenCodeProvider extends Context.Service<OpenCodeProvider, OpenCodeProviderShape>()(
  "ellul/provider/OpenCodeProvider",
) {}

const PROVIDER = "opencode" as const;
const MINIMUM_OPENCODE_VERSION = "1.14.19";

// resource-v2 (docs/v2/architecture/resource-v2/03-spawn-routing.md):
// the inventory probe spawns a long-lived `opencode serve` to query
// providers; without these routing vars the spawn would land in the
// bridge cgroup as a plain host bypass. Setting all three plus the
// __host__ project sentinel routes through ellul-spawn-scope into
// ellul-user-workload.slice / ellul-probe-opencode-<scope> instead.
// Same security envelope as before — same binary, same egress
// allowlist, same AppArmor profile; only cgroup parent changes.
//
// Soft hint is tier-driven via computeWorkloadSliceBudget — never
// hardcode a memory cap on a per-tier path. Computed once at module
// load against the bridge's physical memory.
const PROBE_SOFT_HINT_MB = computeWorkloadSliceBudget(
  Math.max(512, Math.round(os.totalmem() / (1024 * 1024))),
).probeSoftHintMB;
// Scope IDs combine module-load timestamp (base36) with a monotonic
// counter so a slow probe surviving a bridge restart can't collide
// with a fresh probe in the new bridge process.
const PROBE_SCOPE_BOOT_ID = `${Date.now().toString(36)}`;
let _opencodeProbeGen = 0;
function nextOpenCodeProbeScopeId(): string {
  return `p${PROBE_SCOPE_BOOT_ID}-${++_opencodeProbeGen}`;
}

// Inventory probe is the expensive part of provider status: it spawns a
// host-bypass `opencode serve`, fetches provider.list + app.agents, and
// kills the server. Before this cache it ran on every reconciler tick
// (~30s), driving 200+ redundant spawns per day. Cache by version so any
// `opencode upgrade` invalidates immediately, with a 30 min TTL as a
// safety net for upstream provider connect/disconnect that wouldn't
// move the version string.
const INVENTORY_CACHE_TTL_MS = 30 * 60 * 1000;

interface InventoryCacheEntry {
  readonly version: string;
  readonly binaryPath: string;
  readonly fetchedAt: number;
  readonly inventory: OpenCodeInventory;
}

// Module-local — single provider instance per agent-bridge process.
// External-server mode bypasses the cache (those are remote and can
// change auth state out from under us).
let inventoryCache: InventoryCacheEntry | null = null;

// Phase C: hydrate L1 from disk on module load. The disk format is
// adapter-keyed by binaryPath stat (mtime+size) so a binary upgrade
// invalidates automatically. After hydration, the next probe runs
// `opencode --version` (cheap host-bypass) and either confirms the
// cached version (cache hit, skip the expensive `serve` spawn) or
// invalidates the entry. Boot-time probe storms after a fleet restart
// are eliminated.
hydrateInventoryCacheFromDisk();

function hydrateInventoryCacheFromDisk(): void {
  const loaded = loadInventoryCacheFromDisk<InventoryCacheEntry>({
    adapter: "opencode",
    maxAgeMs: INVENTORY_CACHE_TTL_MS,
    validatePayload: validateOpenCodeInventoryPayload,
  });
  if (!loaded) return;
  // Re-key the L1 entry so future readCachedInventory calls hit. Disk
  // cache stores the same shape we use in memory; trust it after schema
  // validation.
  inventoryCache = loaded.payload;
}

function validateOpenCodeInventoryPayload(raw: unknown): InventoryCacheEntry | null {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as InventoryCacheEntry).version !== "string" ||
    typeof (raw as InventoryCacheEntry).binaryPath !== "string" ||
    !Number.isFinite((raw as InventoryCacheEntry).fetchedAt) ||
    typeof (raw as InventoryCacheEntry).inventory !== "object" ||
    (raw as InventoryCacheEntry).inventory === null
  ) {
    return null;
  }
  return raw as InventoryCacheEntry;
}

function readCachedInventory(input: {
  readonly version: string;
  readonly binaryPath: string;
  readonly now: number;
}): OpenCodeInventory | null {
  const cache = inventoryCache;
  if (!cache) return null;
  if (cache.version !== input.version) return null;
  if (cache.binaryPath !== input.binaryPath) return null;
  if (input.now - cache.fetchedAt >= INVENTORY_CACHE_TTL_MS) return null;
  return cache.inventory;
}

function storeInventoryInCache(input: {
  readonly version: string;
  readonly binaryPath: string;
  readonly fetchedAt: number;
  readonly inventory: OpenCodeInventory;
}): void {
  inventoryCache = { ...input };
  // Phase C: best-effort persist to disk. Errors are swallowed by the
  // disk module — durability is not load-bearing for the live request
  // path. cacheKey is binary-stat so a binary upgrade between writes
  // doesn't leave stale content readable on the next process boot.
  const cacheKey =
    inventoryCacheKeyForBinary(input.binaryPath) ?? `version:${input.version}`;
  persistInventoryCacheToDisk<InventoryCacheEntry>({
    adapter: "opencode",
    cacheKey,
    fetchedAt: input.fetchedAt,
    payload: { ...input },
  });
}

/**
 * Test-only: drop the cached inventory. Real callers should rely on
 * version-change or TTL invalidation.
 */
export function clearOpenCodeInventoryCache(): void {
  inventoryCache = null;
}

class OpenCodeProbeError extends Data.TaggedError("OpenCodeProbeError")<{
  readonly cause: unknown;
  readonly detail: string;
}> {}

function normalizeProbeMessage(message: string): string | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (
    trimmed === "An error occurred in Effect.tryPromise" ||
    trimmed === "An error occurred in Effect.try"
  ) {
    return undefined;
  }
  return trimmed;
}

function normalizedErrorMessage(cause: unknown): string | undefined {
  if (cause instanceof OpenCodeProbeError) {
    return normalizeProbeMessage(cause.detail);
  }

  if (!(cause instanceof Error)) {
    return undefined;
  }

  return normalizeProbeMessage(cause.message);
}

function formatOpenCodeProbeError(input: {
  readonly cause: unknown;
  readonly isExternalServer: boolean;
  readonly serverUrl: string;
}): { readonly installed: boolean; readonly message: string } {
  const detail = normalizedErrorMessage(input.cause);
  const lower = detail?.toLowerCase() ?? "";

  if (input.isExternalServer) {
    if (
      lower.includes("401") ||
      lower.includes("403") ||
      lower.includes("unauthorized") ||
      lower.includes("forbidden")
    ) {
      return {
        installed: true,
        message: "OpenCode server rejected authentication. Check the server URL and password.",
      };
    }

    if (
      lower.includes("econnrefused") ||
      lower.includes("enotfound") ||
      lower.includes("fetch failed") ||
      lower.includes("networkerror") ||
      lower.includes("timed out") ||
      lower.includes("timeout") ||
      lower.includes("socket hang up")
    ) {
      return {
        installed: true,
        message: `Couldn't reach the configured OpenCode server at ${input.serverUrl}. Check that the server is running and the URL is correct.`,
      };
    }

    return {
      installed: true,
      message: detail ?? "Failed to connect to the configured OpenCode server.",
    };
  }

  if (lower.includes("enoent") || lower.includes("notfound")) {
    return {
      installed: false,
      message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
    };
  }

  if (lower.includes("quarantine")) {
    return {
      installed: true,
      message:
        "macOS is blocking the OpenCode binary (quarantine). Run `xattr -d com.apple.quarantine $(which opencode)` to fix this.",
    };
  }

  if (lower.includes("invalid code signature") || lower.includes("corrupted")) {
    return {
      installed: true,
      message:
        "macOS killed the OpenCode process due to an invalid code signature. The binary may be corrupted — try reinstalling OpenCode.",
    };
  }

  return {
    installed: true,
    message: detail
      ? `Failed to execute OpenCode CLI health check: ${detail}`
      : "Failed to execute OpenCode CLI health check.",
  };
}

function titleCaseSlug(value: string): string {
  return value
    .split(/[-_/]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function inferDefaultVariant(
  providerID: string,
  variants: ReadonlyArray<string>,
): string | undefined {
  if (variants.length === 1) {
    return variants[0];
  }
  if (providerID === "anthropic" || providerID.startsWith("google")) {
    return variants.includes("high") ? "high" : undefined;
  }
  if (providerID === "openai" || providerID === "opencode") {
    return variants.includes("medium") ? "medium" : variants.includes("high") ? "high" : undefined;
  }
  return undefined;
}

function inferDefaultAgent(agents: ReadonlyArray<Agent>): string | undefined {
  return agents.find((agent) => agent.name === "build")?.name ?? agents[0]?.name ?? undefined;
}

const DEFAULT_OPENCODE_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

function openCodeCapabilitiesForModel(input: {
  readonly providerID: string;
  readonly model: ProviderListResponse["all"][number]["models"][string];
  readonly agents: ReadonlyArray<Agent>;
}): ModelCapabilities {
  const variantValues = Object.keys(input.model.variants ?? {});
  const defaultVariant = inferDefaultVariant(input.providerID, variantValues);
  const variantOptions: ModelCapabilities["variantOptions"] = variantValues.map((value) =>
    Object.assign(
      { value, label: titleCaseSlug(value) },
      defaultVariant === value ? { isDefault: true } : {},
    ),
  );
  const primaryAgents = input.agents.filter(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
  );
  const defaultAgent = inferDefaultAgent(primaryAgents);
  const agentOptions: ModelCapabilities["agentOptions"] = primaryAgents.map((agent) =>
    Object.assign(
      { value: agent.name, label: titleCaseSlug(agent.name) },
      defaultAgent === agent.name ? { isDefault: true } : {},
    ),
  );
  return {
    ...DEFAULT_OPENCODE_MODEL_CAPABILITIES,
    ...(variantOptions.length > 0 ? { variantOptions } : {}),
    ...(agentOptions.length > 0 ? { agentOptions } : {}),
  };
}

function flattenOpenCodeModels(input: OpenCodeInventory): ReadonlyArray<ServerProviderModel> {
  const connected = new Set(input.providerList.connected);
  const models: Array<ServerProviderModel> = [];

  for (const provider of input.providerList.all) {
    if (!connected.has(provider.id)) {
      continue;
    }

    for (const model of Object.values(provider.models)) {
      const name = nonEmptyTrimmed(model.name);
      if (!name) {
        continue;
      }

      const subProvider = nonEmptyTrimmed(provider.name);
      models.push({
        slug: `${provider.id}/${model.id}`,
        name,
        ...(subProvider ? { subProvider } : {}),
        isCustom: false,
        capabilities: openCodeCapabilitiesForModel({
          providerID: provider.id,
          model,
          agents: input.agents,
        }),
      });
    }
  }

  return [...models].sort((left: { name: string }, right: { name: string }) =>
    left.name.localeCompare(right.name),
  );
}

const makePendingOpenCodeProvider = (openCodeSettings: OpenCodeSettings): ServerProvider => {
  const checkedAt = new Date().toISOString();
  const models = providerModelsFromSettings(
    [],
    PROVIDER,
    openCodeSettings.customModels,
    DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  );

  if (!openCodeSettings.enabled) {
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
        message:
          openCodeSettings.serverUrl.trim().length > 0
            ? "OpenCode is disabled in settings. A server URL is configured."
            : "OpenCode is disabled in settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "OpenCode provider status has not been checked in this session yet.",
    },
  });
};

export const OpenCodeProviderLive = Layer.effect(
  OpenCodeProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;

    const checkOpenCodeProviderStatus = Effect.fn("checkOpenCodeProviderStatus")(function* (input: {
      readonly settings: OpenCodeSettings;
      readonly cwd: string;
    }): Effect.fn.Return<ServerProvider, never> {
      const checkedAt = new Date().toISOString();
      const customModels = input.settings.customModels;
      const isExternalServer = input.settings.serverUrl.trim().length > 0;

      const fallback = (cause: unknown, version: string | null = null) => {
        const failure = formatOpenCodeProbeError({
          cause,
          isExternalServer,
          serverUrl: input.settings.serverUrl,
        });
        return buildServerProvider({
          provider: PROVIDER,
          enabled: input.settings.enabled,
          checkedAt,
          models: providerModelsFromSettings(
            [],
            PROVIDER,
            customModels,
            DEFAULT_OPENCODE_MODEL_CAPABILITIES,
          ),
          probe: {
            installed: failure.installed,
            version,
            status: "error",
            auth: { status: "unknown" },
            message: failure.message,
          },
        });
      };

      if (!input.settings.enabled) {
        return buildServerProvider({
          provider: PROVIDER,
          enabled: false,
          checkedAt,
          models: providerModelsFromSettings(
            [],
            PROVIDER,
            customModels,
            DEFAULT_OPENCODE_MODEL_CAPABILITIES,
          ),
          probe: {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: isExternalServer
              ? "OpenCode is disabled in settings. A server URL is configured."
              : "OpenCode is disabled in settings.",
          },
        });
      }

      let version: string | null = null;
      if (!isExternalServer) {
        const versionExit = yield* Effect.exit(
          openCodeRuntime
            .runOpenCodeCommand({
              binaryPath: input.settings.binaryPath,
              args: ["--version"],
              // Host-level probe — no per-project namespace to enter.
              additionalEnv: { [NAMESPACE_PROJECT_ENV]: NAMESPACE_HOST_SENTINEL },
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
              ),
            ),
        );
        if (versionExit._tag === "Failure") {
          return fallback(Cause.squash(versionExit.cause));
        }
        version = parseGenericCliVersion(versionExit.value.stdout) ?? null;

        if (!version) {
          return fallback(
            new Error(
              `Unable to determine OpenCode version from \`opencode --version\` output. Requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`,
            ),
            null,
          );
        }
        if (compareCliVersions(version, MINIMUM_OPENCODE_VERSION) < 0) {
          return buildServerProvider({
            provider: PROVIDER,
            enabled: input.settings.enabled,
            checkedAt,
            models: providerModelsFromSettings(
              [],
              PROVIDER,
              customModels,
              DEFAULT_OPENCODE_MODEL_CAPABILITIES,
            ),
            probe: {
              installed: true,
              version,
              status: "error",
              auth: { status: "unknown" },
              message: `OpenCode v${version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`,
            },
          });
        }
      }

      // Local-server inventory: try cache first. External servers don't
      // benefit from caching (they may have providers connect/disconnect
      // dynamically and we have no version to key on); skip the cache
      // for them.
      let inventory: OpenCodeInventory | null = null;
      const now = Date.now();
      if (!isExternalServer && version) {
        const cached = readCachedInventory({
          version,
          binaryPath: input.settings.binaryPath,
          now,
        });
        if (cached) {
          logEvent("opencode.providerProbe.inventoryCacheHit", {
            version,
            ageMs: now - (inventoryCache?.fetchedAt ?? now),
          });
          inventory = cached;
        }
      }

      if (!inventory) {
        const inventoryExit = yield* Effect.exit(
          Effect.scoped(
            Effect.gen(function* () {
              const probeScopeId = nextOpenCodeProbeScopeId();
              const server = yield* openCodeRuntime
                .connectToOpenCodeServer({
                  binaryPath: input.settings.binaryPath,
                  serverUrl: input.settings.serverUrl,
                  // Host-mode probe with cgroup confinement: the namespace
                  // spawner sees __host__ + the routing trio and wraps the
                  // spawn in ellul-spawn-scope under ellul-user-workload.slice.
                  // No project namespace to enter (probe needs host network),
                  // but the process never lands in the bridge cgroup.
                  additionalEnv: {
                    [NAMESPACE_PROJECT_ENV]: NAMESPACE_HOST_SENTINEL,
                    [NAMESPACE_ADAPTER_ENV]: PROVIDER,
                    [NAMESPACE_SCOPE_ID_ENV]: probeScopeId,
                    [NAMESPACE_SOFT_HINT_MB_ENV]: String(PROBE_SOFT_HINT_MB),
                  },
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
                  ),
                );
              return yield* openCodeRuntime
                .loadOpenCodeInventory(
                  openCodeRuntime.createOpenCodeSdkClient({
                    baseUrl: server.url,
                    directory: input.cwd,
                    ...(isExternalServer && input.settings.serverPassword
                      ? { serverPassword: input.settings.serverPassword }
                      : {}),
                  }),
                )
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new OpenCodeProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
                  ),
                );
            }),
          ),
        );
        if (inventoryExit._tag === "Failure") {
          return fallback(Cause.squash(inventoryExit.cause), version);
        }
        inventory = inventoryExit.value;
        if (!isExternalServer && version) {
          storeInventoryInCache({
            version,
            binaryPath: input.settings.binaryPath,
            fetchedAt: now,
            inventory,
          });
          logEvent("opencode.providerProbe.inventoryCacheStore", {
            version,
            providerCount: inventory.providerList.all.length,
            connectedCount: inventory.providerList.connected.length,
          });
        }
      }

      const models = providerModelsFromSettings(
        flattenOpenCodeModels(inventory),
        PROVIDER,
        customModels,
        DEFAULT_OPENCODE_MODEL_CAPABILITIES,
      );
      const connectedCount = inventory.providerList.connected.length;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version,
          status: connectedCount > 0 ? "ready" : "warning",
          auth: {
            status: connectedCount > 0 ? "authenticated" : "unknown",
            type: "opencode",
          },
          message:
            connectedCount > 0
              ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through ${isExternalServer ? "the configured OpenCode server" : "OpenCode"}.`
              : isExternalServer
                ? "Connected to the configured OpenCode server, but it did not report any connected upstream providers."
                : "OpenCode is available, but it did not report any connected upstream providers.",
        },
      });
    });

    const getProviderSettings = serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.providers.opencode),
    );

    return yield* makeManagedServerProvider<OpenCodeSettings>({
      getSettings: getProviderSettings.pipe(Effect.orDie),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.opencode),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: makePendingOpenCodeProvider,
      checkProvider: getProviderSettings.pipe(
        Effect.flatMap((settings) =>
          checkOpenCodeProviderStatus({
            settings,
            cwd: serverConfig.cwd,
          }),
        ),
      ),
    });
  }),
);
