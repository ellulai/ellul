// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Context Service

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { HOME, ROOT_DIR, ZEROCLAW_DIRS } from '../../config';

const CONTEXT_DIR = `${HOME}/.ellul/context`;
const GLOBAL_CLAUDE = `${HOME}/CLAUDE.md`;

// Files to exclude from project context scanning (handled separately or irrelevant)
const PROJECT_MD_EXCLUDE = new Set(['README.md', 'LICENSE.md', 'CHANGELOG.md', 'CONTRIBUTING.md']);

// Context file info.
export interface ContextFileInfo {
  name: string;
  path: string;
  type: 'context' | 'project' | 'global';
  project?: string;
  size: number;
  modified: Date;
  preview: string;
}

// List all context files.
export function listContextFiles(): ContextFileInfo[] {
  const files: ContextFileInfo[] = [];

  // Custom context files
  if (fs.existsSync(CONTEXT_DIR)) {
    for (const f of fs.readdirSync(CONTEXT_DIR)) {
      if (f.endsWith('.md')) {
        const filePath = path.join(CONTEXT_DIR, f);
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        files.push({
          name: f,
          path: filePath,
          type: 'context',
          size: stat.size,
          modified: stat.mtime,
          preview: content.slice(0, 200),
        });
      }
    }
  }

  // Project context files — .md files in project dirs (supports nested sandbox/app structure)
  if (fs.existsSync(ROOT_DIR)) {
    const scanDir = (dirPath: string, relPath: string) => {
      for (const f of fs.readdirSync(dirPath)) {
        if (!f.endsWith('.md') || PROJECT_MD_EXCLUDE.has(f)) continue;
        const filePath = path.join(dirPath, f);
        try { if (!fs.statSync(filePath).isFile()) continue; } catch { continue; }
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        files.push({
          name: `${relPath}/${f}`,
          path: filePath,
          type: 'project',
          project: relPath,
          size: stat.size,
          modified: stat.mtime,
          preview: content.slice(0, 200),
        });
      }
    };

    for (const entry of fs.readdirSync(ROOT_DIR)) {
      if (ZEROCLAW_DIRS.has(entry) || entry.startsWith('.')) continue;
      const entryPath = path.join(ROOT_DIR, entry);
      try { if (!fs.statSync(entryPath).isDirectory()) continue; } catch { continue; }
      scanDir(entryPath, entry);
      for (const sub of fs.readdirSync(entryPath)) {
        if (sub.startsWith('.')) continue;
        const subPath = path.join(entryPath, sub);
        try { if (!fs.statSync(subPath).isDirectory()) continue; } catch { continue; }
        scanDir(subPath, `${entry}/${sub}`);
      }
    }
  }

  // Global CLAUDE.md
  if (fs.existsSync(GLOBAL_CLAUDE)) {
    const stat = fs.statSync(GLOBAL_CLAUDE);
    const content = fs.readFileSync(GLOBAL_CLAUDE, 'utf8');
    files.push({
      name: 'CLAUDE.md (global)',
      path: GLOBAL_CLAUDE,
      type: 'global',
      size: stat.size,
      modified: stat.mtime,
      preview: content.slice(0, 200),
    });
  }

  return files;
}

// Resolve context file name to path.
function resolveContextPath(fileName: string): string {
  if (fileName === 'CLAUDE.md (global)') {
    return GLOBAL_CLAUDE;
  }
  // Match project context files: {project-path}/{file}.md
  // Supports nested paths (e.g., sbx-xxx/my-app/CLAUDE.md)
  const lastSlash = fileName.lastIndexOf('/');
  if (lastSlash > 0 && fileName.endsWith('.md')) {
    return path.join(ROOT_DIR, fileName);
  }
  if (!fileName.startsWith('/')) {
    return path.join(CONTEXT_DIR, fileName);
  }
  return fileName;
}

// Prevents path traversal attacks via absolute paths or symlinks.
function isAllowedPath(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(CONTEXT_DIR) ||
    resolved.startsWith(ROOT_DIR) ||
    resolved === GLOBAL_CLAUDE;
}

// Get a context file's content.
export function getContextFile(fileName: string): {
  content: string;
  path: string;
  size: number;
  modified: Date;
} | null {
  const filePath = resolveContextPath(decodeURIComponent(fileName));

  if (!isAllowedPath(filePath)) {
    return null;
  }

  if (!fs.existsSync(filePath)) {
    return null;
  }

  // Resolve symlinks to prevent symlink-based traversal
  const realPath = fs.realpathSync(filePath);
  if (!isAllowedPath(realPath)) {
    return null;
  }

  const content = fs.readFileSync(realPath, 'utf8');
  const stat = fs.statSync(realPath);

  return {
    content,
    path: filePath,
    size: stat.size,
    modified: stat.mtime,
  };
}

// Resolve the sandbox root for a project file (first segment under ROOT_DIR).
function resolveSandboxDir(filePath: string): string | null {
  const rel = path.relative(ROOT_DIR, filePath);
  if (!rel || rel.startsWith('..')) return null;
  const first = rel.split(path.sep)[0];
  if (!first || !/^[a-zA-Z0-9._-]+$/.test(first)) return null;
  return path.join(ROOT_DIR, first);
}

// Save a context file.
export function saveContextFile(
  fileName: string,
  content: string
): { success: boolean; path: string; error?: string } {
  const filePath = resolveContextPath(fileName);

  if (!isAllowedPath(filePath)) {
    return { success: false, path: filePath, error: 'Path not allowed' };
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);

  // Regenerate context — pass sandbox dir for project files so ellul-ctx
  // targets the correct project tree (not just ~/projects/ root).
  try {
    const sandboxDir = filePath.startsWith(ROOT_DIR) ? resolveSandboxDir(filePath) : null;
    const args = sandboxDir ? `${sandboxDir} base` : '';
    execSync(`/usr/local/bin/ellul-ctx ${args}`.trim(), {
      cwd: ROOT_DIR,
      timeout: 10000,
    });
  } catch {}

  return { success: true, path: filePath };
}

// Delete a context file.
// Core project files that cannot be deleted (managed by ellul-ctx)
const PROTECTED_PROJECT_FILES = new Set(['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']);

export function deleteContextFile(fileName: string): { success: boolean; error?: string } {
  const filePath = resolveContextPath(decodeURIComponent(fileName));

  if (!isAllowedPath(filePath)) {
    return { success: false, error: 'Path not allowed' };
  }

  // Block deletion of global CLAUDE.md
  if (path.resolve(filePath) === GLOBAL_CLAUDE) {
    return { success: false, error: 'Cannot delete global context' };
  }

  // Block deletion of core project context files (managed by ellul-ctx)
  const baseName = path.basename(filePath);
  if (filePath.startsWith(ROOT_DIR) && PROTECTED_PROJECT_FILES.has(baseName)) {
    return { success: false, error: `Cannot delete ${baseName} — managed by platform` };
  }

  if (!fs.existsSync(filePath)) {
    return { success: false, error: 'File not found' };
  }

  fs.unlinkSync(filePath);
  return { success: true };
}
