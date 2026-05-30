// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/provider/Layers/CodexProvider.ts

import {
  Context,
  DateTime,
  Duration,
  Effect,
  Equal,
  Layer,
  Option,
  Result,
  Schema,
  Stream,
  Types,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "../vendor/t3code/effect-codex-app-server/client";
import * as CodexSchema from "../vendor/t3code/effect-codex-app-server/schema";
import * as CodexErrors from "../vendor/t3code/effect-codex-app-server/errors";

import type {
  ServerProvider,
  ServerProviderState,
  ModelCapabilities,
  ServerProviderModel,
  ServerProviderSkill,
} from "@ellul.ai/types";
import { makeManagedServerProvider } from "../../shared/makeManagedServerProvider";
import * as os from "node:os";

import {
  NAMESPACE_ADAPTER_ENV,
  NAMESPACE_HOST_SENTINEL,
  NAMESPACE_PROJECT_ENV,
  NAMESPACE_SCOPE_ID_ENV,
  NAMESPACE_SOFT_HINT_MB_ENV,
} from "../../shared/namespace-spawner";
import { computeWorkloadSliceBudget } from "@vps/shared/memory-budget";
import { buildServerProvider } from "../../shared/providerSnapshot";
import type { ServerProviderShape } from "../../shared/ServerProvider";
import { expandHomePath } from "../../shared/pathExpansion";
import { ServerSettingsService, ServerSettingsError, type CodexSettings } from "../../shared/serverSettings";
import { logEvent } from "../../shared/event-log";
import { safeCwd } from "../../shared/config";
import { IS_ANDROID } from "@vps/shared/platform";

const PROVIDER = "codex" as const;
// codex app-server responds to `initialize` in ~1s once warm, but on Android
// the proot + engine stdio-proxy adds latency AND the first probe fires during
// the cold-boot I/O storm (187MB binary cache copy, opencode DB migration, all
// services starting). 8s is too tight there → spurious "timed out". Give the
// constrained device ample headroom; cloud keeps the snappy 8s.
const PROVIDER_PROBE_TIMEOUT_MS = IS_ANDROID ? 90_000 : 8_000;
const ELLUL_CLIENT_NAME = "ellul_desktop";
const ELLUL_CLIENT_TITLE = "Ellul Desktop";
const ELLUL_CLIENT_VERSION = "1.0.0";

// resource-v2 (docs/v2/architecture/resource-v2/03-spawn-routing.md):
// `codex app-server` is a long-lived JSON-RPC daemon. Without these
// routing vars the probe spawn would land in the bridge cgroup and pin
// MemoryHigh. Setting all three plus __host__ routes through
// ellul-spawn-scope into ellul-user-workload.slice / ellul-probe-codex-<scope>.
//
// Soft hint is tier-driven via computeWorkloadSliceBudget. Scope IDs
// combine module-load timestamp + monotonic counter to avoid restart
// collisions.
const PROBE_SOFT_HINT_MB = computeWorkloadSliceBudget(
  Math.max(512, Math.round(os.totalmem() / (1024 * 1024))),
).probeSoftHintMB;
const PROBE_SCOPE_BOOT_ID = `${Date.now().toString(36)}`;
let _codexProbeGen = 0;
function nextCodexProbeScopeId(): string {
  return `p${PROBE_SCOPE_BOOT_ID}-${++_codexProbeGen}`;
}

export interface CodexProviderShape extends ServerProviderShape {}

export class CodexProvider extends Context.Service<CodexProvider, CodexProviderShape>()(
  "ellul/provider/CodexProvider",
) {}

export interface CodexAppServerProviderSnapshot {
  readonly account: CodexSchema.V2GetAccountResponse;
  readonly version: string | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

const REASONING_EFFORT_LABELS: Record<CodexSchema.V2ModelListResponse__ReasoningEffort, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

function codexAccountAuthLabel(account: CodexSchema.V2GetAccountResponse["account"]) {
  if (!account) return undefined;
  if (account.type === "apiKey") return "OpenAI API Key";

  switch (account.planType) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro 20x Subscription";
    case "prolite":
      return "ChatGPT Pro 5x Subscription";
    case "team":
      return "ChatGPT Team Subscription";
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      account.planType satisfies never;
      return undefined;
  }
}

function mapCodexModelCapabilities(
  model: CodexSchema.V2ModelListResponse__Model,
): ModelCapabilities {
  return {
    reasoningEffortLevels: model.supportedReasoningEfforts.map(({ reasoningEffort }) => ({
      value: reasoningEffort,
      label: REASONING_EFFORT_LABELS[reasoningEffort],
      ...(reasoningEffort === model.defaultReasoningEffort ? { isDefault: true } : {}),
    })),
    supportsFastMode: (model.additionalSpeedTiers ?? []).includes("fast"),
    supportsThinkingToggle: false,
    contextWindowOptions: [],
    promptInjectedEffortLevels: [],
  };
}

const toDisplayName = (model: CodexSchema.V2ModelListResponse__Model): string => {
  return model.displayName
    .replace(/^gpt/i, "GPT")
    .replace(/-([a-z])/g, (_, c) => "-" + c.toUpperCase());
};

function parseCodexModelListResponse(
  response: CodexSchema.V2ModelListResponse,
): ReadonlyArray<ServerProviderModel> {
  return response.data.map((model) => ({
    slug: model.model,
    name: toDisplayName(model),
    isCustom: false,
    capabilities: mapCodexModelCapabilities(model),
  }));
}

function appendCustomCodexModels(
  models: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<string>,
): ReadonlyArray<ServerProviderModel> {
  if (customModels.length === 0) {
    return models;
  }

  const seen = new Set(models.map((model) => model.slug));
  const fallbackCapabilities = models.find((model) => model.capabilities)?.capabilities ?? null;
  const customEntries: ServerProviderModel[] = [];
  for (const rawModel of customModels) {
    const slug = rawModel.trim();
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    customEntries.push({
      slug,
      name: slug,
      isCustom: true,
      capabilities: fallbackCapabilities,
    });
  }
  return customEntries.length === 0 ? models : [...models, ...customEntries];
}

function parseCodexSkillsListResponse(
  response: CodexSchema.V2SkillsListResponse,
  cwd: string,
): ReadonlyArray<ServerProviderSkill> {
  const matchingEntry = response.data.find((entry) => entry.cwd === cwd);
  const skills = matchingEntry
    ? matchingEntry.skills
    : response.data.flatMap((entry) => entry.skills);

  return skills.map((skill) => {
    const shortDescription =
      skill.shortDescription ?? skill.interface?.shortDescription ?? undefined;

    const parsedSkill: Types.Mutable<ServerProviderSkill> = {
      name: skill.name,
      path: skill.path,
      enabled: skill.enabled,
    };

    if (skill.description) {
      parsedSkill.description = skill.description;
    }
    if (skill.scope) {
      parsedSkill.scope = skill.scope;
    }
    if (skill.interface?.displayName) {
      parsedSkill.displayName = skill.interface.displayName;
    }
    if (shortDescription) {
      parsedSkill.shortDescription = shortDescription;
    }

    return parsedSkill;
  });
}

const requestAllCodexModels = Effect.fn("requestAllCodexModels")(function* (
  client: CodexClient.CodexAppServerClientShape,
) {
  const models: ServerProviderModel[] = [];
  let cursor: string | null | undefined = undefined;

  do {
    const response: CodexSchema.V2ModelListResponse = yield* client.request(
      "model/list",
      cursor ? { cursor } : {},
    );
    models.push(...parseCodexModelListResponse(response));
    cursor = response.nextCursor;
  } while (cursor);

  return models;
});

export function buildCodexInitializeParams(): CodexSchema.V1InitializeParams {
  return {
    clientInfo: {
      name: ELLUL_CLIENT_NAME,
      title: ELLUL_CLIENT_TITLE,
      version: ELLUL_CLIENT_VERSION,
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

const probeCodexAppServerProvider = Effect.fn("probeCodexAppServerProvider")(function* (input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly cwd: string;
  readonly customModels?: ReadonlyArray<string>;
}) {
  // Provider probes are scheduled every ~5 minutes by the bridge. Without
  // these markers, a probe spawn that exits 133 / SIGTRAP is invisible —
  // the user only sees "codex unavailable" in the UI hours later. The
  // probe.* events tag the cadence and surface every step of the host
  // sentinel spawn.
  const probeStartedAt = Date.now();
  logEvent("codex.probe.begin", {
    binaryPath: input.binaryPath,
    cwd: input.cwd,
    hasHomePath: !!input.homePath,
    customModelCount: input.customModels?.length ?? 0,
  });
  const clientContext = yield* Layer.build(
    CodexClient.layerCommand({
      command: input.binaryPath,
      args: ["app-server"],
      cwd: input.cwd,
      // Host-mode probe with cgroup confinement. The routing trio routes
      // this spawn through ellul-spawn-scope into
      // ellul-user-workload.slice / ellul-probe-codex-<scope>. CODEX_HOME
      // override (if any) still flows through unchanged.
      env: {
        [NAMESPACE_PROJECT_ENV]: NAMESPACE_HOST_SENTINEL,
        [NAMESPACE_ADAPTER_ENV]: PROVIDER,
        [NAMESPACE_SCOPE_ID_ENV]: nextCodexProbeScopeId(),
        [NAMESPACE_SOFT_HINT_MB_ENV]: String(PROBE_SOFT_HINT_MB),
        ...(input.homePath ? { CODEX_HOME: expandHomePath(input.homePath) } : {}),
      },
    }),
  );
  const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
    Effect.provide(clientContext),
  );

  const initialize = yield* client.request("initialize", {
    clientInfo: {
      name: ELLUL_CLIENT_NAME,
      title: ELLUL_CLIENT_TITLE,
      version: ELLUL_CLIENT_VERSION,
    },
    capabilities: {
      experimentalApi: true,
    },
  });
  yield* client.notify("initialized", undefined);

  const versionMatch = initialize.userAgent.match(/\/([^\s]+)/);
  const version = versionMatch ? versionMatch[1] : undefined;

  const accountResponse = yield* client.request("account/read", {});
  if (!accountResponse.account && accountResponse.requiresOpenaiAuth) {
    logEvent("codex.probe.unauthenticated", {
      durationMs: Date.now() - probeStartedAt,
      version: version ?? null,
    });
    return {
      account: accountResponse,
      version,
      models: appendCustomCodexModels([], input.customModels ?? []),
      skills: [],
    } satisfies CodexAppServerProviderSnapshot;
  }

  const [skillsResponse, models] = yield* Effect.all(
    [
      client.request("skills/list", {
        cwds: [input.cwd],
      }),
      requestAllCodexModels(client),
    ],
    { concurrency: "unbounded" },
  );

  logEvent("codex.probe.ok", {
    durationMs: Date.now() - probeStartedAt,
    version: version ?? null,
    modelCount: models.length,
    skillCount: skillsResponse.data.reduce(
      (acc, entry) => acc + entry.skills.length,
      0,
    ),
    accountType: accountResponse.account?.type ?? null,
  });
  return {
    account: accountResponse,
    version,
    models: appendCustomCodexModels(models, input.customModels ?? []),
    skills: parseCodexSkillsListResponse(skillsResponse, input.cwd),
  } satisfies CodexAppServerProviderSnapshot;
}, Effect.scoped);

const emptyCodexModelsFromSettings = (codexSettings: CodexSettings): ServerProvider["models"] =>
  codexSettings.customModels
    .map((model) => model.trim())
    .filter((model, index, models) => model.length > 0 && models.indexOf(model) === index)
    .map((model) => ({
      slug: model,
      name: model,
      isCustom: true,
      capabilities: null,
    }));

const makePendingCodexProvider = (codexSettings: CodexSettings): ServerProvider => {
  const checkedAt = new Date().toISOString();
  const models = emptyCodexModelsFromSettings(codexSettings);

  if (!codexSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex is disabled in settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    enabled: true,
    checkedAt,
    models,
    skills: [],
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Codex provider status has not been checked in this session yet.",
    },
  });
};

function accountProbeStatus(account: CodexAppServerProviderSnapshot["account"]): {
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProvider["auth"];
  readonly message?: string;
} {
  const authLabel = codexAccountAuthLabel(account.account);
  const auth = {
    status: account.account ? ("authenticated" as const) : ("unknown" as const),
    ...(account.account?.type ? { type: account.account?.type } : {}),
    ...(authLabel ? { label: authLabel } : {}),
  } satisfies ServerProvider["auth"];

  // An account profile present = signed in. requiresOpenaiAuth is a
  // descriptor of ChatGPT accounts (true even for a valid login — codex's
  // own `codex login` reports "Successfully logged in" while account/read
  // still returns requiresOpenaiAuth:true), NOT a "needs auth" flag, so it
  // must only gate the no-account case. (An earlier attempt to gate on it
  // even with an account present created a sign-in loop: login succeeds →
  // re-check still sees requiresOpenaiAuth:true → back to "not signed in".)
  if (account.account) {
    return { status: "ready", auth };
  }

  if (account.requiresOpenaiAuth) {
    return {
      status: "error",
      auth: { status: "unauthenticated" },
      message: "Codex is not signed in. Sign in to continue.",
    };
  }

  return { status: "ready", auth };
}

export const checkCodexProviderStatus = Effect.fn("checkCodexProviderStatus")(function* (
  probe: (input: {
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly cwd: string;
    readonly customModels: ReadonlyArray<string>;
  }) => Effect.Effect<
    CodexAppServerProviderSnapshot,
    CodexErrors.CodexAppServerError,
    ChildProcessSpawner.ChildProcessSpawner
  > = probeCodexAppServerProvider,
): Effect.fn.Return<
  ServerProvider,
  ServerSettingsError,
  ServerSettingsService | ChildProcessSpawner.ChildProcessSpawner
> {
  const codexSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.codex),
  );
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const emptyModels = emptyCodexModelsFromSettings(codexSettings);

  if (!codexSettings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      enabled: false,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Codex is disabled in settings.",
      },
    });
  }

  const probeResult = yield* probe({
    binaryPath: codexSettings.binaryPath,
    ...(codexSettings.homePath ? { homePath: codexSettings.homePath } : {}),
    cwd: safeCwd(),
    customModels: codexSettings.customModels,
  }).pipe(Effect.timeoutOption(Duration.millis(PROVIDER_PROBE_TIMEOUT_MS)), Effect.result);

  if (Result.isFailure(probeResult)) {
    const error = probeResult.failure;
    const installed = !Schema.is(CodexErrors.CodexAppServerSpawnError)(error);
    logEvent("codex.probe.fail", {
      installed,
      errorMessage: error.message,
      errorTag: (error as { _tag?: string })._tag ?? null,
    });
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: installed
          ? `Codex app-server provider probe failed: ${error.message}.`
          : "Codex CLI (`codex`) is not installed or not on PATH.",
      },
    });
  }

  if (Option.isNone(probeResult.success)) {
    logEvent("codex.probe.timeout", {
      timeoutMs: PROVIDER_PROBE_TIMEOUT_MS,
    });
    return buildServerProvider({
      provider: PROVIDER,
      enabled: codexSettings.enabled,
      checkedAt,
      models: emptyModels,
      skills: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Timed out while checking Codex app-server provider status.",
      },
    });
  }

  const snapshot = probeResult.success.value;
  const accountStatus = accountProbeStatus(snapshot.account);

  return buildServerProvider({
    provider: PROVIDER,
    enabled: codexSettings.enabled,
    checkedAt,
    models: snapshot.models,
    skills: snapshot.skills,
    probe: {
      installed: true,
      version: snapshot.version ?? null,
      status: accountStatus.status,
      auth: accountStatus.auth,
      ...(accountStatus.message ? { message: accountStatus.message } : {}),
    },
  });
});

export const CodexProviderLive = Layer.effect(
  CodexProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const checkProvider = checkCodexProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<CodexSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.codex),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.codex),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: makePendingCodexProvider,
      checkProvider,
      refreshInterval: Duration.minutes(5),
    });
  }),
);
