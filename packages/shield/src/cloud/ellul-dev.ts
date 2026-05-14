// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// ellul:dev/build/test. Tar → /_auth/exec/sync; SSE /_auth/exec/run; patches via /_auth/exec/patch.
// Dev: watcher + HMR via incremental patches. SIGINT destroys namespace (workspace persists).

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import type { ParsedArgs } from '../lib/flags';
import { fail, success, info, EXIT, isJsonMode } from '../lib/output';
import { showCommandHelp, registerCommand } from '../lib/help';
import { requireProxy, readProjectJson } from '../lib/context';

// Hardcoded exclusions that are ALWAYS excluded regardless of .gitignore
const ALWAYS_EXCLUDE = [
  '.git/',
  '.env',
  '.env.*',
  '.envrc',
  '.ellulignore',
  'credentials.json',
  'service-account.json',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.htpasswd',
  '.pgpass',
  'node_modules/',
];

registerCommand({
  name: 'dev',
  summary: 'Run dev server in sovereign sandbox',
  usage: 'ellul dev [options]',
  flags: [
    { name: 'project', description: 'Project name override', valueHint: 'name' },
    { name: 'script', description: 'Custom script to run', valueHint: 'script' },
  ],
  examples: [
    'ellul dev',
    'ellul dev --project=myapp',
    'ellul dev --script=dev:custom',
  ],
});

registerCommand({
  name: 'build',
  summary: 'Run build in sovereign sandbox',
  usage: 'ellul build [options]',
  flags: [
    { name: 'project', description: 'Project name override', valueHint: 'name' },
    { name: 'script', description: 'Custom script to run', valueHint: 'script' },
  ],
  examples: [
    'ellul build',
    'ellul build --json',
    'ellul build --project=myapp',
  ],
});

registerCommand({
  name: 'test',
  summary: 'Run tests in sovereign sandbox',
  usage: 'ellul test [options]',
  flags: [
    { name: 'project', description: 'Project name override', valueHint: 'name' },
    { name: 'script', description: 'Custom script to run', valueHint: 'script' },
  ],
  examples: [
    'ellul test',
    'ellul test --json',
    'ellul test --project=myapp',
  ],
});

/**
 * Build a tar.gz buffer of the current workspace.
 * Respects .gitignore + .ellulignore + hardcoded exclusions.
 */
function buildTarball(cwd: string): Buffer {
  const excludes = [...ALWAYS_EXCLUDE];

  // Read .gitignore
  const gitignorePath = path.join(cwd, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    for (const line of fs.readFileSync(gitignorePath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) excludes.push(trimmed);
    }
  }

  // Read .ellulignore (project-specific extras)
  const ellulignorePath = path.join(cwd, '.ellulignore');
  if (fs.existsSync(ellulignorePath)) {
    for (const line of fs.readFileSync(ellulignorePath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) excludes.push(trimmed);
    }
  }

  // Write exclude file to a temp location outside the workspace
  // to avoid it being picked up by the tar itself
  const excludeFile = path.join(os.tmpdir(), `.ellul-tar-exclude-${process.pid}`);
  try {
    fs.writeFileSync(excludeFile, excludes.join('\n') + '\n');
    // Use spawnSync with argv array (no shell) to prevent command injection
    const result = spawnSync('tar', ['czf', '-', `--exclude-from=${excludeFile}`, '.'], {
      cwd,
      maxBuffer: 100 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`tar failed: ${result.stderr?.toString() || `exit code ${result.status}`}`);
    }
    return result.stdout as Buffer;
  } finally {
    try { fs.unlinkSync(excludeFile); } catch {}
  }
}

/**
 * Run sovereign sandbox command (dev/build/test).
 */
export async function runSandbox(cmd: 'dev' | 'build' | 'test', args: ParsedArgs): Promise<void> {
  if (args.has('help')) {
    showCommandHelp(cmd);
    process.exit(0);
  }

  const proxyUrl = requireProxy('sandbox');

  const cwd = process.cwd();

  // Resolve project name from .ellul/project.json (local state, not global config)
  let project = args.get('project');
  if (!project) {
    const projectJson = readProjectJson(cwd);
    if (projectJson) project = projectJson.projectName;
  }

  if (!project) {
    fail(EXIT.USAGE, 'sandbox', 'No project found.', 'Run `ellul init` in this directory, or use --project=NAME.');
  }

  const script = args.get('script');

  // Step 1: Build and upload tarball
  process.stderr.write(`[sandbox] Syncing workspace to VPS...\n`);
  const tarball = buildTarball(cwd);
  process.stderr.write(`[sandbox] Tarball: ${(tarball.length / 1024).toFixed(0)}KB\n`);

  const syncRes = await fetch(`${proxyUrl}/_auth/exec/sync?project=${encodeURIComponent(project)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/gzip' },
    body: new Uint8Array(tarball),
  });

  if (syncRes.status === 401 || syncRes.status === 403) {
    fail(EXIT.AUTH, 'sandbox', 'Authentication failed.', 'Run `ellul login` first.');
  }
  if (!syncRes.ok) {
    const body = await syncRes.text();
    fail(EXIT.NETWORK, 'sandbox', `Sync failed: ${syncRes.status} ${body}`);
  }

  const syncData = await syncRes.json() as { ok: boolean; filesCount: number };
  process.stderr.write(`[sandbox] Synced ${syncData.filesCount} files\n`);

  // Step 2: Start SSE stream
  const sseUrl = `${proxyUrl}/_auth/exec/run?cmd=${cmd}&project=${encodeURIComponent(project)}${script ? `&script=${encodeURIComponent(script)}` : ''}`;

  process.stderr.write(`[sandbox] Starting ${cmd}...\n`);

  const sseRes = await fetch(sseUrl, {
    headers: { Accept: 'text/event-stream' },
  });

  if (sseRes.status === 401 || sseRes.status === 403) {
    fail(EXIT.AUTH, 'sandbox', 'Authentication failed.', 'Run `ellul login` first.');
  }
  if (!sseRes.ok) {
    const body = await sseRes.text();
    fail(EXIT.NETWORK, 'sandbox', `Exec failed: ${sseRes.status} ${body}`);
  }

  // Step 3: Start file watcher for dev mode (incremental patches)
  let watcherCleanup: (() => void) | null = null;
  if (cmd === 'dev') {
    watcherCleanup = startFileWatcher(cwd, project, proxyUrl);
  }

  // Step 4: Stream SSE events to terminal
  let exitCode = 0;
  const reader = sseRes.body!.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write('\n[sandbox] Shutting down...\n');
    if (watcherCleanup) watcherCleanup();
    reader.cancel().catch(() => {});
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Process SSE stream
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      let currentEvent = '';
      let currentData = '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          currentData += (currentData ? '\n' : '') + line.slice(6);
        } else if (line === '') {
          if (currentEvent && currentData) {
            exitCode = handleSSEEvent(currentEvent, currentData, exitCode);
          }
          currentEvent = '';
          currentData = '';
        }
      }
    }
  } catch (err) {
    if (!shuttingDown) {
      process.stderr.write(`[sandbox] Stream error: ${err}\n`);
    }
  }

  if (watcherCleanup) watcherCleanup();

  // Emit structured result for agents
  if (isJsonMode()) {
    if (exitCode === 0) {
      success({ command: cmd, exitCode, project });
    } else {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: { code: 'BUILD_FAILED', message: `Process exited with code ${exitCode}`, exitCode },
      }) + '\n');
    }
  }

  process.exit(exitCode);
}

/**
 * Handle a single SSE event. Returns updated exit code.
 */
function handleSSEEvent(event: string, data: string, currentExitCode: number): number {
  switch (event) {
    case 'meta':
      try {
        const meta = JSON.parse(data);
        if (meta.installCmd) {
          process.stderr.write(`[sandbox] Installing deps: ${meta.installCmd}\n`);
        }
        process.stderr.write(`[sandbox] Preview: ${meta.previewUrl}\n`);
      } catch {}
      return currentExitCode;

    case 'stdout':
      process.stdout.write(data);
      return currentExitCode;

    case 'stderr':
      process.stderr.write(data);
      return currentExitCode;

    case 'exit':
      try {
        const { code } = JSON.parse(data);
        process.stderr.write(`\n[sandbox] Process exited with code ${code}\n`);
        return code ?? 1;
      } catch {
        return 1;
      }

    case 'error':
      try {
        const { message } = JSON.parse(data);
        process.stderr.write(`[sandbox] Error: ${message}\n`);
      } catch {}
      return currentExitCode || 1;

    default:
      return currentExitCode;
  }
}

/**
 * Start a file watcher that sends incremental patches to the VPS.
 *
 * Uses fs.watch with recursive: true. On macOS this uses FSEvents (reliable).
 * On Linux, recursive: true uses inotify per-directory (added in Node 19+).
 *
 * Debounces changes for 150ms to batch rapid saves (IDE auto-format, etc.).
 * Returns a cleanup function.
 */
function startFileWatcher(cwd: string, project: string, proxyUrl: string): () => void {
  const pendingChanges = new Map<string, 'write' | 'delete'>();
  let debounceTimer: NodeJS.Timeout | null = null;
  let patchInFlight = false;

  const sendPatch = async () => {
    if (pendingChanges.size === 0 || patchInFlight) return;

    const changes = new Map(pendingChanges);
    pendingChanges.clear();
    patchInFlight = true;

    const files: Array<{ path: string; content?: string; action: 'write' | 'delete' }> = [];

    for (const [filePath, action] of changes) {
      const relativePath = path.relative(cwd, filePath);

      // Skip excluded files
      if (shouldExclude(relativePath)) continue;

      if (action === 'delete') {
        files.push({ path: relativePath, action: 'delete' });
      } else {
        try {
          // Skip symlinks — prevents uploading files outside the workspace
          // (e.g., a symlink to ~/.ssh/id_rsa would be followed by readFileSync)
          const stat = fs.lstatSync(filePath);
          if (stat.isSymbolicLink()) continue;
          if (!stat.isFile()) continue;

          const content = fs.readFileSync(filePath).toString('base64');
          files.push({ path: relativePath, content, action: 'write' });
        } catch {
          // File deleted between detection and read — treat as delete
          files.push({ path: relativePath, action: 'delete' });
        }
      }
    }

    if (files.length > 0) {
      try {
        const res = await fetch(`${proxyUrl}/_auth/exec/patch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project, files }),
        });
        if (!res.ok) {
          const body = await res.text();
          process.stderr.write(`[watcher] Patch failed: ${body}\n`);
        }
      } catch (err) {
        process.stderr.write(`[watcher] Patch error: ${err}\n`);
      }
    }

    patchInFlight = false;

    // If new changes accumulated during the patch, send them immediately
    if (pendingChanges.size > 0) {
      sendPatch();
    }
  };

  let watcher: fs.FSWatcher | null = null;

  try {
    watcher = fs.watch(cwd, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      // Ignore hidden files, node_modules, etc.
      if (shouldExclude(filename)) return;

      const fullPath = path.join(cwd, filename);

      // Determine action
      let action: 'write' | 'delete' = 'write';
      try {
        fs.statSync(fullPath);
      } catch {
        action = 'delete';
      }

      pendingChanges.set(fullPath, action);

      // Debounce: batch rapid changes
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(sendPatch, 150);
    });
  } catch (err) {
    process.stderr.write(`[watcher] Failed to start: ${err}\n`);
  }

  process.stderr.write(`[watcher] Watching for file changes...\n`);

  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (watcher) {
      try { watcher.close(); } catch {}
    }
  };
}

/**
 * Check if a relative path should be excluded from patching.
 */
function shouldExclude(relativePath: string): boolean {
  // Normalize separators
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');

  // Skip anything inside node_modules, .git, etc.
  for (const seg of segments) {
    if (seg === 'node_modules' || seg === '.git' || seg === '.next' || seg === '.vite' || seg === 'dist') {
      return true;
    }
  }

  // Skip dotenv files
  const basename = segments[segments.length - 1];
  if (basename.startsWith('.env')) return true;

  // Skip credential files
  const credentialFiles = new Set([
    'credentials.json', 'service-account.json',
    '.npmrc', '.pypirc', '.netrc', '.htpasswd', '.pgpass',
  ]);
  if (credentialFiles.has(basename)) return true;

  return false;
}
