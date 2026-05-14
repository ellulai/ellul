// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@ellul.ai/types";
import { scopeThreadRef } from "./scoped";

export function deriveActiveThreadRef(
  environmentId: EnvironmentId | null | undefined,
  threadId: ThreadId | null | undefined,
): ScopedThreadRef | null {
  if (!environmentId || !threadId) return null;
  return scopeThreadRef(environmentId, threadId);
}
