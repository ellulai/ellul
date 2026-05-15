// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Mode Detection — determines whether the current workspace is configured
 * for cloud (paid VPS) or local (free) governance.
 *
 * Mode is stored in .ellul/project.json's `mode` field.
 *
 * This module imports ONLY from Node built-ins — never from cloud/ or local/.
 */

import * as fs from 'fs';
import * as path from 'path';

export type ShieldMode = 'cloud' | 'local' | 'byos' | 'uninitialized';

/**
 * Detect the governance mode from .ellul/project.json.
 * Returns 'uninitialized' if no valid project config exists.
 */
export function detectMode(cwd?: string): ShieldMode {
  const dir = cwd ?? process.cwd();
  const file = path.join(dir, '.ellul', 'project.json');

  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (data.mode === 'cloud' || data.mode === 'local' || data.mode === 'byos') {
      return data.mode;
    }
    return 'uninitialized';
  } catch {
    return 'uninitialized';
  }
}

export function isByosSystem(): boolean {
  const home = process.env.HOME || '';
  const configPath = path.join(home, '.ellul', 'config.json');
  if (fs.existsSync(configPath)) return true;
  const sockPaths = [
    '/var/run/ellul-engine.sock',
    path.join(home, '.lima', 'ellul', 'sock', 'ellul-engine.sock'),
  ];
  return sockPaths.some((p) => fs.existsSync(p));
}
