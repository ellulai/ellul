// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported from
// pingdotgg/t3code@b0b7b38 apps/server/src/attachmentPaths.ts

import path from "node:path";

export const ATTACHMENTS_ROUTE_PREFIX = "/attachments";

export function normalizeAttachmentRelativePath(rawRelativePath: string): string | null {
  const normalized = path.normalize(rawRelativePath).replace(/^[/\\]+/, "");
  if (normalized.length === 0 || normalized.startsWith("..") || normalized.includes("\0")) {
    return null;
  }
  return normalized.replace(/\\/g, "/");
}

export function resolveAttachmentRelativePath(input: {
  readonly attachmentsDir: string;
  readonly relativePath: string;
}): string | null {
  const normalizedRelativePath = normalizeAttachmentRelativePath(input.relativePath);
  if (!normalizedRelativePath) {
    return null;
  }

  const attachmentsRoot = path.resolve(input.attachmentsDir);
  const filePath = path.resolve(path.join(attachmentsRoot, normalizedRelativePath));
  if (!filePath.startsWith(`${attachmentsRoot}${path.sep}`)) {
    return null;
  }
  return filePath;
}
