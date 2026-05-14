// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 packages/contracts/src/git.ts (GitCommandError only)

import { Schema } from "effect";

export class GitCommandError extends Schema.TaggedErrorClass<GitCommandError>()(
  "GitCommandError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Git command failed in ${this.operation}: ${this.command} (${this.cwd}) - ${this.detail}`;
  }
}
