// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Thread-title generation. Spawns ellul-claude-ns (not `claude`) via raw
// Node spawn; the ns wrapper enters the namespace and execs claude.
// Failures surface as TextGenerationError → "New thread" fallback.

import { spawn as nodeSpawn, type ChildProcess as NodeChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";

import { sandboxIdFromCwd } from "@ellul.ai/types";
import { Effect, Layer, Option } from "effect";

import { claudeLaunchTrace } from "../../../../shared/claude-launch-trace";
import { mintLaunchEnv } from "../adapters/claude/launch-env";
import { ServerSettingsService } from "../shared/serverSettings";

function dumpFailedSpawn(traceId: string, stdout: string, stderr: string, exitCode: number | null): void {
  try {
    writeFileSync(
      `/var/log/ellul/claude-spawn-${traceId}.log`,
      `exit=${exitCode}\n--- STDOUT (${stdout.length} bytes) ---\n${stdout}\n--- STDERR (${stderr.length} bytes) ---\n${stderr}\n`,
      { mode: 0o644 },
    );
  } catch {
    // Best-effort.
  }
}
import { buildThreadTitlePrompt } from "./prompts";
import {
  TextGeneration,
  TextGenerationError,
  type TextGenerationShape,
} from "./service";

const CLAUDE_MODEL = "claude-haiku-4-5";
const CLAUDE_TIMEOUT_MS = 60_000;
const TITLE_MAX_CHARS = 120;

interface ClaudeJsonResult {
  readonly type?: string;
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly result?: string;
}

function sanitizeTitle(raw: string): string {
  const collapsed = raw.replace(/[\r\n]+/g, " ").replace(/["'`]/g, "").trim();
  return collapsed.length > TITLE_MAX_CHARS ? collapsed.slice(0, TITLE_MAX_CHARS).trim() : collapsed;
}

export const makeTextGenerationClaude = Effect.gen(function* () {
  const serverSettingsService = yield* ServerSettingsService;

  const runClaude = (input: { readonly cwd: string; readonly prompt: string; readonly sandboxId: string }) =>
    Effect.gen(function* () {
      const settings = yield* serverSettingsService.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              message: `Could not read server settings: ${cause.message}`,
              cause,
            }),
        ),
        Effect.map((s) => s.providers.claudeAgent),
      );

      const launchEnv = yield* Effect.promise(() =>
        mintLaunchEnv({
          threadId: `tt:${input.sandboxId}:${Date.now()}`,
          projectId: input.sandboxId,
          settings,
          mode: "thread-title",
        }),
      );
      if (!launchEnv) {
        return yield* new TextGenerationError({
          message:
            "Could not mint Claude OAT issuance token from sovereign-shield. " +
            "Either shield is unreachable or the credential subsystem is misconfigured.",
        });
      }

      const argv = ["-p", "--output-format", "json", "--dangerously-skip-permissions", "--model", CLAUDE_MODEL, input.prompt];

      return yield* Effect.callback<string, TextGenerationError>((resume) => {
        const tr = launchEnv.traceId;
        claudeLaunchTrace("bridge", tr, "spawn-attempt", {
          mode: "thread-title",
          launcherPath: launchEnv.launcherPath,
          argc: argv.length,
          cwd: input.cwd,
          projectId: input.sandboxId,
        });
        const spawnedAt = Date.now();
        let proc: NodeChildProcess;
        try {
          proc = nodeSpawn(launchEnv.launcherPath, argv, {
            cwd: input.cwd,
            env: launchEnv.env,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (cause) {
          claudeLaunchTrace("bridge", tr, "spawn-throw", {
            error: cause instanceof Error ? cause.message : String(cause),
          });
          resume(
            Effect.fail(
              new TextGenerationError({
                message: `Failed to spawn ${launchEnv.launcherPath}`,
                cause,
              }),
            ),
          );
          return;
        }
        claudeLaunchTrace("bridge", tr, "spawn-pid", { pid: proc.pid ?? null });

        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (chunk: Buffer | string) => {
          stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        });
        proc.stderr?.on("data", (chunk: Buffer | string) => {
          stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        });
        proc.on("error", (cause) => {
          claudeLaunchTrace("bridge", tr, "spawn-error-event", {
            error: cause.message,
            durationMs: Date.now() - spawnedAt,
          });
          resume(
            Effect.fail(
              new TextGenerationError({ message: "claude launcher spawn errored", cause }),
            ),
          );
        });
        proc.on("close", (exitCode) => {
          if (exitCode !== 0) dumpFailedSpawn(tr, stdout, stderr, exitCode);
          claudeLaunchTrace("bridge", tr, "spawn-exit", {
            exitCode: exitCode ?? null,
            durationMs: Date.now() - spawnedAt,
            stdoutLen: stdout.length,
            stderrLen: stderr.length,
            dumpPath:
              exitCode !== 0 ? `/var/log/ellul/claude-spawn-${tr}.log` : null,
          });
          if (exitCode === 0) {
            resume(Effect.succeed(stdout));
          } else {
            const detail = stderr.trim() || stdout.trim() || `exit ${exitCode}`;
            resume(
              Effect.fail(
                new TextGenerationError({ message: `claude exited non-zero: ${detail}` }),
              ),
            );
          }
        });

        return Effect.sync(() => {
          if (proc.exitCode === null && !proc.killed) {
            try {
              proc.kill("SIGTERM");
            } catch {
              /* best-effort */
            }
          }
        });
      });
    });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = (input) =>
    Effect.gen(function* () {
      const sandboxId = yield* Effect.try({
        try: () => sandboxIdFromCwd(input.cwd),
        catch: (cause) =>
          new TextGenerationError({
            message: `cwd is not sandbox-scoped: ${input.cwd}`,
            cause,
          }),
      });

      const prompt = buildThreadTitlePrompt(input.message);

      const rawStdout = yield* runClaude({
        cwd: input.cwd,
        prompt,
        sandboxId,
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption(CLAUDE_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new TextGenerationError({ message: "claude title request timed out" })),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );

      let parsed: ClaudeJsonResult;
      try {
        parsed = JSON.parse(rawStdout) as ClaudeJsonResult;
      } catch (cause) {
        return yield* new TextGenerationError({
          message: "claude returned unparseable JSON",
          cause,
        });
      }

      if (parsed.is_error === true || parsed.subtype !== "success") {
        return yield* new TextGenerationError({
          message: `claude reported failure (subtype=${parsed.subtype ?? "none"})`,
        });
      }

      const resultString = typeof parsed.result === "string" ? parsed.result : "";
      const title = sanitizeTitle(resultString);
      if (title.length === 0) {
        return yield* new TextGenerationError({ message: "claude returned empty title" });
      }

      return { title } satisfies { readonly title: string };
    });

  return { generateThreadTitle } satisfies TextGenerationShape;
});

export const TextGenerationClaudeLive = Layer.effect(TextGeneration, makeTextGenerationClaude);
