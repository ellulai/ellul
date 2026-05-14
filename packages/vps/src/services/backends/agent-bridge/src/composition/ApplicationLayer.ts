// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { Effect, Layer, ManagedRuntime, Path } from "effect";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { OpenCodeRuntimeLive } from "../adapters/opencode/runtime";

import { CheckpointDiffQueryLive } from "../checkpointing/Layers/CheckpointDiffQuery";
import { CheckpointStoreLive } from "../checkpointing/Layers/CheckpointStore";
import { CheckpointReactorLive } from "../orchestration/Layers/CheckpointReactor";
import { OrchestrationReactorLive } from "../orchestration/Layers/OrchestrationReactor";
import { ProviderRuntimeIngestionLive } from "../orchestration/Layers/ProviderRuntimeIngestion";
import { RuntimeReceiptBusLive } from "../orchestration/Layers/RuntimeReceiptBus";
import { ThreadDeletionReactorLive } from "../orchestration/Layers/ThreadDeletionReactor";
import { ProviderCommandReactorLive } from "../orchestration/reactors/provider-command";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer";
import { ProjectionCheckpointRepositoryLive } from "../persistence/Layers/ProjectionCheckpoints";
import { RepositoryIdentityResolverLive } from "../project/Layers/RepositoryIdentityResolver";
import { defaultServerConfig, ServerConfig } from "../shared/config";
import { NamespaceChildProcessSpawnerLive } from "../shared/namespace-spawner";
import { ProviderRegistryLive } from "../shared/ProviderRegistry";
import { makeStaticServerSettings, ServerSettingsService } from "../shared/serverSettings";
import {
  TextGeneration,
  type TextGenerationShape,
  makeTextGenerationClaude,
  makeTextGenerationOpenCode,
} from "../text-generation";
import { WorkspacePathsLive } from "../workspace/Services/WorkspacePaths";
import { ProviderServiceLive } from "./ProviderServiceLayer";
import { PersistenceLayerLive } from "./SqliteLayer";

const PlatformLive = Layer.mergeAll(NodeFileSystem.layer, Path.layer);

const SharedConfigLive = Layer.mergeAll(
  Layer.effect(ServerConfig, Effect.succeed(defaultServerConfig)),
  Layer.effect(ServerSettingsService, Effect.succeed(makeStaticServerSettings())),
);

const TextGenerationLive = Layer.effect(
  TextGeneration,
  Effect.gen(function* () {
    const ocImpl = yield* makeTextGenerationOpenCode;
    const claudeImpl = yield* makeTextGenerationClaude;
    return {
      generateThreadTitle: (input) =>
        ocImpl.generateThreadTitle(input).pipe(
          Effect.catch(() => claudeImpl.generateThreadTitle(input)),
        ),
    } satisfies TextGenerationShape;
  }),
).pipe(Layer.provide(OpenCodeRuntimeLive), Layer.provide(NamespaceChildProcessSpawnerLive));

const ReactorDependenciesLive = Layer.mergeAll(
  ProviderServiceLive,
  RuntimeReceiptBusLive,
  CheckpointStoreLive,
  ProjectionCheckpointRepositoryLive,
  TextGenerationLive,
);

const ProviderRegistryFullLive = ProviderRegistryLive.pipe(
  Layer.provide(NamespaceChildProcessSpawnerLive),
);

const ReactorsLive = Layer.mergeAll(
  ProviderRuntimeIngestionLive,
  ProviderCommandReactorLive,
  CheckpointReactorLive,
  ThreadDeletionReactorLive,
);

const CheckpointQueryLive = CheckpointDiffQueryLive.pipe(Layer.provide(CheckpointStoreLive));

export const ApplicationLayer = OrchestrationReactorLive.pipe(
  Layer.provideMerge(ReactorsLive),
  Layer.provideMerge(CheckpointQueryLive),
  Layer.provideMerge(ReactorDependenciesLive),
  Layer.provideMerge(ProviderRegistryFullLive),
  Layer.provideMerge(OrchestrationLayerLive),
  Layer.provideMerge(RepositoryIdentityResolverLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(SharedConfigLive),
  Layer.provideMerge(PlatformLive),
);

export const makeApplicationRuntime = () => ManagedRuntime.make(ApplicationLayer);
export type ApplicationRuntime = ReturnType<typeof makeApplicationRuntime>;
