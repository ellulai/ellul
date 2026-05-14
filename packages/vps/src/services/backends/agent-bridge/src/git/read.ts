// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { runProcess, type ProcessRunResult } from "../shared/processRunner";

interface LocalGitOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
  readonly allowNonZeroExit?: boolean;
  readonly stdin?: string;
}

async function run(
  cwd: string,
  args: ReadonlyArray<string>,
  options: LocalGitOptions = {},
): Promise<ProcessRunResult> {
  return runProcess("git", args, {
    cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
    maxBufferBytes: options.maxBufferBytes,
    allowNonZeroExit: options.allowNonZeroExit,
    stdin: options.stdin,
  });
}

export interface DiffOptions {
  readonly paths?: ReadonlyArray<string>;
  readonly unified?: number;
  readonly maxBufferBytes?: number;
}

export async function diff(
  cwd: string,
  fromRef: string,
  toRef: string,
  options: DiffOptions = {},
): Promise<string> {
  const args = [
    "diff",
    "--patch",
    "--minimal",
    "--no-color",
    ...(options.unified !== undefined ? [`--unified=${options.unified}`] : []),
    fromRef,
    toRef,
    ...(options.paths && options.paths.length > 0 ? ["--", ...options.paths] : []),
  ];
  const result = await run(cwd, args, { maxBufferBytes: options.maxBufferBytes });
  return result.stdout;
}

export async function revParse(cwd: string, ref: string): Promise<string> {
  const result = await run(cwd, ["rev-parse", "--verify", "--quiet", ref], {
    allowNonZeroExit: true,
  });
  if (result.code !== 0) {
    throw new Error(`git rev-parse ${ref} failed: ${result.stderr.trim()}`);
  }
  const sha = result.stdout.trim();
  if (!sha) throw new Error(`git rev-parse ${ref} returned empty output`);
  return sha;
}

export async function status(cwd: string): Promise<string> {
  const result = await run(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return result.stdout;
}

export async function show(cwd: string, ref: string, path: string): Promise<string> {
  const result = await run(cwd, ["show", `${ref}:${path}`]);
  return result.stdout;
}

export interface LogOptions {
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly format?: string;
}

export async function log(cwd: string, options: LogOptions = {}): Promise<string> {
  const range =
    options.from && options.to
      ? [`${options.from}..${options.to}`]
      : options.to
        ? [options.to]
        : [];
  const args = [
    "log",
    ...(options.format ? [`--pretty=${options.format}`] : []),
    ...(options.limit !== undefined ? [`-n`, String(options.limit)] : []),
    ...range,
  ];
  const result = await run(cwd, args);
  return result.stdout;
}
