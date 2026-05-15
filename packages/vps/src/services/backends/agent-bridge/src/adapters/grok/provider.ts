// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// Grok provider — health check, version detection, model discovery.
// Simpler than cursor/provider.ts: no parameterized model picker, no
// version-date parsing, no CLI config channel detection.

import * as nodeOs from "node:os";

import type {
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "@ellul.ai/types";
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
import {
  inventoryCacheKeyForBinary,
  loadInventoryCacheFromDisk,
  persistInventoryCacheToDisk,
} from "../../shared/inventory-cache-disk";
import type { ServerProviderShape } from "../../shared/ServerProvider";
import {
  ServerSettingsService,
  ServerSettingsError,
  type GrokSettings,
} from "../../shared/serverSettings";
import * as fs from "node:fs";
import { logEvent } from "../../shared/event-log";
import * as EffectAcpErrors from "../vendor/t3code/effect-acp/errors";
import { AcpSessionRuntime } from "../cursor/acp/AcpSessionRuntime";
import {
  buildCursorDiscoveredModelsFromConfigOptions,
} from "../cursor/provider";

const PROVIDER = "grokAgent" as const;

const PROBE_DEBUG_LOG_PATH = "/var/log/ellul/agent-bridge-debug.log";
function probeDebugLog(msg: string): void {
  try {
    fs.appendFileSync(PROBE_DEBUG_LOG_PATH, `[${new Date().toISOString()}] [grok-probe] ${msg}\n`);
  } catch {}
}

const PROBE_SOFT_HINT_MB = computeWorkloadSliceBudget(
  Math.max(512, Math.round(nodeOs.totalmem() / (1024 * 1024))),
).probeSoftHintMB;
const PROBE_SCOPE_BOOT_ID = `${Date.now().toString(36)}`;
let _grokProbeGen = 0;
function nextGrokProbeScopeId(): string {
  return `p${PROBE_SCOPE_BOOT_ID}-${++_grokProbeGen}`;
}
const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

const INVENTORY_CACHE_TTL_MS = 30 * 60 * 1000;

interface GrokInventoryCacheEntry {
  readonly version: string;
  readonly binaryPath: string;
  readonly fetchedAt: number;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

let grokInventoryCache: GrokInventoryCacheEntry | null = null;

hydrateGrokInventoryCacheFromDisk();

function hydrateGrokInventoryCacheFromDisk(): void {
  const loaded = loadInventoryCacheFromDisk<GrokInventoryCacheEntry>({
    adapter: "grok",
    maxAgeMs: INVENTORY_CACHE_TTL_MS,
    validatePayload: validateGrokInventoryPayload,
  });
  if (!loaded) return;
  grokInventoryCache = loaded.payload;
}

function validateGrokInventoryPayload(raw: unknown): GrokInventoryCacheEntry | null {
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as GrokInventoryCacheEntry).version !== "string" ||
    typeof (raw as GrokInventoryCacheEntry).binaryPath !== "string" ||
    !Number.isFinite((raw as GrokInventoryCacheEntry).fetchedAt) ||
    !Array.isArray((raw as GrokInventoryCacheEntry).models)
  ) {
    return null;
  }
  return raw as GrokInventoryCacheEntry;
}

function readCachedGrokInventory(input: {
  readonly version: string;
  readonly binaryPath: string;
  readonly now: number;
}): ReadonlyArray<ServerProviderModel> | null {
  const cache = grokInventoryCache;
  if (!cache) return null;
  if (cache.version !== input.version) return null;
  if (cache.binaryPath !== input.binaryPath) return null;
  if (input.now - cache.fetchedAt >= INVENTORY_CACHE_TTL_MS) return null;
  return cache.models;
}

function storeGrokInventoryInCache(input: {
  readonly version: string;
  readonly binaryPath: string;
  readonly fetchedAt: number;
  readonly models: ReadonlyArray<ServerProviderModel>;
}): void {
  grokInventoryCache = { ...input };
  const cacheKey =
    inventoryCacheKeyForBinary(input.binaryPath) ?? `version:${input.version}`;
  persistInventoryCacheToDisk<GrokInventoryCacheEntry>({
    adapter: "grok",
    cacheKey,
    fetchedAt: input.fetchedAt,
    payload: { ...input },
  });
}

export function clearGrokInventoryCache(): void {
  grokInventoryCache = null;
}

const GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS = 60_000;
const GROK_REFRESH_INTERVAL = "1 hour";

export interface GrokProviderShape extends ServerProviderShape {}

export class GrokProvider extends Context.Service<GrokProvider, GrokProviderShape>()(
  "ellul/provider/GrokProvider",
) {}

function buildInitialGrokProviderSnapshot(grokSettings: GrokSettings): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = getGrokFallbackModels(grokSettings);

  if (!grokSettings.enabled) {
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
        message: "Grok is disabled in settings.",
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
      message: "Checking Grok CLI availability...",
    },
  });
}

const makeGrokAcpProbeRuntime = (grokSettings: GrokSettings) =>
  Effect.gen(function* () {
    const probeId = Math.random().toString(36).slice(2, 8);
    probeDebugLog(`probeId=${probeId} BEGIN make runtime`);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    probeDebugLog(`probeId=${probeId} got spawner, building Layer`);
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        spawn: {
          command: grokSettings.binaryPath,
          args: ["agent", "stdio"],
          cwd: process.cwd(),
          env: {
            [NAMESPACE_PROJECT_ENV]: NAMESPACE_HOST_SENTINEL,
            [NAMESPACE_ADAPTER_ENV]: "grok",
            [NAMESPACE_SCOPE_ID_ENV]: nextGrokProbeScopeId(),
            [NAMESPACE_SOFT_HINT_MB_ENV]: String(PROBE_SOFT_HINT_MB),
          },
        },
        cwd: process.cwd(),
        clientInfo: { name: "ellul-grok-provider-probe", version: "0.1.0" },
        authMethodId: "xai.api_key",
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
      }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))),
    );
    probeDebugLog(`probeId=${probeId} Layer built, getting AcpSessionRuntime`);
    const runtime = yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
    probeDebugLog(`probeId=${probeId} runtime obtained`);
    return runtime;
  });

const withGrokAcpProbeRuntime = <A, E, R>(
  grokSettings: GrokSettings,
  useRuntime: (acp: AcpSessionRuntime["Service"]) => Effect.Effect<A, E, R>,
) => makeGrokAcpProbeRuntime(grokSettings).pipe(Effect.flatMap(useRuntime), Effect.scoped);

export const discoverGrokModelsViaAcp = (grokSettings: GrokSettings) =>
  withGrokAcpProbeRuntime(grokSettings, (acp) =>
    Effect.map(acp.start(), (started) =>
      buildCursorDiscoveredModelsFromConfigOptions(started.sessionSetupResult.configOptions ?? []),
    ),
  );

export function getGrokFallbackModels(
  grokSettings: Pick<GrokSettings, "customModels">,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], PROVIDER, grokSettings.customModels, EMPTY_CAPABILITIES);
}

const VERSION_TIMEOUT_MS = 8_000;

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g, "");
}

const runGrokCommand = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const grokSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.grok),
    );
    const command = ChildProcess.make(grokSettings.binaryPath, [...args], {
      shell: process.platform === "win32",
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

export interface GrokVersionResult {
  readonly version: string | null;
  readonly status: "ready" | "warning" | "error";
  readonly message?: string;
}

export function parseGrokVersionOutput(result: CommandResult): GrokVersionResult {
  const combined = `${result.stdout}\n${result.stderr}`;
  const plain = stripAnsi(combined).trim();

  if (!plain || result.code !== 0) {
    const lower = combined.toLowerCase();
    if (
      lower.includes("command not found") ||
      lower.includes("not recognized") ||
      lower.includes("no such file")
    ) {
      return {
        version: null,
        status: "error",
        message: "Grok CLI (`grok`) is not installed or not on PATH.",
      };
    }
    return {
      version: null,
      status: "warning",
      message: "Could not determine Grok CLI version.",
    };
  }

  const versionMatch = plain.match(/(\d+\.\d+\.\d+(?:[-.]\w+)?)/);
  return {
    version: versionMatch?.[1] ?? null,
    status: "ready",
  };
}

export const checkGrokProviderStatus = Effect.fn("checkGrokProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const grokSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.grok),
    );
    const checkedAt = new Date().toISOString();
    const fallbackModels = getGrokFallbackModels(grokSettings);

    if (!grokSettings.enabled) {
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
          message: "Grok is disabled in settings.",
        },
      });
    }

    const versionProbe = yield* runGrokCommand(["--version"]).pipe(
      Effect.timeoutOption(VERSION_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: grokSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Grok CLI (`grok`) is not installed or not on PATH."
            : `Failed to execute Grok CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      });
    }

    if (Option.isNone(versionProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: grokSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Grok CLI is installed but timed out while running `grok --version`.",
        },
      });
    }

    const parsed = parseGrokVersionOutput(versionProbe.success.value);

    let discoveredModels = Option.none<ReadonlyArray<ServerProviderModel>>();
    let discoveryWarning: string | undefined;

    const now = Date.now();
    if (parsed.version) {
      const cached = readCachedGrokInventory({
        version: parsed.version,
        binaryPath: grokSettings.binaryPath,
        now,
      });
      if (cached) {
        logEvent("grok.providerProbe.inventoryCacheHit", {
          version: parsed.version,
          ageMs: now - (grokInventoryCache?.fetchedAt ?? now),
          modelCount: cached.length,
        });
        discoveredModels = Option.some(cached);
      }
    }

    if (Option.isNone(discoveredModels)) {
      const discoveryExit = yield* Effect.exit(
        discoverGrokModelsViaAcp(grokSettings).pipe(
          Effect.timeoutOption(GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS),
        ),
      );
      if (Exit.isFailure(discoveryExit)) {
        yield* Effect.logWarning("Grok ACP model discovery failed", {
          cause: Cause.pretty(discoveryExit.cause),
        });
        discoveryWarning = "Grok ACP model discovery failed. Check server logs for details.";
      } else if (Option.isNone(discoveryExit.value)) {
        discoveryWarning = `Grok ACP model discovery timed out after ${GROK_ACP_MODEL_DISCOVERY_TIMEOUT_MS}ms.`;
      } else if (discoveryExit.value.value.length === 0) {
        discoveryWarning = "Grok ACP model discovery returned no built-in models.";
      } else {
        discoveredModels = discoveryExit.value;
        if (parsed.version) {
          storeGrokInventoryInCache({
            version: parsed.version,
            binaryPath: grokSettings.binaryPath,
            fetchedAt: now,
            models: discoveryExit.value.value,
          });
          logEvent("grok.providerProbe.inventoryCacheStore", {
            version: parsed.version,
            modelCount: discoveryExit.value.value.length,
          });
        }
      }
    }

    const message = [parsed.message, discoveryWarning]
      .filter((m): m is string => Boolean(m?.trim()))
      .join(" ") || undefined;

    return buildServerProvider({
      provider: PROVIDER,
      enabled: grokSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings(
        Option.getOrElse(
          Option.filter(discoveredModels, (models) => models.length > 0),
          () => [] as const,
        ),
        PROVIDER,
        grokSettings.customModels,
        EMPTY_CAPABILITIES,
      ),
      probe: {
        installed: true,
        version: parsed.version,
        status:
          discoveryWarning && parsed.status === "ready" ? "warning" : parsed.status,
        auth: { status: "unknown" },
        ...(message ? { message } : {}),
      },
    });
  },
);

export const GrokProviderLive = Layer.effect(
  GrokProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const checkProvider = checkGrokProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<GrokSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.grok),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.grok),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: buildInitialGrokProviderSnapshot,
      checkProvider,
      refreshInterval: GROK_REFRESH_INTERVAL,
    });
  }),
);
