// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — partial port of
// pingdotgg/t3code@b0b7b38 apps/web/src/vscode-icons.ts (basenameOfPath only;
// full icon manifest + getVscodeIconUrlForEntry land with the VSCode-icons
// follow-up.)

export function basenameOfPath(pathValue: string): string {
  const slashIndex = pathValue.lastIndexOf("/");
  if (slashIndex === -1) return pathValue;
  return pathValue.slice(slashIndex + 1);
}
