// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Thread-title generation backed by OpenCode's SDK. Uses the synchronous
// `prompt()` method which waits for the full model response — ideal for a
// short 3-5 word title. Spawns a scoped server if no external URL is
// configured; the server dies when the scope closes.

import type { Part } from "@opencode-ai/sdk/v2";
import { Effect, Option } from "effect";

import { sandboxIdFromCwd } from "@ellul.ai/types";

import { getNsVethIp } from "../application/namespace/NamespaceSpawn";
import { OpenCodeRuntime } from "../adapters/opencode/runtime";
import { NAMESPACE_ADAPTER_ENV, NAMESPACE_PROJECT_ENV } from "../shared/namespace-spawner";
import { ServerSettingsService } from "../shared/serverSettings";
import { buildThreadTitlePrompt } from "./prompts";
import { TextGenerationError, type TextGenerationShape } from "./service";

const OPENCODE_TITLE_TIMEOUT_MS = 30_000;
const TITLE_MAX_CHARS = 120;

function sanitizeTitle(raw: string): string {
  const collapsed = raw.replace(/[\r\n]+/g, " ").replace(/["'`]/g, "").trim();
  return collapsed.length > TITLE_MAX_CHARS ? collapsed.slice(0, TITLE_MAX_CHARS).trim() : collapsed;
}

export const makeTextGenerationOpenCode = Effect.gen(function* () {
  const openCodeRuntime = yield* OpenCodeRuntime;
  const serverSettingsService = yield* ServerSettingsService;

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = (input) =>
    Effect.gen(function* () {
      const settings = yield* serverSettingsService.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              message: `Could not read server settings: ${cause.message}`,
              cause,
            }),
        ),
        Effect.map((s) => s.providers.opencode),
      );

      if (!settings.enabled) {
        return yield* new TextGenerationError({ message: "OpenCode provider not enabled" });
      }

      const prompt = buildThreadTitlePrompt(input.message);

      const sandboxId = sandboxIdFromCwd(input.cwd);

      const server = yield* openCodeRuntime
        .connectToOpenCodeServer({
          binaryPath: settings.binaryPath,
          serverUrl: settings.serverUrl || undefined,
          additionalEnv: {
            [NAMESPACE_PROJECT_ENV]: sandboxId,
            [NAMESPACE_ADAPTER_ENV]: "opencode-title",
          },
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                message: `OpenCode server connect failed: ${cause.detail}`,
                cause,
              }),
          ),
        );

      const nsIp = server.external ? null : getNsVethIp(sandboxId);
      const serverUrl = nsIp ? server.url.replace(/\/\/[^/:]+/, `//${nsIp}`) : server.url;

      const client = openCodeRuntime.createOpenCodeSdkClient({
        baseUrl: serverUrl,
        directory: input.cwd,
        serverPassword: settings.serverPassword || undefined,
      });

      const session = yield* Effect.tryPromise({
        try: () =>
          client.session.create({
            title: "ellul-title-gen",
            permission: [{ permission: "*", pattern: "*", action: "deny" as const }],
          }),
        catch: (cause) =>
          new TextGenerationError({ message: "Failed to create OpenCode title-gen session", cause }),
      });

      const sessionId = session.data?.id;
      if (!sessionId) {
        return yield* new TextGenerationError({ message: "OpenCode session.create returned no ID" });
      }

      const response = yield* Effect.tryPromise({
        try: () =>
          client.session.prompt({
            sessionID: sessionId,
            parts: [{ type: "text" as const, text: prompt }],
          }),
        catch: (cause) =>
          new TextGenerationError({ message: "OpenCode prompt call failed", cause }),
      });

      const parts = (response.data?.parts ?? []) as ReadonlyArray<Part>;
      let rawText = "";
      for (const part of parts) {
        if (part.type === "text" && "text" in part && typeof part.text === "string") {
          rawText += part.text;
        }
      }

      const title = sanitizeTitle(rawText.trim());
      if (title.length === 0) {
        return yield* new TextGenerationError({ message: "OpenCode returned empty title" });
      }

      return { title } satisfies { readonly title: string };
    }).pipe(
      Effect.scoped,
      Effect.timeoutOption(OPENCODE_TITLE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new TextGenerationError({ message: "OpenCode title request timed out" })),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

  return { generateThreadTitle } satisfies TextGenerationShape;
});
