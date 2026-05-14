// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// ellul.getZenModels — unary WS RPC handler. Returns the in-memory Zen model
// cache populated by zen-models.service.ts. No Effect-layer services needed.

import type { EllulGetZenModelsResult } from "@ellul.ai/types";
import { Effect } from "effect";

import { getCurrentZenModels } from "../../application/reconciliation/ZenModels";

export const handleGetZenModels = (): Effect.Effect<EllulGetZenModelsResult, never> =>
  Effect.sync(() => ({ models: getCurrentZenModels() }));
