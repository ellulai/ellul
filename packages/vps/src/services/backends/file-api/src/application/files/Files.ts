// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Files Service

import * as fs from 'fs';
import * as path from 'path';
import { SANDBOX_ID_RE } from '@ellul.ai/types';
import { ROOT_DIR, HOME, MAX_FILE_SIZE, ZEROCLAW_DIRS } from '../../config';
import { safeReadFile, safeStat, safeReadDir, shouldIgnore } from '../../utils';

// File tree node.
export interface FileTreeNode {
  name: string;
  type: 'file' | 'dir';
  path: string;
  mtime?: number;
  children?: FileTreeNode[];
  error?: boolean;
}

// NOTE: This is now clearly scoped to sandbox slugs only. Sandbox vs app selection
const ACTIVE_PROJECT_FILE = `${HOME}/.ellul/active-project`;
const SANDBOX_SLUG_RE = SANDBOX_ID_RE;

// Retained under the old `setActiveProject` name to avoid a flood of call-site renames;
export function setActiveProject(sandboxId: string): boolean {
  if (!SANDBOX_SLUG_RE.test(sandboxId)) return false;
  const sandboxPath = path.join(ROOT_DIR, sandboxId);
  if (!fs.existsSync(sandboxPath)) return false;
  fs.mkdirSync(path.dirname(ACTIVE_PROJECT_FILE), { recursive: true });
  fs.writeFileSync(ACTIVE_PROJECT_FILE, sandboxId);
  return true;
}

// Get the active sandbox slug.
export function getActiveProject(): string | null {
  // 1. Session selection
  try {
    if (fs.existsSync(ACTIVE_PROJECT_FILE)) {
      const saved = fs.readFileSync(ACTIVE_PROJECT_FILE, 'utf8').trim();
      if (saved && SANDBOX_SLUG_RE.test(saved) && fs.existsSync(path.join(ROOT_DIR, saved))) {
        return saved;
      }
    }
  } catch {}

  // Helper: list sandbox directories (strict slug match, exclude ZeroClaw infra)
  let sandboxes: string[];
  try {
    sandboxes = fs.readdirSync(ROOT_DIR).filter((f) => {
      if (!SANDBOX_SLUG_RE.test(f)) return false;
      if (ZEROCLAW_DIRS.has(f)) return false;
      try { return fs.statSync(path.join(ROOT_DIR, f)).isDirectory(); } catch { return false; }
    }).sort();
  } catch {
    return null;
  }

  if (sandboxes.length === 0) return null;

  // 2. Pinned sandbox
  for (const slug of sandboxes) {
    try {
      const metaPath = path.join(ROOT_DIR, slug, 'ellul.json');
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta.pinned === true) {
          try { setActiveProject(slug); } catch {}
          return slug;
        }
      }
    } catch {}
  }

  // 3. First sandbox
  const fallback = sandboxes[0] as string;
  try { setActiveProject(fallback); } catch {}
  return fallback;
}

// Read the last-active app subdir (relative to the sandbox root, e.g. "my-app")
export function getActiveApp(sandboxId: string): string | null {
  if (!SANDBOX_SLUG_RE.test(sandboxId)) return null;
  const metaPath = path.join(ROOT_DIR, sandboxId, 'ellul.json');
  try {
    if (!fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { activeApp?: string | null };
    if (!meta.activeApp || typeof meta.activeApp !== 'string') return null;
    // Validate the referenced subdir still exists — stale pointers are ignored.
    if (!fs.existsSync(path.join(ROOT_DIR, sandboxId, meta.activeApp))) return null;
    return meta.activeApp;
  } catch {
    return null;
  }
}

// Persist the last-active app subdir inside the sandbox's `ellul.json`.
export function setActiveApp(sandboxId: string, appSubdir: string | null): boolean {
  if (!SANDBOX_SLUG_RE.test(sandboxId)) return false;
  const sandboxPath = path.join(ROOT_DIR, sandboxId);
  if (!fs.existsSync(sandboxPath)) return false;
  if (appSubdir !== null) {
    if (!/^[a-z0-9][a-z0-9._-]{0,62}$/i.test(appSubdir)) return false;
    if (!fs.existsSync(path.join(sandboxPath, appSubdir))) return false;
  }
  const metaPath = path.join(sandboxPath, 'ellul.json');
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
  const next = { ...current, activeApp: appSubdir };
  fs.writeFileSync(metaPath, JSON.stringify(next, null, 2));
  return true;
}

// SAFETY: never traverses symlinks. A self-referencing symlink like
// `workspace -> .` would otherwise explode into an infinite loop. We use
export function getTree(dir: string, relativePath: string = ''): FileTreeNode {
  const lstats = (() => {
    try { return fs.lstatSync(dir); } catch { return null; }
  })();

  const name = path.basename(dir);

  if (!lstats) {
    return { name, type: 'file', path: relativePath, error: true };
  }

  // Symlink? Show it as a link (file-like) but do NOT recurse — self-references
  // (`workspace -> .`) and long cycles would otherwise walk forever.
  if (lstats.isSymbolicLink()) {
    return { name, type: 'file', path: relativePath, mtime: Math.floor(lstats.mtimeMs) };
  }

  if (!lstats.isDirectory()) {
    return { name, type: 'file', path: relativePath, mtime: Math.floor(lstats.mtimeMs) };
  }

  const children: FileTreeNode[] = [];
  const entries = safeReadDir(dir);

  for (const entry of entries) {
    // few well-known noise dirs that don't start with a dot. `.zeroclaw/` is
    // the per-app agent workspace — platform-managed, gitignored, never shown.
    if (
      entry.startsWith('.') ||
      entry === 'node_modules' ||
      entry === 'dist' ||
      entry === 'build' ||
      entry === '__pycache__' ||
      entry === 'venv'
    ) {
      continue;
    }

    const childPath = path.join(dir, entry);
    const childRelative = relativePath ? `${relativePath}/${entry}` : entry;
    // SAFETY: lstat the child before deciding whether to recurse. Even if it
    // symlink we must not descend — that's how the `workspace -> .` self-link
    let childLstats: ReturnType<typeof fs.lstatSync> | null = null;
    try { childLstats = fs.lstatSync(childPath); } catch {}
    if (childLstats?.isSymbolicLink()) {
      children.push({ name: entry, type: 'file', path: childRelative, mtime: Math.floor(childLstats.mtimeMs) });
      continue;
    }
    const childTree = getTree(childPath, childRelative);
    if (childTree && !childTree.error) {
      children.push(childTree);
    }
  }

  // Sort: directories first, then files, alphabetically
  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { name, type: 'dir', path: relativePath, children };
}

// Get file content with security checks.
// SECURITY: Uses fd-based validation to eliminate TOCTOU race conditions.
export function getFileContent(
  relativePath: string,
  projectPath: string
): {
  content?: string;
  error?: string;
  statusCode: number;
} {
  // Resolve path to prevent path traversal attacks
  const resolvedProjectPath = path.resolve(projectPath);
  const fullPath = path.resolve(projectPath, relativePath);

  if (!fullPath.startsWith(resolvedProjectPath + path.sep) && fullPath !== resolvedProjectPath) {
    return { error: 'Path traversal not allowed', statusCode: 403 };
  }

  if (!fs.existsSync(fullPath)) {
    return { error: 'File not found', statusCode: 404 };
  }

  // Open the file FIRST, then validate the real path of the open fd.
  let fd: number;
  try {
    fd = fs.openSync(fullPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') {
      // O_NOFOLLOW on a symlink — resolve and validate the target
      try {
        const realPath = fs.realpathSync(fullPath);
        if (!realPath.startsWith(resolvedProjectPath + path.sep) && realPath !== resolvedProjectPath) {
          return { error: 'Symlink escape not allowed', statusCode: 403 };
        }
        // Target is within project — open the real path directly
        fd = fs.openSync(realPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      } catch {
        return { error: 'Symlink escape not allowed', statusCode: 403 };
      }
    } else {
      return { error: 'Cannot open file', statusCode: 403 };
    }
  }

  try {
    // Validate the real path of the OPEN fd (race-proof on Linux)
    try {
      const fdPath = fs.readlinkSync(`/proc/self/fd/${fd}`);
      if (!fdPath.startsWith(resolvedProjectPath + path.sep) && fdPath !== resolvedProjectPath) {
        return { error: 'Symlink escape not allowed', statusCode: 403 };
      }
    } catch {
      // /proc/self/fd not available (non-Linux) — fall back to realpathSync on original path
      const realPath = fs.realpathSync(fullPath);
      if (!realPath.startsWith(resolvedProjectPath + path.sep) && realPath !== resolvedProjectPath) {
        return { error: 'Symlink escape not allowed', statusCode: 403 };
      }
    }

    const stat = fs.fstatSync(fd);
    if (stat.size > 500000) {
      return { error: 'File too large', statusCode: 413 };
    }

    // Read from the already-validated fd — no TOCTOU possible
    const content = fs.readFileSync(fd, 'utf8');
    return { content, statusCode: 200 };
  } finally {
    fs.closeSync(fd);
  }
}

// List all projects.
// List sandbox slugs present on disk. Filters strictly to the sandbox slug
export function listProjects(): { projects: string[]; active: string | null } {
  const projects = fs.readdirSync(ROOT_DIR).filter((f) => {
    if (!SANDBOX_SLUG_RE.test(f)) return false;
    if (ZEROCLAW_DIRS.has(f)) return false;
    try { return fs.statSync(path.join(ROOT_DIR, f)).isDirectory(); } catch { return false; }
  });
  const active = getActiveProject();
  return { projects, active };
}

// Parse multipart form data for file uploads.
export interface UploadedFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartParts {
  [key: string]: string | UploadedFile;
}

export function parseMultipart(
  buffer: Buffer,
  contentType: string
): MultipartParts {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!boundaryMatch) {
    throw new Error('No boundary in content-type');
  }
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const parts: MultipartParts = {};

  const boundaryBuffer = Buffer.from('--' + boundary);
  let start = 0;

  while (true) {
    const boundaryIndex = buffer.indexOf(boundaryBuffer, start);
    if (boundaryIndex === -1) break;

    const partStart = boundaryIndex + boundaryBuffer.length + 2; // Skip boundary + CRLF
    const nextBoundary = buffer.indexOf(boundaryBuffer, partStart);
    if (nextBoundary === -1) break;

    const partEnd = nextBoundary - 2; // Exclude trailing CRLF
    const partData = buffer.subarray(partStart, partEnd);

    // Find header/body separator (double CRLF)
    const headerEnd = partData.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      start = nextBoundary;
      continue;
    }

    const headerStr = partData.subarray(0, headerEnd).toString('utf8');
    const body = partData.subarray(headerEnd + 4);

    // Parse headers
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const contentTypeMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);

    if (nameMatch) {
      const fieldName = nameMatch[1] as string;
      if (filenameMatch) {
        parts[fieldName] = {
          filename: filenameMatch[1] as string,
          contentType: contentTypeMatch ? (contentTypeMatch[1] as string) : 'application/octet-stream',
          data: body,
        };
      } else {
        parts[fieldName] = body.toString('utf8');
      }
    }

    start = nextBoundary;
  }

  return parts;
}

// Upload a file to a project.
export function uploadFile(
  file: UploadedFile,
  destPath: string | undefined,
  projectName: string
): {
  success: boolean;
  filename?: string;
  path?: string;
  fullPath?: string;
  size?: number;
  project?: string;
  error?: string;
} {
  const projectDir = path.join(ROOT_DIR, projectName);

  if (!fs.existsSync(projectDir)) {
    return { success: false, error: 'Project not found' };
  }

  // Determine final file path
  let finalPath: string;
  if (destPath) {
    finalPath = path.join(projectDir, destPath);
  } else {
    const uploadsDir = path.join(projectDir, '.uploads');
    fs.mkdirSync(uploadsDir, { recursive: true });
    finalPath = path.join(uploadsDir, file.filename);
  }

  // Security: ensure path stays within project (check both resolved and real path)
  const resolvedPath = path.resolve(finalPath);
  const resolvedProjectDir = path.resolve(projectDir);
  if (!resolvedPath.startsWith(resolvedProjectDir + path.sep) && resolvedPath !== resolvedProjectDir) {
    return { success: false, error: 'Path traversal not allowed' };
  }

  // Create parent directory if needed
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  // SECURITY: Validate parent directory AFTER mkdir, then write using O_NOFOLLOW
  // to prevent symlink race between mkdir and write. O_NOFOLLOW on the final
  const parentReal = fs.realpathSync(path.dirname(resolvedPath));
  if (!parentReal.startsWith(resolvedProjectDir + path.sep) && parentReal !== resolvedProjectDir) {
    return { success: false, error: 'Path traversal not allowed' };
  }

  // Write via fd with O_CREAT|O_WRONLY|O_TRUNC — no O_NOFOLLOW on write since
  const safePath = path.join(parentReal, path.basename(resolvedPath));
  fs.writeFileSync(safePath, file.data);

  // Return relative path for AI context
  const relativePath = path.relative(ROOT_DIR, resolvedPath);

  console.log(`[Upload] Saved file to ${resolvedPath}`);

  return {
    success: true,
    filename: file.filename,
    path: relativePath,
    fullPath: resolvedPath,
    size: file.data.length,
    project: projectName,
  };
}
