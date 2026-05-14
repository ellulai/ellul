// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * file-writer.ts -- Atomic file writing with tmp+rename pattern and ownership setting.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

import type { FileEntry } from './manifest';

// ─── Atomic file write ──────────────────────────────────────────────

export function writeFileAtomic(entry: FileEntry): void {
  const dir = path.dirname(entry.path);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmp = entry.path + '.rebuild-tmp';
  fs.writeFileSync(tmp, entry.content, { mode: entry.mode ?? 0o755 });
  fs.renameSync(tmp, entry.path);

  if (entry.owner) {
    try { execSync(`chown ${entry.owner}:${entry.owner} ${JSON.stringify(entry.path)}`, { stdio: 'pipe' }); } catch {}
  }
}
