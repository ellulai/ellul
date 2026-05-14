// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/workspace/Services/WorkspacePaths.ts

import * as os from "node:os";
import * as path from "node:path";
import { Context, Effect, FileSystem, Layer, Schema } from "effect";

const PROJECTS_DIR = path.resolve(os.homedir(), "projects");

export class WorkspaceRootNotExistsError extends Schema.TaggedErrorClass<WorkspaceRootNotExistsError>()(
  "WorkspaceRootNotExistsError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace root does not exist: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspaceRootCreateFailedError extends Schema.TaggedErrorClass<WorkspaceRootCreateFailedError>()(
  "WorkspaceRootCreateFailedError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to create workspace root: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspaceRootNotDirectoryError extends Schema.TaggedErrorClass<WorkspaceRootNotDirectoryError>()(
  "WorkspaceRootNotDirectoryError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace root is not a directory: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspaceRootOutsideProjectsError extends Schema.TaggedErrorClass<WorkspaceRootOutsideProjectsError>()(
  "WorkspaceRootOutsideProjectsError",
  {
    workspaceRoot: Schema.String,
    normalizedWorkspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace root escapes the projects sandbox: ${this.normalizedWorkspaceRoot}`;
  }
}

export class WorkspacePathOutsideRootError extends Schema.TaggedErrorClass<WorkspacePathOutsideRootError>()(
  "WorkspacePathOutsideRootError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file path must be relative to the project root: ${this.relativePath}`;
  }
}

export const WorkspacePathsError = Schema.Union([
  WorkspaceRootNotExistsError,
  WorkspaceRootCreateFailedError,
  WorkspaceRootNotDirectoryError,
  WorkspaceRootOutsideProjectsError,
  WorkspacePathOutsideRootError,
]);
export type WorkspacePathsError = typeof WorkspacePathsError.Type;

export interface WorkspacePathsShape {
  readonly normalizeWorkspaceRoot: (
    workspaceRoot: string,
    options?: { readonly createIfMissing?: boolean },
  ) => Effect.Effect<
    string,
    | WorkspaceRootNotExistsError
    | WorkspaceRootCreateFailedError
    | WorkspaceRootNotDirectoryError
    | WorkspaceRootOutsideProjectsError
  >;

  readonly resolveRelativePathWithinRoot: (input: {
    workspaceRoot: string;
    relativePath: string;
  }) => Effect.Effect<
    { absolutePath: string; relativePath: string },
    WorkspacePathOutsideRootError
  >;
}

export class WorkspacePaths extends Context.Service<WorkspacePaths, WorkspacePathsShape>()(
  "ellul/shared/WorkspacePaths",
) {}

const expandHome = (input: string): string =>
  input.startsWith("~") ? path.join(os.homedir(), input.slice(1)) : input;

const absolutePath = (input: string): string => {
  const expanded = expandHome(input.trim());
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(PROJECTS_DIR, expanded);
};

const isWithinProjectsDir = (normalized: string): boolean => {
  const rel = path.relative(PROJECTS_DIR, normalized);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export const WorkspacePathsLive = Layer.effect(
  WorkspacePaths,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return {
      normalizeWorkspaceRoot: (workspaceRoot, options) =>
        Effect.gen(function* () {
          const normalized = absolutePath(workspaceRoot);
          if (!isWithinProjectsDir(normalized)) {
            return yield* new WorkspaceRootOutsideProjectsError({
              workspaceRoot,
              normalizedWorkspaceRoot: normalized,
            });
          }
          const exists = yield* fileSystem.exists(normalized).pipe(Effect.orElseSucceed(() => false));
          if (!exists) {
            if (options?.createIfMissing !== true) {
              return yield* new WorkspaceRootNotExistsError({
                workspaceRoot,
                normalizedWorkspaceRoot: normalized,
              });
            }
            yield* fileSystem.makeDirectory(normalized, { recursive: true }).pipe(
              Effect.mapError(
                () =>
                  new WorkspaceRootCreateFailedError({
                    workspaceRoot,
                    normalizedWorkspaceRoot: normalized,
                  }),
              ),
            );
            return normalized;
          }
          const stat = yield* fileSystem.stat(normalized).pipe(
            Effect.mapError(
              () =>
                new WorkspaceRootNotDirectoryError({
                  workspaceRoot,
                  normalizedWorkspaceRoot: normalized,
                }),
            ),
          );
          if (stat.type !== "Directory") {
            return yield* new WorkspaceRootNotDirectoryError({
              workspaceRoot,
              normalizedWorkspaceRoot: normalized,
            });
          }
          return normalized;
        }),

      resolveRelativePathWithinRoot: ({ workspaceRoot, relativePath }) =>
        Effect.gen(function* () {
          if (path.isAbsolute(relativePath)) {
            return yield* new WorkspacePathOutsideRootError({
              workspaceRoot,
              relativePath,
            });
          }
          const root = absolutePath(workspaceRoot);
          const resolved = path.resolve(root, relativePath);
          const rel = path.relative(root, resolved);
          if (rel.startsWith("..") || path.isAbsolute(rel)) {
            return yield* new WorkspacePathOutsideRootError({
              workspaceRoot,
              relativePath,
            });
          }
          return { absolutePath: resolved, relativePath: rel };
        }),
    };
  }),
);
