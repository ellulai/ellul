// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/git/Utils.ts

import { existsSync } from "node:fs";
import { join } from "node:path";

export function isGitRepository(cwd: string): boolean {
  return existsSync(join(cwd, ".git"));
}
