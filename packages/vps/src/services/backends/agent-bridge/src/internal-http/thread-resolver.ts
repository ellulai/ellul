// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import type { ProjectId, ThreadId } from "@ellul.ai/types";
import { Effect, Option } from "effect";
import * as path from "path";

import { PROJECTS_DIR } from "../config";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";

export const resolveFirstThreadIdForProject = (projectName: string) =>
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery;
    const workspaceRoot = path.join(PROJECTS_DIR, projectName);
    const project = yield* query.getActiveProjectByWorkspaceRoot(workspaceRoot);
    if (Option.isNone(project)) return Option.none<ThreadId>();
    return yield* query.getFirstActiveThreadIdByProjectId(project.value.id);
  });

export const resolveProjectIdByWorkspaceName = (projectName: string) =>
  Effect.gen(function* () {
    const query = yield* ProjectionSnapshotQuery;
    const workspaceRoot = path.join(PROJECTS_DIR, projectName);
    const project = yield* query.getActiveProjectByWorkspaceRoot(workspaceRoot);
    if (Option.isNone(project)) return Option.none<ProjectId>();
    return Option.some(project.value.id);
  });
