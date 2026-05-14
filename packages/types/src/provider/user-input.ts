// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { Effect, Schema } from "effect";
import { TrimmedNonEmptyString } from "../ids";

export const UserInputQuestionOption = Schema.Struct({
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
});
export type UserInputQuestionOption = typeof UserInputQuestionOption.Type;

export const UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyString,
  header: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  options: Schema.Array(UserInputQuestionOption),
  multiSelect: Schema.optional(Schema.Boolean).pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
});
export type UserInputQuestion = typeof UserInputQuestion.Type;

export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;
