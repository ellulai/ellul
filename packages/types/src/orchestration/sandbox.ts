// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString } from "../ids";
import { ProviderKind } from "../provider/kind";

export const SANDBOX_AGGREGATE_ID = "sandbox-singleton" as const;

export const SandboxAggregateId = Schema.Literal(SANDBOX_AGGREGATE_ID);
export type SandboxAggregateId = typeof SandboxAggregateId.Type;

export const PinnedModelByProvider = Schema.Struct({
  codex: Schema.optionalKey(TrimmedNonEmptyString),
  claudeAgent: Schema.optionalKey(TrimmedNonEmptyString),
  cursor: Schema.optionalKey(TrimmedNonEmptyString),
  opencode: Schema.optionalKey(TrimmedNonEmptyString),
  zeroclaw: Schema.optionalKey(TrimmedNonEmptyString),
  grokAgent: Schema.optionalKey(TrimmedNonEmptyString),
});
export type PinnedModelByProvider = typeof PinnedModelByProvider.Type;

type PinnedModelByProviderCoverage = ProviderKind extends keyof PinnedModelByProvider
  ? keyof PinnedModelByProvider extends ProviderKind
    ? true
    : "PinnedModelByProvider has unknown providers"
  : "PinnedModelByProvider missing providers";
const _pinnedModelByProviderCoverage: PinnedModelByProviderCoverage = true;
void _pinnedModelByProviderCoverage;

export const OrchestrationSandbox = Schema.Struct({
  pinnedModelByProvider: PinnedModelByProvider,
  updatedAt: IsoDateTime,
});
export type OrchestrationSandbox = typeof OrchestrationSandbox.Type;

export const SandboxModelPinnedPayload = Schema.Struct({
  provider: ProviderKind,
  model: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});
export type SandboxModelPinnedPayload = typeof SandboxModelPinnedPayload.Type;

export const SandboxModelUnpinnedPayload = Schema.Struct({
  provider: ProviderKind,
  updatedAt: IsoDateTime,
});
export type SandboxModelUnpinnedPayload = typeof SandboxModelUnpinnedPayload.Type;
