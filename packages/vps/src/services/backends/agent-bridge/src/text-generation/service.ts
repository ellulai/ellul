// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/git/Services/TextGeneration.ts
// (trimmed to the single `generateThreadTitle` method — ellul does not yet
// ship commit-message / PR / branch-name generation).

import type { ProjectId } from "@ellul.ai/types";
import { Context, Data, type Effect } from "effect";

export interface ThreadTitleGenerationInput {
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly message: string;
}

export interface ThreadTitleGenerationResult {
  readonly title: string;
}

export interface TextGenerationShape {
  readonly generateThreadTitle: (
    input: ThreadTitleGenerationInput,
  ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;
}

export class TextGeneration extends Context.Service<TextGeneration, TextGenerationShape>()(
  "ellul/text-generation/TextGeneration",
) {}

export class TextGenerationError extends Data.TaggedError("TextGenerationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
