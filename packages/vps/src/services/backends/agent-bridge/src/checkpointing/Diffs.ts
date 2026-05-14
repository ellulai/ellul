// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/checkpointing/Diffs.ts
// (@pierre/diffs replaced by inline unified-diff parser — upstream's shiki-heavy
// dep is UI-only and not worth pulling server-side for a ~30 line parser)

export interface TurnDiffFileSummary {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

interface MutableFileSummary {
  path: string;
  additions: number;
  deletions: number;
}

function extractPathFromGitHeader(line: string): string | null {
  const match = line.match(/^diff --git a\/(.*?) b\/(.*)$/);
  if (!match) return null;
  return match[2] ?? match[1] ?? null;
}

function extractPathFromPlusHeader(line: string): string | null {
  if (!line.startsWith("+++ ")) return null;
  const value = line.slice(4).trim();
  if (value === "/dev/null") return null;
  return value.startsWith("b/") ? value.slice(2) : value;
}

function extractPathFromMinusHeader(line: string): string | null {
  if (!line.startsWith("--- ")) return null;
  const value = line.slice(4).trim();
  if (value === "/dev/null") return null;
  return value.startsWith("a/") ? value.slice(2) : value;
}

export function parseTurnDiffFilesFromUnifiedDiff(
  diff: string,
): ReadonlyArray<TurnDiffFileSummary> {
  const normalized = diff.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return [];

  const lines = normalized.split("\n");
  const files: MutableFileSummary[] = [];
  let current: MutableFileSummary | null = null;
  let inHunk = false;

  for (const line of lines) {
    const gitPath = extractPathFromGitHeader(line);
    if (gitPath !== null) {
      current = { path: gitPath, additions: 0, deletions: 0 };
      files.push(current);
      inHunk = false;
      continue;
    }

    if (!current) {
      const plusPath = extractPathFromPlusHeader(line);
      if (plusPath !== null) {
        current = { path: plusPath, additions: 0, deletions: 0 };
        files.push(current);
        inHunk = false;
        continue;
      }
      const minusPath = extractPathFromMinusHeader(line);
      if (minusPath !== null) {
        current = { path: minusPath, additions: 0, deletions: 0 };
        files.push(current);
        inHunk = false;
        continue;
      }
      continue;
    }

    if (line.startsWith("+++ ")) {
      const plusPath = extractPathFromPlusHeader(line);
      if (plusPath !== null) current.path = plusPath;
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;

    if (line.startsWith("+")) current.additions += 1;
    else if (line.startsWith("-")) current.deletions += 1;
  }

  return files
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    }));
}
