// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/checkpointing/Services/CheckpointStore.ts

import { CheckpointRef } from "@ellul.ai/types";
import { Context } from "effect";
import type { Effect } from "effect";

import type { CheckpointStoreError } from "../Errors";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export interface CheckpointStoreShape {
  readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;
  readonly captureCheckpoint: (
    input: CaptureCheckpointInput,
  ) => Effect.Effect<void, CheckpointStoreError>;
  readonly hasCheckpointRef: (
    input: Omit<RestoreCheckpointInput, "fallbackToHead">,
  ) => Effect.Effect<boolean, CheckpointStoreError>;
  readonly restoreCheckpoint: (
    input: RestoreCheckpointInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;
  readonly diffCheckpoints: (
    input: DiffCheckpointsInput,
  ) => Effect.Effect<string, CheckpointStoreError>;
  readonly deleteCheckpointRefs: (
    input: DeleteCheckpointRefsInput,
  ) => Effect.Effect<void, CheckpointStoreError>;
}

export class CheckpointStore extends Context.Service<CheckpointStore, CheckpointStoreShape>()(
  "ellul/checkpointing/Services/CheckpointStore",
) {}
