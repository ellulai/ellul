// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/checkpointing/Layers/CheckpointStore.ts
// Rewired from GitCore.execute to shared/processRunner — local git ops only
// (no credentials, no remote interaction); credential-bearing git routes
// through shield-client per docs/v2/operations/04-runbooks/upstream-sync.md deviation #6.

import { randomUUID } from "node:crypto";

import { CheckpointRef, GitCommandError } from "@ellul.ai/types";
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";

import {
  runProcess,
  type ProcessRunOptions,
  type ProcessRunResult,
} from "../../shared/processRunner";
import { CheckpointInvariantError } from "../Errors";
import {
  CheckpointStore,
  type CheckpointStoreShape,
} from "../Services/CheckpointStore";

const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;

interface ExecuteGitInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly maxOutputBytes?: number;
}

interface ExecuteGitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function executeGit(input: ExecuteGitInput): Effect.Effect<ExecuteGitResult, GitCommandError> {
  const options: ProcessRunOptions = {
    cwd: input.cwd,
    env: input.env,
    allowNonZeroExit: input.allowNonZeroExit === true,
    maxBufferBytes: input.maxOutputBytes,
    outputMode: input.maxOutputBytes !== undefined ? "truncate" : "error",
  };
  return Effect.tryPromise({
    try: () => runProcess("git", input.args, options),
    catch: (cause) =>
      new GitCommandError({
        operation: input.operation,
        command: `git ${input.args.join(" ")}`,
        cwd: input.cwd,
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(
    Effect.map(
      (result: ProcessRunResult): ExecuteGitResult => ({
        code: result.code ?? 0,
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    ),
  );
}

const makeCheckpointStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const resolveHeadCommit = (cwd: string): Effect.Effect<string | null, GitCommandError> =>
    executeGit({
      operation: "CheckpointStore.resolveHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.code !== 0) return null;
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  const hasHeadCommit = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit({
      operation: "CheckpointStore.hasHeadCommit",
      cwd,
      args: ["rev-parse", "--verify", "HEAD"],
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.code === 0));

  const resolveCheckpointCommit = (
    cwd: string,
    checkpointRef: CheckpointRef,
  ): Effect.Effect<string | null, GitCommandError> =>
    executeGit({
      operation: "CheckpointStore.resolveCheckpointCommit",
      cwd,
      args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        if (result.code !== 0) return null;
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
    );

  const isGitRepository: CheckpointStoreShape["isGitRepository"] = (cwd) =>
    executeGit({
      operation: "CheckpointStore.isGitRepository",
      cwd,
      args: ["rev-parse", "--is-inside-work-tree"],
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => result.code === 0 && result.stdout.trim() === "true"),
      Effect.catch(() => Effect.succeed(false)),
    );

  const captureCheckpoint: CheckpointStoreShape["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    const operation = "CheckpointStore.captureCheckpoint";

    yield* Effect.acquireUseRelease(
      fs.makeTempDirectory({ prefix: "ellul-fs-checkpoint-" }),
      Effect.fn("captureCheckpoint.withTempDirectory")(function* (tempDir) {
        const tempIndexPath = path.join(tempDir, `index-${randomUUID()}`);
        const commitEnv: NodeJS.ProcessEnv = {
          ...process.env,
          GIT_INDEX_FILE: tempIndexPath,
          GIT_AUTHOR_NAME: "ellul",
          GIT_AUTHOR_EMAIL: "ellul@users.noreply.github.com",
          GIT_COMMITTER_NAME: "ellul",
          GIT_COMMITTER_EMAIL: "ellul@users.noreply.github.com",
        };

        const headExists = yield* hasHeadCommit(input.cwd);
        if (headExists) {
          yield* executeGit({
            operation,
            cwd: input.cwd,
            args: ["read-tree", "HEAD"],
            env: commitEnv,
          });
        }

        yield* executeGit({
          operation,
          cwd: input.cwd,
          args: ["add", "-A", "--", "."],
          env: commitEnv,
        });

        const writeTreeResult = yield* executeGit({
          operation,
          cwd: input.cwd,
          args: ["write-tree"],
          env: commitEnv,
        });
        const treeOid = writeTreeResult.stdout.trim();
        if (treeOid.length === 0) {
          return yield* new GitCommandError({
            operation,
            command: "git write-tree",
            cwd: input.cwd,
            detail: "git write-tree returned an empty tree oid.",
          });
        }

        const message = `ellul checkpoint ref=${input.checkpointRef}`;
        const commitTreeResult = yield* executeGit({
          operation,
          cwd: input.cwd,
          args: ["commit-tree", treeOid, "-m", message],
          env: commitEnv,
        });
        const commitOid = commitTreeResult.stdout.trim();
        if (commitOid.length === 0) {
          return yield* new GitCommandError({
            operation,
            command: "git commit-tree",
            cwd: input.cwd,
            detail: "git commit-tree returned an empty commit oid.",
          });
        }

        yield* executeGit({
          operation,
          cwd: input.cwd,
          args: ["update-ref", input.checkpointRef, commitOid],
        });
      }),
      (tempDir) => fs.remove(tempDir, { recursive: true }),
    ).pipe(
      Effect.catchTag("PlatformError", (error: PlatformError.PlatformError) =>
        Effect.fail(
          new CheckpointInvariantError({
            operation,
            detail: "Failed to capture checkpoint.",
            cause: error,
          }),
        ),
      ),
    );
  });

  const hasCheckpointRef: CheckpointStoreShape["hasCheckpointRef"] = (input) =>
    resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
      Effect.map((commit) => commit !== null),
    );

  const restoreCheckpoint: CheckpointStoreShape["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    const operation = "CheckpointStore.restoreCheckpoint";

    let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);
    if (!commitOid && input.fallbackToHead === true) {
      commitOid = yield* resolveHeadCommit(input.cwd);
    }
    if (!commitOid) return false;

    yield* executeGit({
      operation,
      cwd: input.cwd,
      args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."],
    });
    yield* executeGit({
      operation,
      cwd: input.cwd,
      args: ["clean", "-fd", "--", "."],
    });

    const headExists = yield* hasHeadCommit(input.cwd);
    if (headExists) {
      yield* executeGit({
        operation,
        cwd: input.cwd,
        args: ["reset", "--quiet", "--", "."],
      });
    }

    return true;
  });

  const diffCheckpoints: CheckpointStoreShape["diffCheckpoints"] = Effect.fn("diffCheckpoints")(
    function* (input) {
      const operation = "CheckpointStore.diffCheckpoints";

      let fromCommitOid = yield* resolveCheckpointCommit(input.cwd, input.fromCheckpointRef);
      const toCommitOid = yield* resolveCheckpointCommit(input.cwd, input.toCheckpointRef);

      if (!fromCommitOid && input.fallbackFromToHead === true) {
        const headCommit = yield* resolveHeadCommit(input.cwd);
        if (headCommit) fromCommitOid = headCommit;
      }

      if (!fromCommitOid || !toCommitOid) {
        return yield* new GitCommandError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          detail: "Checkpoint ref is unavailable for diff operation.",
        });
      }

      const result = yield* executeGit({
        operation,
        cwd: input.cwd,
        args: ["diff", "--patch", "--minimal", "--no-color", fromCommitOid, toCommitOid],
        maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      });

      return result.stdout;
    },
  );

  const deleteCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    const operation = "CheckpointStore.deleteCheckpointRefs";

    yield* Effect.forEach(
      input.checkpointRefs,
      (checkpointRef) =>
        executeGit({
          operation,
          cwd: input.cwd,
          args: ["update-ref", "-d", checkpointRef],
          allowNonZeroExit: true,
        }),
      { discard: true },
    );
  });

  return {
    isGitRepository,
    captureCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    deleteCheckpointRefs,
  } satisfies CheckpointStoreShape;
});

export const CheckpointStoreLive = Layer.effect(CheckpointStore, makeCheckpointStore);
