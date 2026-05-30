// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { Context, Effect, Schema, Stream } from "effect";
import { IS_ANDROID } from "@vps/shared/platform";

export interface CodexSettings {
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly customModels: ReadonlyArray<string>;
}

export type ClaudeAgentRuntimeMode = "pro" | "lite";

export interface ClaudeAgentLiteSettings {
  /** Milliseconds to keep the spawned process alive between turns. 0 disables. */
  readonly hotWindowMs: number;
}

export interface ClaudeAgentSettings {
  readonly enabled: boolean;
  /** Namespace wrapper (ellul-claude-ns). All user-facing spawns target this. */
  readonly launcherPath: string;
  /** Direct `claude` binary. Probes only (no OAT, host-only). */
  readonly claudePath: string;
  readonly customModels: ReadonlyArray<string>;
  readonly launchArgs: string;
  readonly runtimeMode: ClaudeAgentRuntimeMode;
  readonly lite: ClaudeAgentLiteSettings;
}

export interface OpenCodeSettings {
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly serverUrl: string;
  readonly serverPassword: string;
  readonly customModels: ReadonlyArray<string>;
}

export interface CursorSettings {
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly apiEndpoint: string;
  readonly customModels: ReadonlyArray<string>;
}

export interface ZeroClawAgentSettings {
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly customModels: ReadonlyArray<string>;
}

export interface GrokSettings {
  readonly enabled: boolean;
  readonly binaryPath: string;
  readonly customModels: ReadonlyArray<string>;
}

export interface ServerSettings {
  readonly enableAssistantStreaming: boolean;
  readonly providers: {
    readonly codex: CodexSettings;
    readonly claudeAgent: ClaudeAgentSettings;
    readonly opencode: OpenCodeSettings;
    readonly cursor: CursorSettings;
    readonly zeroclaw: ZeroClawAgentSettings;
    readonly grok: GrokSettings;
  };
}

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message() {
    return `${this.detail} (path=${this.settingsPath})`;
  }
}

export interface ServerSettingsShape {
  readonly getSettings: Effect.Effect<ServerSettings, ServerSettingsError>;
  readonly streamChanges: Stream.Stream<ServerSettings>;
}

export class ServerSettingsService extends Context.Service<
  ServerSettingsService,
  ServerSettingsShape
>()("ellul/shared/ServerSettingsService") {}

// Codex/OpenCode/Cursor go through Effect's ChildProcessSpawner which we've
// replaced with NamespaceChildProcessSpawnerLive — the spawner itself prefixes
// every Command with `sudo ellul-agent-namespace enter --project <p>`, so the
// binary paths here are the DIRECT binaries. Prefixing at the spawner is the
// single chokepoint; wrapper scripts would double-enter.
// Codex installs under the service user's node prefix (`nvm install` lands
// it at `/home/dev/.node/bin/codex`). cursor-agent is installed system-wide
// at /usr/local/bin/cursor-agent (downloads.cursor.com tarball → symlink),
// NOT under nvm — a probe using the codex-style nvm path here was failing
// with ENOENT → "Cursor Agent CLI is not installed or not on PATH". Point
// at the actual on-disk location that `which cursor-agent` resolves to.
export const DEFAULT_CODEX_BINARY = IS_ANDROID
  ? "/tmp/.ellul-cli-cache/codex"
  : "/home/dev/.node/bin/codex";
export const DEFAULT_OPENCODE_BINARY = "/usr/local/bin/opencode";
// cursor-agent is a bash launcher that execs its sibling `node` + `index.js`,
// so it MUST run from its real install dir — the /tmp cli-cache copy is
// divorced from those siblings and fails. Use the real path on Android too.
export const DEFAULT_CURSOR_BINARY = "/usr/local/bin/cursor-agent";

// Claude Agent SDK spawns `claude` via Node's child_process.spawn directly —
// bypasses our Effect ChildProcessSpawner layer. The adapter points
// `pathToClaudeCodeExecutable` at the OAT injection launcher; the launcher
// redeems a single-use issuance token from sovereign-shield for the actual
// OAuth Access Token, sets CLAUDE_CODE_OAUTH_TOKEN in env, and execs into
// the namespace wrapper which finally execs claude.
//
// The bridge issues + redeems the OAT from shield in-process, then passes
// it via env to the namespace wrapper. The OAT never reaches the agent
// (it only lives in bridge memory and the namespace's per-spawn env file,
// which is rm'd after sourcing). Previously a separate launcher process
// did the redeem via execFileSync, but that extra Node.js layer broke the
// Claude Agent SDK's stdin/stdout pipe delivery.
export const DEFAULT_CLAUDE_LAUNCHER = IS_ANDROID
  ? "/tmp/.ellul-cli-cache/claude"
  : "/usr/local/bin/ellul-claude-ns";

export const DEFAULT_CLAUDE_BINARY = IS_ANDROID
  ? "/tmp/.ellul-cli-cache/claude"
  : "/home/dev/.node/bin/claude";

// Resolved via PATH inside the project namespace.
export const DEFAULT_ZEROCLAW_BINARY = "zeroclaw";

export const DEFAULT_GROK_BINARY = IS_ANDROID
  ? "/tmp/.ellul-cli-cache/grok"
  : "/home/dev/.grok/bin/grok";

export const defaultServerSettings: ServerSettings = {
  enableAssistantStreaming: false,
  providers: {
    codex: {
      enabled: true,
      binaryPath: DEFAULT_CODEX_BINARY,
      customModels: [],
    },
    claudeAgent: {
      // BLOCKED on Android: the claude-code native binary is Bun 1.3.13 which
      // bus-errors (SIGTRAP/SIGABRT) under Android proot, AND the Claude Agent
      // SDK spawns it via raw child_process (bypassing the engine spawn proxy)
      // so the grandchild bridge can't fork it anyway. Disabled to avoid
      // spawning a crashing 136MB binary on every probe. Re-enable once
      // upstream Bun/claude-code runs on Android.
      enabled: !IS_ANDROID,
      launcherPath: DEFAULT_CLAUDE_LAUNCHER,
      claudePath: DEFAULT_CLAUDE_BINARY,
      customModels: [],
      launchArgs: "",
      runtimeMode: "pro",
      lite: { hotWindowMs: 30_000 },
    },
    opencode: {
      // On Android the engine runs `opencode serve` as a managed service on a
      // free port and exposes it via OPENCODE_EXTERNAL_SERVER_URL; the bridge
      // uses external-server mode. (Bun.serve works fine in proot — the earlier
      // failure was just a port-in-use, not a Bun limitation.)
      enabled: true,
      binaryPath: DEFAULT_OPENCODE_BINARY,
      serverUrl: process.env.OPENCODE_EXTERNAL_SERVER_URL || "",
      serverPassword: "",
      customModels: [],
    },
    cursor: {
      enabled: true,
      binaryPath: DEFAULT_CURSOR_BINARY,
      apiEndpoint: "",
      customModels: [],
    },
    zeroclaw: {
      enabled: true,
      binaryPath: DEFAULT_ZEROCLAW_BINARY,
      customModels: [],
    },
    grok: {
      enabled: true,
      binaryPath: DEFAULT_GROK_BINARY,
      customModels: [],
    },
  },
};

export const makeStaticServerSettings = (
  overrides?: Partial<ServerSettings["providers"]>,
): ServerSettingsShape => {
  const settings: ServerSettings = overrides
    ? {
        enableAssistantStreaming: defaultServerSettings.enableAssistantStreaming,
        providers: {
          ...defaultServerSettings.providers,
          ...overrides,
        },
      }
    : defaultServerSettings;
  return {
    getSettings: Effect.succeed(settings),
    streamChanges: Stream.empty,
  };
};
