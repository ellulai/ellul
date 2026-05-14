// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. —
// ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/provider/acp/CursorAcpSupport.ts

import { type CursorModelOptions } from "@ellul.ai/types";
import { Effect, Layer, Scope } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "../../vendor/t3code/effect-acp/errors";

import type { CursorSettings } from "../../../shared/serverSettings";
import {
  CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
  resolveCursorAcpBaseModelId,
  resolveCursorAcpConfigUpdates,
} from "../provider";
import {
  AcpSessionRuntime,
  type AcpSessionRuntimeOptions,
  type AcpSessionRuntimeShape,
  type AcpSpawnInput,
} from "./AcpSessionRuntime";

type CursorAcpRuntimeCursorSettings = Pick<CursorSettings, "apiEndpoint" | "binaryPath">;

export interface CursorAcpRuntimeInput extends Omit<
  AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined;
  readonly additionalEnv?: Readonly<Record<string, string>>;
}

export interface CursorAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

export function buildCursorAcpSpawnInput(
  cursorSettings: CursorAcpRuntimeCursorSettings | null | undefined,
  cwd: string,
  additionalEnv?: Readonly<Record<string, string>>,
): AcpSpawnInput {
  return {
    command: cursorSettings?.binaryPath || "agent",
    args: [
      ...(cursorSettings?.apiEndpoint ? (["-e", cursorSettings.apiEndpoint] as const) : []),
      "acp",
    ],
    cwd,
    ...(additionalEnv ? { env: additionalEnv } : {}),
  };
}

export const makeCursorAcpRuntime = (
  input: CursorAcpRuntimeInput,
): Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildCursorAcpSpawnInput(input.cursorSettings, input.cwd, input.additionalEnv),
        authMethodId: "cursor_login",
        clientCapabilities: CURSOR_PARAMETERIZED_MODEL_PICKER_CAPABILITIES,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime).pipe(Effect.provide(acpContext));
  });

interface CursorAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntimeShape["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function applyCursorAcpModelSelection<E>(input: {
  readonly runtime: CursorAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly modelOptions: CursorModelOptions | null | undefined;
  readonly mapError: (context: CursorAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    yield* input.runtime.setModel(resolveCursorAcpBaseModelId(input.model)).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          step: "set-model",
        }),
      ),
    );

    const configUpdates = resolveCursorAcpConfigUpdates(
      yield* input.runtime.getConfigOptions,
      input.modelOptions,
    );
    for (const update of configUpdates) {
      yield* input.runtime.setConfigOption(update.configId, update.value).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-config-option",
            configId: update.configId,
          }),
        ),
      );
    }
  });
}
