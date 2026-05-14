// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — port of
// pingdotgg/t3code@b0b7b38 apps/web/src/storeSelectors.ts.

import type {
  Project,
  ScopedProjectRef,
  ScopedThreadRef,
  Thread,
  ThreadId,
} from "@ellul.ai/types";
import { selectEnvironmentState, type AppState, type EnvironmentState } from "./store";
import { getThreadFromEnvironmentState } from "./thread-derivation";

export function createProjectSelectorByRef(
  ref: ScopedProjectRef | null | undefined,
): (state: AppState) => Project | undefined {
  return (state) =>
    ref ? selectEnvironmentState(state, ref.environmentId).projectById[ref.projectId] : undefined;
}

function createScopedThreadSelector(
  resolveRef: (state: AppState) => ScopedThreadRef | null | undefined,
): (state: AppState) => Thread | undefined {
  let previousEnvironmentState: EnvironmentState | undefined;
  let previousThreadId: ThreadId | undefined;
  let previousThread: Thread | undefined;

  return (state) => {
    const ref = resolveRef(state);
    if (!ref) return undefined;
    const environmentState = selectEnvironmentState(state, ref.environmentId);
    if (
      previousThread &&
      previousEnvironmentState === environmentState &&
      previousThreadId === ref.threadId
    ) {
      return previousThread;
    }
    previousEnvironmentState = environmentState;
    previousThreadId = ref.threadId;
    previousThread = getThreadFromEnvironmentState(environmentState, ref.threadId);
    return previousThread;
  };
}

export function createThreadSelectorByRef(
  ref: ScopedThreadRef | null | undefined,
): (state: AppState) => Thread | undefined {
  return createScopedThreadSelector(() => ref);
}

export function createThreadSelectorAcrossEnvironments(
  threadId: ThreadId | null | undefined,
): (state: AppState) => Thread | undefined {
  return createScopedThreadSelector((state) => {
    if (!threadId) return undefined;
    for (const [environmentId, environmentState] of Object.entries(state.environmentStateById) as [
      ScopedThreadRef["environmentId"],
      EnvironmentState,
    ][]) {
      if (environmentState.threadShellById[threadId]) {
        return { environmentId, threadId };
      }
    }
    return undefined;
  });
}
