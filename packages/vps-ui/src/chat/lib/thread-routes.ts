// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — port of
// pingdotgg/t3code@b0b7b38 apps/web/src/threadRoutes.ts. Route-param
// helpers; t3code uses these with TanStack Router. We have no router
// inside the iframe, so they're pure helpers used to build/parse
// activeThreadId state passed via parent postMessage.

import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@ellul.ai/types";
import type { DraftId } from "../composer-draft-store";
import { scopeThreadRef } from "./scoped";

export type ThreadRouteTarget =
  | { kind: "server"; threadRef: ScopedThreadRef }
  | { kind: "draft"; draftId: DraftId };

export function buildThreadRouteParams(ref: ScopedThreadRef): {
  environmentId: EnvironmentId;
  threadId: ThreadId;
} {
  return { environmentId: ref.environmentId, threadId: ref.threadId };
}

export function buildDraftThreadRouteParams(draftId: DraftId): { draftId: DraftId } {
  return { draftId };
}

export function resolveThreadRouteRef(
  params: Partial<Record<"environmentId" | "threadId", string | undefined>>,
): ScopedThreadRef | null {
  if (!params.environmentId || !params.threadId) return null;
  return scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId);
}

export function resolveThreadRouteTarget(
  params: Partial<Record<"environmentId" | "threadId" | "draftId", string | undefined>>,
): ThreadRouteTarget | null {
  if (params.environmentId && params.threadId) {
    return {
      kind: "server",
      threadRef: scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId),
    };
  }
  if (!params.draftId) return null;
  return { kind: "draft", draftId: params.draftId as DraftId };
}
