// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// File API Main Entry Point

import * as http from 'http';
import * as url from 'url';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

import { SANDBOX_ID_RE, isSandboxId } from '@ellul.ai/types';
import { ALL_LOCALES, DEFAULT_LOCALE } from '@ellul.ai/i18n-consts/locales';
import { PORT, ROOT_DIR, HOME, PATHS } from './config';

const CONSOLE_ORIGIN = (() => {
  try { return fs.readFileSync('/etc/ellul/console-origin', 'utf8').trim(); }
  catch { return ''; }
})();
import {
  getTree,
  getFileContent,
  listProjects,
  getActiveProject,
  setActiveProject,
  setActiveApp,
  parseMultipart,
  uploadFile,
  type UploadedFile,
} from './application/files/Files';
import { detectApps } from './application/files/Apps';
import {
  shapeSandboxList,
  shapeSingleSelection,
  applyProjectIds,
  type ApiAppsResponse,
  type ApiAppResponse,
  type ApiApp,
  type ApiPackage,
  type ApiSandbox,
} from './application/platform/ApiShapes';
import {
  collectProjectEnsureEntries,
  ensureProjectIds,
} from './application/files/ProjectResolver';
import {
  writeAppMetadata,
  writeSandboxMetadata,
  updateSandboxActiveApp,
  writeZeroClawWorkspace,
  ensureAppGitignore,
  bootstrapGit,
  type AppType,
} from './application/files/ProjectScaffold';
import { analyzeRoutesFromSource } from './application/platform/OpenapiAnalyzer';
import { getPreviewHealth, setPreviewApp, startPreview, stopPreview, restartPreview, getProjectPort, releaseProjectPort, releasePortsByPrefix, reconcilePortRegistry, cleanupOrphanedPreviews, getPreviewMetrics, ensureCaddyRoute, checkAndHealOpenApi, resolveOpenApiHeal, getOpenApiHealState, startCompanionPreview, stopCompanionPreview, removeCompanionsByPrefix, getAllPreviewHealth, reconcileCompanions, probePreview, recordVerifyCacheOutcome } from './application/preview/Preview';
import {
  requestInstall,
  getInstallStatus,
  cancelInstall,
  wipeInstallTree,
} from './application/platform/InstallManager';
import { listActive as listActiveUnits } from './application/preview/PreviewUnits';
import { readAdmissionSignals, resolveCandidateReservation } from './application/preview/PreviewAdmission';
import { startReconciler, reconcileOnce, startPreviewRef } from './application/preview/PreviewReconciler';
import { deleteApp as coordinatedDelete } from './application/platform/SandboxDelete';
import { renderPrometheus as renderPreviewPrometheus, snapshot as previewMetricsSnapshot } from './application/preview/PreviewMetrics';
import {
  listContextFiles,
  getContextFile,
  saveContextFile,
  deleteContextFile,
} from './application/platform/Context';
import {
  handleGetIntegrations,
  handleInvalidateIntegrations,
} from './application/integrations/IntegrationsHandler';
import { verifyForwardAuthHmac, refreshInternalToken } from './auth';
import { getCurrentTier as getTierFromService } from './application/platform/Tier';
import { killProcessesOnPorts, restartServices } from './application/platform/Processes';
import {
  setupWebSocket,
  broadcast,
  initWatchers,
  initServerStatusWatcher,
  initPreviewStatusWatcher,
  initWatchdogHealthWatcher,
  startPollingFallback,
} from './application/transport/Websocket';
import {
  listZeroclawWorkspaceFiles,
  getZeroclawWorkspaceFile,
  saveZeroclawWorkspaceFile,
  getZeroclawChannels,
  saveZeroclawChannel,
  startWhatsAppLogin,
  stopWhatsAppLogin,
  handleWhatsAppQrStream,
  getWhatsAppQrPageHtml,
  getZeroclawLlmKey,
  getZeroclawLlmKeys,
  saveZeroclawLlmKey,
  removeZeroclawLlmKey,
} from './application/integrations/Zeroclaw';
import codeBrowserHtml from '@ellul.ai/vps-ui/code-browser';
import { setShieldServiceName } from '@vps/shared/shield-client';

// Identify this service for audit logging (x-service-name header)
setShieldServiceName('file-api');

// to prevent localhost auth bypass. Shield signs headers using file-api's

// Notify the platform API of a security-relevant event (fire-and-forget).
async function notifyApi(event: string): Promise<void> {
  try {
    const apiUrl = fs.readFileSync(PATHS.API_URL, 'utf8').trim();
    const serverId = fs.readFileSync(PATHS.SERVER_ID, 'utf8').trim();
    const token = process.env.AI_PROXY_TOKEN?.trim();
    if (!apiUrl || !token) return;
    const res = await fetch(`${apiUrl}/api/servers/${serverId}/security-event`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.warn(`[file-api] notifyApi(${event}) failed: HTTP ${res.status}`);
  } catch (e) {
    console.warn(`[file-api] notifyApi(${event}) failed:`, (e as Error).message);
  }
}

// Global error handlers
process.on('uncaughtException', (err) => {
  console.error('[file-api] Uncaught exception:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[file-api] Unhandled rejection at:', promise);
  console.error('[file-api] Reason:', reason);
});

process.on('SIGTERM', () => {
  console.log('[file-api] Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[file-api] Received SIGINT, shutting down gracefully');
  process.exit(0);
});

// Parse JSON body from request.
function isValidEnvRecord(val: unknown): val is Record<string, string> {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return false;
  for (const v of Object.values(val)) { if (typeof v !== 'string') return false; }
  return true;
}

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      if (!body) {
        // Empty body is valid for some endpoints (GET-like POST with no payload)
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

// Read config file.
function readConfig(): {
  apps: Array<Record<string, unknown>>;
  hidden: string[];
  overrides: Record<string, Record<string, unknown>>;
} {
  const configPath = path.join(ROOT_DIR, '.ellul.json');
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {}
  return { apps: [], hidden: [], overrides: {} };
}

// Write config file.
function writeConfig(config: Record<string, unknown>): void {
  const configPath = path.join(ROOT_DIR, '.ellul.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

// ============================================
// Code session extraction for gate auth
// ============================================

// Extract __Host-code_session or code_session from a raw Cookie header
function extractCodeSession(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(/(?:__Host-code_session|code_session)=([a-f0-9]{64})/);
  return match?.[1];
}

// Extract a real session ID from X-Auth-Session (filters out synthetic values)
function extractAuthSession(header: string | undefined): string | undefined {
  if (!header) return undefined;
  // forward_auth sets these synthetic values — not real session IDs
  if (header === 'code-token' || header === 'jwt' || header === 'none' ||
      header === 'agent-token' || header === 'preview' || header === 'term-proxy') {
    return undefined;
  }
  return header;
}

// ============================================
// Infrastructure path detection
// ============================================

const DAEMON_PATHS = [
  '/api/mount-volume',
  '/api/flush-volume',
  '/api/force-unmount',
  '/api/grow-volume',
  '/api/update-identity',
  '/api/luks-init',
  '/api/luks-unlock',
  '/api/luks-close',
  '/api/luks-rotate-key',
  '/api/backup-identity',
  '/api/restore-identity',
  '/api/maintenance-mode',
];

// Validate volume device paths to prevent command injection
const VALID_DEVICE = /^\/dev\/(sd|vd|xvd|nvme)[a-z0-9]+$/;
const VALID_DISK_BY_ID = /^\/dev\/disk\/by-id\/(scsi|virtio)-[a-zA-Z0-9_-]+$/;
function isValidDevicePath(device: string): boolean {
  return VALID_DEVICE.test(device) || VALID_DISK_BY_ID.test(device);
}

function isDaemonPath(pathname: string): boolean {
  return DAEMON_PATHS.some(p => pathname === p || pathname.startsWith(p));
}

// Verify an internal service JWT (purpose: 'internal').
function verifyInternalJwt(authHeader: string | undefined): boolean {
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  let jwtSecret: string;
  try {
    jwtSecret = fs.readFileSync(PATHS.JWT_SECRET, 'utf8').trim();
  } catch { return false; }

  const signInput = `${parts[0]}.${parts[1]}`;
  const expectedSig = crypto.createHmac('sha256', jwtSecret).update(signInput).digest('base64url');
  const sigBuf = Buffer.from(parts[2]!, 'base64url');
  const expectedBuf = Buffer.from(expectedSig, 'base64url');
  if (sigBuf.length !== expectedBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return false;

  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    if (payload.purpose !== 'internal') return false;
    if (payload.exp && payload.exp < Date.now() / 1000) return false;
    return true;
  } catch { return false; }
}

// In-memory cache for OpenAPI spec detection (path + spec, 30s TTL)
const openApiSpecCache = new Map<string, { path: string; spec: unknown; timestamp: number }>();

// preview verify result cache — bounded per-app TTL to prevent a chatty agent
const PREVIEW_VERIFY_CACHE_TTL_MS = 3_000;
interface PreviewVerifyCacheEntry { at: number; result: Record<string, unknown> }
const previewVerifyCache = new Map<string, PreviewVerifyCacheEntry>();

// Concurrency guard for runtime installation — prevents parallel apt-get races
const installingRuntimes = new Set<string>();

// Concurrency guard for LUKS key rotation — prevents ambiguous keyslot state
let luksRotationInProgress = false;

const activeUploads = new Set<string>();

// Create HTTP server
const server = http.createServer(async (req, res) => {
  // CORS is handled by Caddy (edge proxy) - file-api only runs on localhost
  res.setHeader('Content-Type', 'application/json');

  // Caddy handles OPTIONS preflight, but handle here as safety fallback
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url || '', true);
  const pathname = parsedUrl.pathname || '/';

  // Get headers as record
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key] = Array.isArray(value) ? value[0] : value;
  }

  // Auth enforcement — all paths use either internal JWT or forward_auth
  const isDaemon = isDaemonPath(pathname);

  // Internal VPS services (agent-bridge, enforcer) use internal JWT on any path
  const hasInternalJwt = verifyInternalJwt(headers['authorization']);

  // SECURITY: Verify HMAC signature to prove headers were set by shield, not injected
  // by a localhost attacker bypassing Caddy. Shield signs the auth headers using
  let hasForwardAuth = verifyForwardAuthHmac(headers);

  // On HMAC failure with X-Auth-User present: token may have rotated.
  if (!hasForwardAuth && headers['x-auth-user'] && headers['x-auth-hmac']) {
    refreshInternalToken();
    hasForwardAuth = verifyForwardAuthHmac(headers);
  }

  if (!hasInternalJwt && !hasForwardAuth) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Authentication required' }));
    return;
  }

  // Daemon paths (mount-volume, luks-*, migrate/*) are infrastructure-only —
  if (isDaemon && !hasInternalJwt) {
    res.writeHead(403);
    res.end(JSON.stringify({ error: 'Forbidden: infrastructure-only endpoint' }));
    return;
  }

  // path must stay under ROOT_DIR, and no segment may be `..` or contain shell
  function resolveProjectDir(identifier: string): string | null {
    if (!identifier || typeof identifier !== 'string') return null;
    const segments = identifier.split('/').filter(Boolean);
    if (segments.length === 0) return null;
    for (const seg of segments) {
      if (seg === '.' || seg === '..') return null;
      if (!/^[a-zA-Z0-9._-]+$/.test(seg)) return null;
    }
    // First segment must be a sandbox slug — everything inside a sandbox is
    if (!isSandboxId(segments[0]!)) return null;

    const resolved = path.resolve(ROOT_DIR, identifier);
    if (!resolved.startsWith(ROOT_DIR + path.sep) && resolved !== ROOT_DIR) return null;
    if (!fs.existsSync(resolved)) return null;
    return segments.join('/');
  }

  // Project path resolution
  const requestedProject = parsedUrl.query.project as string | undefined;
  const showRoot = !requestedProject;
  const resolvedProject = requestedProject ? resolveProjectDir(requestedProject) : null;
  const activeProject = resolvedProject || getActiveProject();
  const projectPath = showRoot || !activeProject ? ROOT_DIR : path.join(ROOT_DIR, activeProject);

  try {
    // ============================================
    // Code Browser SPA (VPS-served iframe)
    // ============================================

    if (pathname === '/browser') {
      // NOTE: Nonce-based CSP is NOT compatible with pre-built SPA bundles because
      const csp = [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self' wss:",
        `frame-ancestors 'self' ${CONSOLE_ORIGIN}`,
        "base-uri 'self'",
        "form-action 'none'",
        "object-src 'none'",
      ].join('; ');

      // Resolve user-identity locale from the URL query param (set by
      // the console iframe wrapper from session.user.preferredLocale —
      // api DB authoritative). Validated against `@ellul.ai/i18n-consts`
      // ALL_LOCALES, the single source of truth. VPS holds nothing
      // locale-related; this is a pure projection.
      const rawLocale = parsedUrl.query.locale as string | undefined;
      const locale = rawLocale && (ALL_LOCALES as readonly string[]).includes(rawLocale)
        ? rawLocale
        : DEFAULT_LOCALE;

      // Inject settings so code browser has desktopViewMode + locale synchronously (no flash)
      let html = codeBrowserHtml;
      try {
        const raw = fs.readFileSync('/etc/ellul/shield-data/settings.json', 'utf8');
        const parsed = JSON.parse(raw);
        const settingsScript = `<script>window.__SHIELD_SETTINGS__=${JSON.stringify({
          desktopViewMode: parsed.desktopViewMode || 'focus',
          locale,
        })};</script>`;
        html = html.replace('<script', settingsScript + '<script');
      } catch {
        // settings missing — apply defaults BUT still inject locale so
        // vps-ui's IntlRoot finds it in __SHIELD_SETTINGS__.
        const settingsScript = `<script>window.__SHIELD_SETTINGS__=${JSON.stringify({
          desktopViewMode: 'focus',
          locale,
        })};</script>`;
        html = html.replace('<script', settingsScript + '<script');
      }

      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': csp,
        'Cache-Control': 'no-store',
      });
      res.end(html);
      return;
    }

    // ============================================
    // File API endpoints
    // ============================================

    // GET /api/tree
    if (pathname === '/api/tree') {
      const tree = getTree(projectPath);
      const json = JSON.stringify({ project: showRoot ? 'projects' : (requestedProject || activeProject), tree });
      res.writeHead(200, { 'Content-Length': Buffer.byteLength(json) });
      res.end(json);
      return;
    }

    // GET /api/file
    if (pathname === '/api/file') {
      let relativePath = parsedUrl.query.path as string;
      if (!relativePath) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing path parameter' }));
        return;
      }

      // Resolve display name prefix in path (e.g., "Hello World/index.html" → "hello-world/index.html")
      const slashIdx = relativePath.indexOf('/');
      if (slashIdx > 0) {
        const prefix = relativePath.substring(0, slashIdx);
        const resolved = resolveProjectDir(prefix);
        if (resolved && resolved !== prefix) {
          relativePath = resolved + relativePath.substring(slashIdx);
        }
      }

      const result = getFileContent(relativePath, projectPath);
      if (result.error) {
        res.writeHead(result.statusCode);
        res.end(JSON.stringify({ error: result.error }));
        return;
      }

      res.setHeader('Content-Type', 'text/plain');
      res.writeHead(200, { 'Content-Length': Buffer.byteLength(result.content!) });
      res.end(result.content);
      return;
    }

    // POST /api/fs/upload
    if (req.method === 'POST' && pathname === '/api/fs/upload') {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk);
        }
        const buffer = Buffer.concat(chunks);
        const contentType = headers['content-type'] || '';
        const parts = parseMultipart(buffer, contentType);

        const file = parts.file as UploadedFile | undefined;
        if (!file || !file.data) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'No file provided' }));
          return;
        }

        const destPath = (parts.path as string) || undefined;
        const targetProject = (parts.project as string) || activeProject || '';

        const result = uploadFile(file, destPath, targetProject);
        res.writeHead(result.success ? 200 : 400);
        res.end(JSON.stringify(result));
      } catch (e) {
        const error = e as Error;
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Upload failed: ' + error.message }));
      }
      return;
    }

    // GET /api/tier
    if (pathname === '/api/tier') {
      const tier = getTierFromService();
      res.writeHead(200);
      res.end(JSON.stringify({ tier }));
      return;
    }

    // POST /api/restart-services
    if (req.method === 'POST' && pathname === '/api/restart-services') {
      const tier = getTierFromService();
      const result = restartServices(tier);
      res.writeHead(result.success ? 200 : 500);
      res.end(JSON.stringify(result));
      return;
    }

    // GET /api/status
    if (pathname === '/api/status') {
      // Walk up looking for the repo root. projectPath may be: ROOT_DIR
      let repoRoot: string | null = null;
      {
        let probe = projectPath;
        while (probe.startsWith(ROOT_DIR) && probe !== ROOT_DIR) {
          const dotGit = path.join(probe, '.git');
          if (fs.existsSync(dotGit)) { repoRoot = probe; break; }
          const parent = path.dirname(probe);
          if (parent === probe) break;
          probe = parent;
        }
      }

      if (!repoRoot) {
        res.writeHead(200);
        res.end(JSON.stringify({
          project: activeProject,
          isRepo: false,
          modified: [],
          stats: '',
        }));
        return;
      }

      const { exec } = await import('child_process');
      const runCmd = (cmd: string): Promise<string> =>
        new Promise((resolve) => {
          exec(cmd, { cwd: repoRoot!, timeout: 5000 }, (err, stdout) => {
            resolve(err ? '' : stdout.trim());
          });
        });

      const statusOutput = await runCmd('git status --porcelain');
      const diffOutput = await runCmd('git diff --stat');

      const modified: Array<{ status: string; file: string; oldPath?: string }> = [];
      if (statusOutput) {
        for (const line of statusOutput.split('\n')) {
          if (line.trim()) {
            const statusCode = line.substring(0, 2).trim() || 'M';
            const filePart = line.substring(3);
            if (statusCode.startsWith('R') && filePart.includes(' -> ')) {
              const [oldPath, newPath] = filePart.split(' -> ');
              modified.push({ status: 'R', file: newPath!.trim(), oldPath: oldPath!.trim() });
            } else {
              modified.push({ status: statusCode, file: filePart });
            }
          }
        }
      }

      res.writeHead(200);
      res.end(
        JSON.stringify({
          project: activeProject,
          isRepo: true,
          repoRoot: path.relative(ROOT_DIR, repoRoot),
          modified,
          stats: diffOutput || '',
        })
      );
      return;
    }

    // GET /api/diff — unified diff for a changed file
    if (pathname === '/api/diff') {
      const diffPath = parsedUrl.query.path as string | undefined;
      const diffStatus = parsedUrl.query.status as string | undefined;
      const diffProject = parsedUrl.query.project as string | undefined;

      if (!diffPath || !diffStatus) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'path and status are required' }));
        return;
      }

      // Reject absolute paths
      if (diffPath.startsWith('/')) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Path must be relative' }));
        return;
      }

      // Resolve project directory
      const diffProjectDir = diffProject
        ? path.join(ROOT_DIR, diffProject)
        : projectPath;

      if (!fs.existsSync(diffProjectDir)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
      }

      // Path canonicalization: resolve and check escape
      const resolvedDiffPath = path.resolve(diffProjectDir, diffPath);
      const relative = path.relative(diffProjectDir, resolvedDiffPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Path escapes project root' }));
        return;
      }

      // Untracked files have no diff
      if (diffStatus === '??') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Build git diff command based on status (or commit sha)
      const { execFile } = await import('child_process');
      const diffSha = parsedUrl.query.sha as string | undefined;
      if (diffSha && !/^[0-9a-f]{7,40}$/.test(diffSha)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid sha' }));
        return;
      }
      const gitArgs: string[] = ['diff'];
      if (diffSha) {
        // Commit-specific diff: git diff <sha>^..<sha> -- <path>
        gitArgs.push(`${diffSha}^`, diffSha);
      } else if (diffStatus === 'A') {
        gitArgs.push('--cached');
      }
      gitArgs.push('--', diffPath);

      const diffResult = await new Promise<string>((resolve) => {
        execFile('git', gitArgs, { cwd: diffProjectDir, timeout: 10_000 }, (err, stdout) => {
          resolve(err ? '' : stdout);
        });
      });

      // Return 200 with diff content (may be empty for edge cases)
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(diffResult);
      return;
    }

    // GET /api/search — literal substring search across project files
    if (pathname === '/api/search') {
      const searchQuery = (parsedUrl.query.q as string || '').trim();
      const searchProject = parsedUrl.query.project as string | undefined;
      const searchLimit = Math.min(parseInt(parsedUrl.query.limit as string || '100', 10) || 100, 500);
      const searchGlob = (parsedUrl.query.glob as string || '').trim().slice(0, 200);

      if (!searchQuery || searchQuery.length > 200) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: searchQuery ? 'Query exceeds 200 chars' : 'Query is required' }));
        return;
      }

      // Resolve project directory
      const searchDir = searchProject
        ? path.join(ROOT_DIR, searchProject)
        : projectPath;

      if (!searchDir.startsWith(ROOT_DIR) || !fs.existsSync(searchDir)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
      }

      const { execFile: execFileSearch } = await import('child_process');

      // Check if git repo exists for git grep
      const hasGit = fs.existsSync(path.join(searchDir, '.git'));

      const searchResults: Array<{ file: string; line: number; content: string }> = [];
      let truncated = false;

      try {
        const output = await new Promise<string>((resolve, reject) => {
          if (hasGit) {
            // git grep: fixed string, case insensitive, skip binary, max results
            const args = ['grep', '-n', '-i', '-I', '-F', `--max-count=${searchLimit}`, '-e', searchQuery];
            if (searchGlob) args.push('--', searchGlob);
            execFileSearch('git', args, { cwd: searchDir, timeout: 10_000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
              // git grep returns exit code 1 for no matches — not an error
              resolve(stdout || '');
            });
          } else {
            // Fallback: grep
            const args = ['-rn', '-i', '-F', '--binary-files=without-match'];
            // Exclude ignored directories
            for (const pattern of ['node_modules', '.git', '.next', 'dist', 'build', '__pycache__', '.cache', '.turbo', 'venv', 'coverage']) {
              args.push(`--exclude-dir=${pattern}`);
            }
            if (searchGlob) args.push(`--include=${searchGlob}`);
            args.push('-e', searchQuery, '.');
            execFileSearch('grep', args, { cwd: searchDir, timeout: 10_000, maxBuffer: 5 * 1024 * 1024 }, (err, stdout) => {
              resolve(stdout || '');
            });
          }
        });

        if (output) {
          const lines = output.split('\n');
          for (const line of lines) {
            if (!line || searchResults.length >= searchLimit) {
              if (line && searchResults.length >= searchLimit) truncated = true;
              continue;
            }
            // Parse: file:line:content
            const firstColon = line.indexOf(':');
            if (firstColon < 0) continue;
            const secondColon = line.indexOf(':', firstColon + 1);
            if (secondColon < 0) continue;

            let file = line.substring(0, firstColon);
            // Strip leading ./ from grep fallback
            if (file.startsWith('./')) file = file.substring(2);
            const lineNum = parseInt(line.substring(firstColon + 1, secondColon), 10);
            if (isNaN(lineNum)) continue;

            let content = line.substring(secondColon + 1);
            // Truncate long lines, centered on match
            if (content.length > 500) {
              const matchIdx = content.toLowerCase().indexOf(searchQuery.toLowerCase());
              if (matchIdx >= 0) {
                const start = Math.max(0, matchIdx - 200);
                const end = Math.min(content.length, matchIdx + searchQuery.length + 300);
                content = (start > 0 ? '…' : '') + content.substring(start, end) + (end < content.length ? '…' : '');
              } else {
                content = content.substring(0, 500) + '…';
              }
            }

            searchResults.push({ file, line: lineNum, content });
          }
        }
      } catch {
        // Timeout or exec failure — return empty results
      }

      res.writeHead(200);
      res.end(JSON.stringify({ results: searchResults, truncated }));
      return;
    }

    // GET /api/blame — per-line blame annotations
    if (pathname === '/api/blame') {
      const blamePath = parsedUrl.query.path as string | undefined;
      const blameProject = parsedUrl.query.project as string | undefined;

      if (!blamePath || blamePath.startsWith('/')) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Valid relative path is required' }));
        return;
      }

      const blameDir = blameProject ? path.join(ROOT_DIR, blameProject) : projectPath;
      const blameDirContained = blameDir === ROOT_DIR || blameDir.startsWith(ROOT_DIR + path.sep);
      if (!blameDirContained || !fs.existsSync(blameDir) || !fs.existsSync(path.join(blameDir, '.git'))) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Project not found or not a git repo' }));
        return;
      }

      // Path escape check
      const resolvedBlame = path.resolve(blameDir, blamePath);
      const relBlame = path.relative(blameDir, resolvedBlame);
      if (relBlame.startsWith('..') || path.isAbsolute(relBlame)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Path escapes project root' }));
        return;
      }

      const { execFile: execBlame } = await import('child_process');
      try {
        const output = await new Promise<string>((resolve, reject) => {
          execBlame('git', ['blame', '--line-porcelain', '--', blamePath], {
            cwd: blameDir, timeout: 15_000, maxBuffer: 10 * 1024 * 1024,
          }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          });
        });

        // Parse porcelain output
        const lines: Array<{ sha: string; author: string; summary: string; date: string; lineNumber: number; content: string }> = [];
        const rawLines = output.split('\n');
        let sha = '', author = '', summary = '', authorTime = 0, lineNumber = 0;
        for (const raw of rawLines) {
          if (raw.startsWith('\t')) {
            // Content line — emit record
            lines.push({ sha, author, summary, date: new Date(authorTime * 1000).toISOString(), lineNumber, content: raw.substring(1) });
          } else if (/^[0-9a-f]{40}/.test(raw)) {
            const parts = raw.split(' ');
            sha = parts[0]!;
            lineNumber = parseInt(parts[2] || parts[1]!, 10);
          } else if (raw.startsWith('author ')) {
            author = raw.substring(7);
          } else if (raw.startsWith('author-time ')) {
            authorTime = parseInt(raw.substring(12), 10);
          } else if (raw.startsWith('summary ')) {
            summary = raw.substring(8);
          }
        }

        res.writeHead(200);
        res.end(JSON.stringify({ lines }));
      } catch {
        res.writeHead(200);
        res.end(JSON.stringify({ lines: [] }));
      }
      return;
    }

    // GET /api/log — commit history for a file or project
    if (pathname === '/api/log') {
      const logPath = parsedUrl.query.path as string | undefined;
      const logProject = parsedUrl.query.project as string | undefined;
      const logLimit = Math.min(parseInt(parsedUrl.query.limit as string || '20', 10) || 20, 100);

      const logDir = logProject ? path.join(ROOT_DIR, logProject) : projectPath;
      const logDirContained = logDir === ROOT_DIR || logDir.startsWith(ROOT_DIR + path.sep);
      if (!logDirContained || !fs.existsSync(logDir) || !fs.existsSync(path.join(logDir, '.git'))) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Project not found or not a git repo' }));
        return;
      }

      // Path escape check if path provided
      if (logPath) {
        if (logPath.startsWith('/')) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Path must be relative' }));
          return;
        }
        const resolvedLog = path.resolve(logDir, logPath);
        const relLog = path.relative(logDir, resolvedLog);
        if (relLog.startsWith('..') || path.isAbsolute(relLog)) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Path escapes project root' }));
          return;
        }
      }

      const { execFile: execLog } = await import('child_process');
      try {
        const args = ['log', `--format=%H%n%s%n%an%n%aI`, `-${logLimit}`];
        if (logPath) { args.push('--follow', '--', logPath); }

        const output = await new Promise<string>((resolve, reject) => {
          execLog('git', args, { cwd: logDir, timeout: 10_000 }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
          });
        });

        // Parse: 4 lines per commit
        const commits: Array<{ sha: string; message: string; author: string; date: string }> = [];
        const rawLines = output.trim().split('\n');
        for (let i = 0; i + 3 < rawLines.length; i += 4) {
          commits.push({
            sha: rawLines[i]!,
            message: rawLines[i + 1]!,
            author: rawLines[i + 2]!,
            date: rawLines[i + 3]!,
          });
        }

        res.writeHead(200);
        res.end(JSON.stringify({ commits }));
      } catch {
        res.writeHead(200);
        res.end(JSON.stringify({ commits: [] }));
      }
      return;
    }

    // GET /api/projects
    if (pathname === '/api/projects') {
      const result = listProjects();
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    // POST /api/projects/:sandbox/pin — pin/unpin a sandbox. Pinning is sandbox-
    const pinMatch = pathname.match(/^\/api\/projects\/(sbx-[a-z0-9]{7})\/pin$/); // eslint-disable-line no-restricted-syntax
    if (req.method === 'POST' && pinMatch) {
      const slug = pinMatch[1]!;
      const projectDir = path.join(ROOT_DIR, slug);
      if (!fs.existsSync(projectDir)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Sandbox not found' }));
        return;
      }

      const body = await parseBody(req);
      const pinned = !!(body as { pinned?: boolean }).pinned;

      // Read-modify-write the target sandbox's metadata
      const metaPath = path.join(projectDir, 'ellul.json');
      try {
        let meta: Record<string, unknown> = {};
        if (fs.existsSync(metaPath)) {
          meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        }
        meta.pinned = pinned;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

        // slugs only so we don't try to touch legacy stray dirs or ZeroClaw infra.
        if (pinned) {
          const entries = fs.readdirSync(ROOT_DIR).filter((f) => {
            if (f === slug) return false;
            if (!isSandboxId(f)) return false;
            try { return fs.statSync(path.join(ROOT_DIR, f)).isDirectory(); } catch { return false; }
          });
          for (const other of entries) {
            const otherMeta = path.join(ROOT_DIR, other, 'ellul.json');
            if (fs.existsSync(otherMeta)) {
              try {
                const otherData = JSON.parse(fs.readFileSync(otherMeta, 'utf8'));
                if (otherData.pinned) {
                  otherData.pinned = false;
                  fs.writeFileSync(otherMeta, JSON.stringify(otherData, null, 2));
                }
              } catch {}
            }
          }
        }

        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, pinned }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    // sandbox and never appear as peers of sandboxes — the response shape
    if (pathname === '/api/apps') {
      const detectedApps = detectApps();
      const config = readConfig();
      const configPath = path.join(ROOT_DIR, '.ellul.json');
      const hasConfig = fs.existsSync(configPath);

      const hidden = new Set(config.hidden || []);
      const visibleApps = detectedApps.filter((a) => !hidden.has(a.directory));

      const appsWithOverrides = visibleApps.map((app) => {
        const overrides = config.overrides || {};
        const override = overrides[app.directory];
        if (!override) return app;
        return {
          ...app,
          name: (override.name as string) || app.name,
          displayName: (override.name as string) || app.displayName,
          type: (override.type as typeof app.type) || app.type,
          previewable: override.previewable !== undefined ? override.previewable as boolean : app.previewable,
          framework: (override.framework as string) || app.framework,
        };
      });

      // Build the sandbox-centric tree, then enrich each sandbox entry with
      const sandboxes = shapeSandboxList(appsWithOverrides);
      for (const sandbox of sandboxes) {
        try {
          const meta = JSON.parse(fs.readFileSync(path.join(sandbox.path, 'ellul.json'), 'utf8')) as {
            pinned?: boolean; createdAt?: string; activeApp?: string | null;
          };
          sandbox.pinned = meta.pinned === true;
          if (typeof meta.createdAt === 'string') sandbox.createdAt = meta.createdAt;
          sandbox.activeApp = typeof meta.activeApp === 'string' && meta.activeApp.length > 0
            ? meta.activeApp
            : null;
        } catch { /* no metadata — defaults already applied */ }
      }

      // Stamp orchestration ProjectIds on every app + workspace package so the
      // console can pass them straight to vps-ui via set_project. Bridge
      // ensures a project.create event is dispatched for any name without an
      // existing row, so projectId is non-null in the happy path — the
      // path-suffix selector in vps-ui is gone after this.
      const ensureEntries = collectProjectEnsureEntries(sandboxes);
      const projectIds = await ensureProjectIds(ensureEntries);
      applyProjectIds(sandboxes, projectIds);

      // Active selection pointer: resolve via the persisted `active-project`
      let activeSandboxId: string | null = null;
      let activeAppDirectory: string | null = null;
      try {
        const slug = getActiveProject();
        if (slug) {
          const sandbox = sandboxes.find((s) => s.id === slug);
          if (sandbox) {
            activeSandboxId = sandbox.id;
            if (sandbox.activeApp) {
              const appEntry = sandbox.apps.find((a) => a.subdir === sandbox.activeApp);
              if (appEntry) activeAppDirectory = appEntry.directory;
            }
            if (!activeAppDirectory && sandbox.apps.length === 1) {
              activeAppDirectory = sandbox.apps[0]!.directory;
            }
          }
        }
      } catch {}

      const response: ApiAppsResponse = {
        sandboxes,
        active: { sandbox: activeSandboxId, app: activeAppDirectory },
        hasConfig,
      };
      res.writeHead(200);
      res.end(JSON.stringify(response));
      return;
    }

    // GET/POST /api/apps/config
    if (pathname === '/api/apps/config') {
      if (req.method === 'GET') {
        const config = readConfig();
        res.writeHead(200);
        res.end(JSON.stringify(config));
        return;
      }

      if (req.method === 'POST') {
        const body = await parseBody(req);
        const config = readConfig();

        const action = body.action as string;
        const rawSandboxId = body.app as string;

        // normalise so we don't accumulate dead keys from typos.
        const needsFilesystem = action === 'override' || action === 'addApp' || action === 'removeApp';
        const normalisedSandboxId = typeof rawSandboxId === 'string' && rawSandboxId
          ? (needsFilesystem
            ? resolveProjectDir(rawSandboxId)
            : (typeof rawSandboxId === 'string' ? rawSandboxId : null))
          : null;

        if (needsFilesystem && !normalisedSandboxId) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: `Invalid app identifier: ${rawSandboxId}` }));
          return;
        }
        const sandboxId = normalisedSandboxId ?? rawSandboxId;

        if (action === 'hide') {
          config.hidden = config.hidden || [];
          if (!config.hidden.includes(sandboxId)) {
            config.hidden.push(sandboxId);
          }
        } else if (action === 'unhide') {
          config.hidden = (config.hidden || []).filter((h) => h !== sandboxId);
        } else if (action === 'override') {
          config.overrides = config.overrides || {};
          config.overrides[sandboxId] = {
            ...(config.overrides[sandboxId] || {}),
            ...(body.properties as Record<string, unknown>),
          };
          // Sync previewable to the APP-level ellul.json (nested path OK —
          const props = body.properties as Record<string, unknown>;
          if ('previewable' in props) {
            const metaPath = path.join(ROOT_DIR, sandboxId, 'ellul.json');
            try {
              const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
              meta.previewable = props.previewable === true;
              fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
            } catch {}
            // Fire-and-forget: bridge re-resolves context mode from metadata
            try {
              let internalToken = '';
              try { internalToken = fs.readFileSync('/run/shield/internal-file-api.token', 'utf8').trim(); } catch {}
              const notifyReq = http.request(
                { hostname: '127.0.0.1', port: 7700, path: '/api/internal/metadata-changed', method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'X-Internal-Token': internalToken } },
              );
              notifyReq.on('error', () => {}); // fire-and-forget
              notifyReq.end(JSON.stringify({ project: sandboxId }));
            } catch {}
          }
        } else if (action === 'removeOverride') {
          if (config.overrides) {
            delete config.overrides[sandboxId];
          }
        } else if (action === 'addApp') {
          config.apps = config.apps || [];
          const newApp = body.app as Record<string, unknown>;
          if (!config.apps.find((a) => a.name === newApp.name)) {
            config.apps.push(newApp);
          }
        } else if (action === 'removeApp') {
          config.apps = (config.apps || []).filter((a) => a.name !== sandboxId);
        } else if (action === 'setConfig') {
          writeConfig(body.config as Record<string, unknown>);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
          return;
        }

        writeConfig(config);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, config }));
        return;
      }
    }

    // GET/POST /api/project-meta?project=<sandbox/app>
    //
    // Reads + writes .ellul/project.json for the named project. Used by
    // Phase 7a-NATIVE Layer 4 (welcome overlay's welcomeShownAt) and
    // Layer 6 (mismatch banner's createdLocale read).
    //
    // Trust model: file-api runs as $SVC_USER, the same uid that owns
    // the project workspace. The agent could write project.json
    // directly via shell — this endpoint just gives the iframe a clean
    // HTTP surface. The POST handler ALLOWLIST limits writes to
    // welcomeShownAt; createdLocale stays immutable post-scaffold so
    // Layer 6's mismatch detection can't be silenced from the iframe.
    if (pathname === '/api/project-meta') {
      const projectId = parsedUrl.query.project as string | undefined;
      if (!projectId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'project required' }));
        return;
      }
      const resolved = resolveProjectDir(projectId);
      if (!resolved) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'project not found' }));
        return;
      }
      const metaPath = path.join(ROOT_DIR, resolved, '.ellul', 'project.json');

      if (req.method === 'GET') {
        try {
          const raw = fs.readFileSync(metaPath, 'utf8');
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(parsed));
        } catch {
          // Missing file (cloned/imported projects), unreadable, or
          // malformed — return null so callers treat as "no record".
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('null');
        }
        return;
      }

      if (req.method === 'POST') {
        const body = await parseBody(req) as { welcomeShownAt?: unknown };
        const updates: Record<string, unknown> = {};
        // Allowlist — only welcomeShownAt is iframe-mutable. ISO-8601
        // shaped string or null. Anything else is rejected so a
        // compromised iframe can't poison project.json.
        if ('welcomeShownAt' in body) {
          const w = body.welcomeShownAt;
          if (w === null || (typeof w === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(w))) {
            updates.welcomeShownAt = w;
          } else {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'welcomeShownAt must be ISO-8601 string or null' }));
            return;
          }
        }
        if (Object.keys(updates).length === 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'no allowed fields in body' }));
          return;
        }
        let existing: Record<string, unknown> = {};
        try { existing = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
        const merged = { ...existing, ...updates };
        try {
          fs.mkdirSync(path.dirname(metaPath), { recursive: true });
          fs.writeFileSync(metaPath, JSON.stringify(merged, null, 2));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'write failed', detail: (err as Error).message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(merged));
        return;
      }

      res.writeHead(405);
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    // entitlement enforcement. file-api NEVER calls mkdirSync for project dirs.
    if (req.method === 'POST' && pathname === '/api/apps/create') {
      const reqContentType = req.headers['content-type'] || '';

      // ── Upload from Desktop (multipart/form-data) ──────────────────────
      if (reqContentType.startsWith('multipart/form-data')) {
        const sessionId = extractAuthSession(headers['x-auth-session'])
          || extractCodeSession(headers['cookie'])
          || headers['x-auth-user']
          || 'anonymous';

        if (activeUploads.has(sessionId)) {
          res.writeHead(429);
          res.end(JSON.stringify({ error: 'Upload already in progress' }));
          return;
        }
        activeUploads.add(sessionId);

        let tempDir: string | null = null;
        let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

        try {
          const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
          let rawBody: Buffer;
          try {
            const chunks: Buffer[] = [];
            let totalBytes = 0;
            rawBody = await new Promise<Buffer>((resolve, reject) => {
              req.on('data', (chunk: Buffer) => {
                totalBytes += chunk.length;
                if (totalBytes > MAX_UPLOAD_BYTES) {
                  req.destroy();
                  reject(new Error('BODY_TOO_LARGE'));
                  return;
                }
                chunks.push(chunk);
              });
              req.on('end', () => resolve(Buffer.concat(chunks)));
              req.on('error', reject);
            });
          } catch (bodyErr: any) {
            if (bodyErr.message === 'BODY_TOO_LARGE') {
              res.writeHead(413);
              res.end(JSON.stringify({ error: 'Upload exceeds 500MB limit' }));
            } else {
              res.writeHead(400);
              res.end(JSON.stringify({ error: 'Failed to read upload body' }));
            }
            return;
          }

          let parts: ReturnType<typeof parseMultipart>;
          try {
            parts = parseMultipart(rawBody, reqContentType);
          } catch {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Invalid multipart body' }));
            return;
          }

          const uploadName = typeof parts.name === 'string' ? parts.name.trim() : '';
          const filePart = (parts.file && typeof parts.file === 'object' && 'data' in parts.file)
            ? parts.file as UploadedFile
            : null;

          if (!uploadName || !filePart) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing name or file field' }));
            return;
          }

          if (!filePart.filename.toLowerCase().endsWith('.zip')) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Only .zip files are accepted' }));
            return;
          }

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          const emit = (event: string, data: unknown): void => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          };

          emit('progress', { stage: 'uploading' });

          tempDir = `/tmp/ellul-upload-${crypto.randomUUID()}`;
          fs.mkdirSync(tempDir, { mode: 0o700 });
          cleanupTimer = setTimeout(() => {
            if (tempDir) try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
          }, 5 * 60_000);

          const zipPath = path.join(tempDir, 'upload.zip');
          fs.writeFileSync(zipPath, filePart.data);
          const compressedSize = filePart.data.length;

          const { execSync } = await import('child_process');

          let listing: string;
          try {
            listing = execSync(`unzip -l "${zipPath}"`, { timeout: 30_000 }).toString();
          } catch {
            emit('error', { error: 'Invalid or corrupt zip file' });
            res.end();
            return;
          }

          const zipEntries: { size: number; name: string }[] = [];
          let totalDecompressed = 0;
          for (const line of listing.split('\n')) {
            const m = line.match(/^\s*(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/);
            if (!m) continue;
            const size = parseInt(m[1]!, 10);
            const entryName = m[2]!.trim();
            if (!entryName || entryName.endsWith('/')) continue;
            zipEntries.push({ size, name: entryName });
            totalDecompressed += size;
          }

          if (totalDecompressed > compressedSize * 10) {
            console.warn(`[file-api] Upload rejected: compression ratio ${(totalDecompressed / compressedSize).toFixed(1)}x`);
            emit('error', { error: 'Zip rejected: suspicious compression ratio' });
            res.end();
            return;
          }
          if (totalDecompressed > 2 * 1024 * 1024 * 1024) {
            emit('error', { error: 'Zip rejected: decompressed size exceeds 2GB' });
            res.end();
            return;
          }

          const DANGEROUS_FILE_RE = [
            /(?:^|\/)\.env$/,
            /(?:^|\/)\.env\..+$/,
            /\.pem$/i,
            /\.key$/i,
            /\.p12$/i,
            /(?:^|\/)id_rsa$/,
            /(?:^|\/)id_ed25519$/,
            /(?:^|\/)credentials\.json$/,
            /(?:^|\/)service-account.*\.json$/i,
            /(?:^|\/)\.npmrc$/,
            /(?:^|\/)\.pypirc$/,
            /(?:^|\/)\.netrc$/,
            /(?:^|\/)\.htpasswd$/,
            /(?:^|\/)\.pgpass$/,
          ];
          const rejectedFiles: string[] = [];

          for (const entry of zipEntries) {
            if (entry.name.includes('..') || path.isAbsolute(entry.name)) {
              emit('error', { error: 'Zip rejected: path traversal detected' });
              res.end();
              return;
            }
            const basename = path.basename(entry.name);
            if (basename.length > 255 || /[\x00-\x1f]/.test(basename)) {
              emit('error', { error: 'Zip rejected: invalid filename' });
              res.end();
              return;
            }
            if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..+)?$/i.test(basename)) {
              emit('error', { error: `Zip rejected: reserved filename "${basename}"` });
              res.end();
              return;
            }
            for (const re of DANGEROUS_FILE_RE) {
              if (re.test(entry.name) || re.test(basename)) {
                rejectedFiles.push(entry.name);
                break;
              }
            }
          }

          if (rejectedFiles.length > 0) {
            console.warn(`[file-api] Upload rejected sensitive files: ${rejectedFiles.join(', ')}`);
            emit('error', {
              error: `Zip contains sensitive files: ${rejectedFiles.map(f => path.basename(f)).join(', ')}`,
            });
            res.end();
            return;
          }

          try {
            const fsStat = fs.statfsSync(ROOT_DIR);
            const availableBytes = Number(fsStat.bavail) * fsStat.bsize;
            if (availableBytes - totalDecompressed < 1024 * 1024 * 1024) {
              emit('error', { error: 'Insufficient disk space for extraction' });
              res.end();
              return;
            }
          } catch {}

          emit('progress', { stage: 'creating_sandbox' });
          const { callShieldInternal } = await import('@vps/shared/shield-client');

          let uploadCreateResult: {
            slug: string; id: string; displayName: string;
            shielded: { workspace: string; cache: string; subnet: any } | null;
            entitlement: { current: number; max: number; remaining: number };
          };
          try {
            const createResp = await callShieldInternal('/api/internal/projects/create', {
              method: 'POST',
              body: { displayName: uploadName },
            });
            if (createResp.status === 402) {
              const ent = await createResp.json() as any;
              emit('error', {
                error: ent.error || 'sandbox_limit_reached',
                message: ent.message || 'Sandbox limit reached.',
                current: ent.current, max: ent.max,
              });
              res.end();
              return;
            }
            if (!createResp.ok) {
              const errBody = await createResp.json().catch(() => ({ error: 'Unknown error' })) as any;
              emit('error', { error: errBody.message || errBody.error || 'Failed to create project' });
              res.end();
              return;
            }
            uploadCreateResult = await createResp.json() as typeof uploadCreateResult;
          } catch (err: any) {
            emit('error', { error: 'Failed to reach sovereign-shield for project creation' });
            res.end();
            return;
          }

          const uploadSandboxId = uploadCreateResult.slug;
          const uploadSandboxPath = path.join(ROOT_DIR, uploadSandboxId);

          const cleanupUploadProject = async (slug: string): Promise<void> => {
            for (const delay of [500, 1000, 2000]) {
              try {
                const resp = await callShieldInternal(`/api/internal/projects/${slug}`, { method: 'DELETE' });
                if (resp.ok) return;
              } catch {}
              await new Promise(r => setTimeout(r, delay));
            }
            console.error(`[file-api] ORPHAN: Failed to cleanup project ${slug}`);
          };

          try {
            writeSandboxMetadata(uploadSandboxPath, { displayName: uploadName });

            emit('progress', { stage: 'extracting' });
            const extractDir = path.join(tempDir, 'extracted');
            fs.mkdirSync(extractDir, { mode: 0o700 });

            try {
              execSync(`unzip -o -d "${extractDir}" "${zipPath}"`, { timeout: 120_000 });
            } catch {
              await cleanupUploadProject(uploadSandboxId);
              emit('error', { error: 'Failed to extract zip file' });
              res.end();
              return;
            }

            try {
              const symlinkOut = execSync(`find "${extractDir}" -type l`, { timeout: 30_000 }).toString().trim();
              for (const link of symlinkOut.split('\n').filter(Boolean)) {
                const target = fs.readlinkSync(link);
                const resolved = path.resolve(path.dirname(link), target);
                if (!resolved.startsWith(extractDir)) {
                  await cleanupUploadProject(uploadSandboxId);
                  emit('error', { error: 'Zip rejected: symlink escapes extraction root' });
                  res.end();
                  return;
                }
              }
            } catch {}

            try {
              const duOut = execSync(`du -sb "${extractDir}"`, { timeout: 10_000 }).toString().trim();
              const actualSize = parseInt(duOut.split('\t')[0]!, 10);
              if (actualSize > compressedSize * 10 || actualSize > 2 * 1024 * 1024 * 1024) {
                await cleanupUploadProject(uploadSandboxId);
                emit('error', { error: 'Extraction aborted: decompressed size exceeds limits' });
                res.end();
                return;
              }
            } catch {}

            const topEntries = fs.readdirSync(extractDir);
            let sourceDir = extractDir;
            if (topEntries.length === 1) {
              const single = path.join(extractDir, topEntries[0]!);
              try { if (fs.statSync(single).isDirectory()) sourceDir = single; } catch {}
            }

            const appName = uploadName.toLowerCase()
              .replace(/[^a-z0-9._-]/g, '-')
              .replace(/^-+|-+$/g, '')
              .slice(0, 63) || 'uploaded-project';
            const uploadAppRoot = `${uploadSandboxId}/${appName}`;
            const uploadTargetPath = path.join(uploadSandboxPath, appName);

            fs.mkdirSync(uploadTargetPath, { recursive: true });

            const resolvedTarget = path.resolve(uploadTargetPath);
            if (!resolvedTarget.startsWith(path.resolve(uploadSandboxPath))) {
              await cleanupUploadProject(uploadSandboxId);
              emit('error', { error: 'Security violation: path escaped sandbox' });
              res.end();
              return;
            }

            execSync(`cp -a "${sourceDir}/." "${uploadTargetPath}/"`, { timeout: 60_000 });

            emit('progress', { stage: 'writing_metadata' });
            emit('progress', { stage: 'detecting' });
            const detected = detectApps().find(a => a.kind === 'app' && a.directory === uploadAppRoot);
            const inferredType: AppType = detected?.type ?? 'unknown';
            const inferredFramework = detected?.framework || 'unknown';
            const inferredPreviewable = detected?.previewable ?? false;

            writeAppMetadata(uploadTargetPath, {
              displayName: appName,
              type: inferredType,
              previewable: inferredPreviewable,
              origin: 'upload',
              framework: inferredFramework === 'unknown' ? null : inferredFramework,
            });
            writeZeroClawWorkspace(uploadTargetPath, appName);
            ensureAppGitignore(uploadTargetPath);
            updateSandboxActiveApp(uploadSandboxPath, appName);
            bootstrapGit(uploadTargetPath);

            const pkgJsonPath = path.join(uploadTargetPath, 'package.json');
            let installing = false;
            if (fs.existsSync(pkgJsonPath)) {
              emit('progress', { stage: 'installing_deps' });
              const installStatus = requestInstall(uploadTargetPath);
              if (installStatus.phase === 'queued' || installStatus.phase === 'running') {
                installing = true;
              }
            }

            console.log(`[file-api] Upload complete: user=${headers['x-auth-user'] || 'unknown'} name=${uploadName} size=${compressedSize} entries=${zipEntries.length} sandbox=${uploadSandboxId}`);

            emit('done', {
              success: true,
              installing,
              app: {
                kind: 'app' as const,
                name: appName,
                directory: uploadAppRoot,
                displayName: appName,
                path: uploadTargetPath,
                sandboxId: uploadSandboxId,
                appRoot: uploadAppRoot,
                framework: inferredFramework,
                scripts: detected?.scripts || [],
                type: inferredType,
                previewable: inferredPreviewable,
                isMonorepo: detected?.isMonorepo ?? false,
                packages: detected?.packages,
                hasPackageJson: detected?.hasPackageJson ?? fs.existsSync(pkgJsonPath),
              },
            });
            res.end();
          } catch (err) {
            await cleanupUploadProject(uploadSandboxId).catch(() => {});
            emit('error', {
              error: (err as Error).message || 'Unexpected failure during upload',
              code: 'internal_error',
            });
            res.end();
          }
        } finally {
          activeUploads.delete(sessionId);
          if (cleanupTimer) clearTimeout(cleanupTimer);
          if (tempDir) try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
        }
        return;
      }

      // Happy-path contract: the user has made an explicit choice (scaffold or
      const body = await parseBody(req);
      const { name, type } = body as { name: string; type: 'scaffold' | 'git' };

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const emit = (event: string, data: unknown): void => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      if (!name || !type) {
        emit('error', { error: 'Missing name or type' });
        res.end();
        return;
      }
      if (type !== 'scaffold' && type !== 'git') {
        emit('error', { error: `Invalid type: ${type}` });
        res.end();
        return;
      }

      const { callShieldInternal } = await import('@vps/shared/shield-client');
      const cleanupProject = async (slug: string): Promise<void> => {
        const delays = [500, 1000, 2000];
        for (let i = 0; i < delays.length; i++) {
          try {
            const resp = await callShieldInternal(`/api/internal/projects/${slug}`, { method: 'DELETE' });
            if (resp.ok) return;
          } catch {}
          if (i < delays.length - 1) await new Promise(r => setTimeout(r, delays[i]!));
        }
        console.error(`[file-api] ORPHAN: Failed to cleanup project ${slug} after ${delays.length} attempts — awaiting GC sweep`);
      };

      emit('progress', { stage: 'creating_sandbox' });
      let createResult: {
        slug: string; id: string; displayName: string;
        shielded: { workspace: string; cache: string; subnet: any } | null;
        entitlement: { current: number; max: number; remaining: number };
      };
      try {
        const createResp = await callShieldInternal('/api/internal/projects/create', {
          method: 'POST',
          body: { displayName: name },
        });
        if (createResp.status === 402) {
          const ent = await createResp.json() as any;
          emit('error', {
            error: ent.error || 'sandbox_limit_reached',
            message: ent.message || 'Sandbox limit reached.',
            current: ent.current, max: ent.max,
          });
          res.end();
          return;
        }
        if (!createResp.ok) {
          const errBody = await createResp.json().catch(() => ({ error: 'Unknown error' })) as any;
          emit('error', { error: errBody.message || errBody.error || 'Failed to create project' });
          res.end();
          return;
        }
        createResult = await createResp.json() as typeof createResult;
      } catch (err: any) {
        console.error(`[file-api] Failed to create project via shield:`, err.message);
        emit('error', { error: 'Failed to reach sovereign-shield for project creation' });
        res.end();
        return;
      }

      const sandboxId = createResult.slug;
      const sandboxPath = path.join(ROOT_DIR, sandboxId);

      // Safety net: every path past this point owns the sandbox. An
      // spawn() EMFILE, etc.) must not leak the shield project. Wrap the
      try {
      writeSandboxMetadata(sandboxPath, { displayName: name });

      if (type === 'scaffold') {
        const { framework, project } = body as { framework?: string; project?: string };
        if (!framework) {
          await cleanupProject(sandboxId);
          emit('error', { error: 'Missing framework for scaffold' });
          res.end();
          return;
        }

        emit('progress', { stage: 'scaffolding', framework });
        let scaffoldJson: { ok: boolean; output?: any; errorCode?: string; message?: string; reason?: string };
        try {
          const scaffoldResp = await fetch('http://127.0.0.1:7700/api/internal/scaffold', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sandboxId, framework, project }),
          });
          scaffoldJson = await scaffoldResp.json() as typeof scaffoldJson;
          if (!scaffoldResp.ok || !scaffoldJson.ok) {
            await cleanupProject(sandboxId);
            emit('error', {
              error: scaffoldJson.message || scaffoldJson.reason || 'Scaffold failed',
              code: scaffoldJson.errorCode,
            });
            res.end();
            return;
          }
        } catch (err: any) {
          await cleanupProject(sandboxId);
          emit('error', { error: `Failed to reach agent-bridge: ${err.message}` });
          res.end();
          return;
        }

        emit('progress', { stage: 'detecting' });
        const appDirectory = scaffoldJson.output?.directory as string | undefined;
        const detected = appDirectory
          ? detectApps().find(a => a.kind === 'app' && a.directory === appDirectory)
          : undefined;

        if (!detected || !appDirectory) {
          await cleanupProject(sandboxId);
          emit('error', { error: 'Scaffold succeeded but app was not detected — this is a bug' });
          res.end();
          return;
        }

        // uses, so this is idempotent and race-free by construction.
        const scaffoldedAppPath = path.join(ROOT_DIR, detected.directory);
        let installing = false;

        // Ensure non-Node runtimes are installed before triggering dep install.
        // Maps framework id → [runtime name for installer, binary to check on PATH].
        const FW_RUNTIME: Record<string, [string, string]> = {
          rails: ['ruby', 'ruby'], sinatra: ['ruby', 'ruby'],
          django: ['python', 'python3'], flask: ['python', 'python3'],
          fastapi: ['python', 'python3'], streamlit: ['python', 'python3'], gradio: ['python', 'python3'],
          laravel: ['php', 'php'], phoenix: ['elixir', 'elixir'],
          golang: ['go', 'go'], rust: ['rust', 'cargo'], dotnet: ['dotnet', 'dotnet'],
          'spring-boot': ['java', 'java'], bun: ['bun', 'bun'],
        };
        const rtInfo = detected.framework ? FW_RUNTIME[detected.framework] : undefined;
        if (rtInfo) {
          const { execSync: execSyncRt } = await import('child_process');
          try { execSyncRt(`which ${rtInfo[1]}`, { timeout: 3000, stdio: 'ignore' }); } catch {
            emit('progress', { stage: 'installing_runtime' });
            try {
              execSyncRt(`sudo -n /usr/local/bin/ellul-install-runtime ${rtInfo[0]}`, { timeout: 300_000, stdio: 'ignore' });
            } catch (rtErr: any) {
              console.warn('[file-api] post-scaffold runtime install failed:', rtErr.message);
            }
          }
        }

        const installStatus = requestInstall(scaffoldedAppPath);
        if (installStatus.phase === 'queued' || installStatus.phase === 'running') {
          emit('progress', { stage: 'installing_deps' });
          installing = true;
        } else if (installStatus.phase === 'failed' && installStatus.errorClass !== 'no_manifest') {
          console.warn('[file-api] post-scaffold install request failed to spawn:', installStatus.error);
        }

        emit('done', {
          success: true,
          installing,
          app: {
            kind: 'app' as const,
            name: detected.name,
            directory: detected.directory,
            displayName: detected.displayName,
            path: path.join(ROOT_DIR, detected.directory),
            sandboxId,
            appRoot: detected.directory,
            framework: detected.framework,
            scripts: detected.scripts,
            type: detected.type,
            previewable: detected.previewable,
            isMonorepo: detected.isMonorepo ?? false,
            packages: detected.packages,
            hasPackageJson: detected.hasPackageJson ?? false,
          },
        });
        res.end();
        return;
      }

      // type === 'git'
      const {
        provider,
        repoFullName,
        repoUrl,
        defaultBranch,
        isPrivate,
        vpsConfirmToken,
      } = body as {
        provider: string;
        repoFullName: string;
        repoUrl?: string;
        defaultBranch?: string;
        isPrivate?: boolean;
        vpsConfirmToken?: string;
      };
      if (!provider || !repoFullName) {
        await cleanupProject(sandboxId);
        emit('error', { error: 'Missing provider or repoFullName' });
        res.end();
        return;
      }
      if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repoFullName)) {
        await cleanupProject(sandboxId);
        emit('error', { error: 'Invalid repository name format (expected owner/repo)' });
        res.end();
        return;
      }

      // Derive a safe subfolder name from the repo. Shield's git-clone endpoint
      const rawRepoName = repoFullName.split('/').pop() || '';
      const repoName = rawRepoName.replace(/\.git$/i, '').toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(repoName)) {
        await cleanupProject(sandboxId);
        emit('error', { error: 'Cannot derive a safe subfolder name from repoFullName' });
        res.end();
        return;
      }

      const appRoot = `${sandboxId}/${repoName}`;
      const targetPath = path.join(sandboxPath, repoName);

      // `sandboxId` MUST be the nested `sbx-xxx/repo-name` directory path — that
      // `buildAppSuffix(project)` on shield must resolve to the same suffix
      if (repoUrl && defaultBranch && typeof isPrivate === 'boolean') {
        // No progress emit here — credential staging is a single IPC hop
        let linkResult: { success: boolean; error?: string };
        try {
          const linkResp = await callShieldInternal('/api/internal/git-link', {
            method: 'POST',
            body: {
              provider,
              repoFullName,
              repoUrl,
              defaultBranch,
              isPrivate,
              sandboxId: appRoot, // `sbx-xxx/repo-name` — matches on-disk app dir
              // Passkey confirm token for locked tiers — shield relays this
              ...(vpsConfirmToken ? { vpsConfirmToken } : {}),
            },
          });
          linkResult = await linkResp.json() as typeof linkResult;
        } catch (err: any) {
          linkResult = { success: false, error: `Failed to reach sovereign-shield for git link: ${err.message}` };
        }
        if (!linkResult.success) {
          await cleanupProject(sandboxId);
          emit('error', { error: linkResult.error || 'Failed to register git link' });
          res.end();
          return;
        }
      }

      emit('progress', { stage: 'cloning', repoFullName });
      let cloneResult: { success: boolean; error?: string };
      try {
        const cloneResp = await callShieldInternal('/api/internal/git-clone', {
          method: 'POST',
          body: { provider, repoFullName, targetPath },
        });
        cloneResult = await cloneResp.json() as typeof cloneResult;
      } catch (err: any) {
        cloneResult = { success: false, error: `Failed to reach sovereign-shield: ${err.message}` };
      }
      if (!cloneResult.success) {
        await cleanupProject(sandboxId);
        // found"). Don't double-prefix — the previous `Clone failed: Clone
        emit('error', { error: cloneResult.error || 'Clone failed' });
        res.end();
        return;
      }

      emit('progress', { stage: 'writing_metadata' });
      const detected = detectApps().find(a => a.kind === 'app' && a.directory === appRoot);
      const inferredType: AppType = detected?.type ?? 'unknown';
      const inferredFramework = detected?.framework || 'unknown';
      const inferredPreviewable = detected?.previewable ?? false;

      writeAppMetadata(targetPath, {
        displayName: repoName,
        type: inferredType,
        previewable: inferredPreviewable,
        origin: 'git',
        framework: inferredFramework === 'unknown' ? null : inferredFramework,
      });
      writeZeroClawWorkspace(targetPath, repoName);
      ensureAppGitignore(targetPath);
      updateSandboxActiveApp(sandboxPath, repoName);

      // npm install in background — the UI flips to `installing` state and
      const { spawn } = await import('child_process');
      const packageJsonPath = path.join(targetPath, 'package.json');
      let installing = false;
      if (fs.existsSync(packageJsonPath)) {
        emit('progress', { stage: 'installing_deps' });
        const npmInstall = spawn('npm', ['install'], { cwd: targetPath, detached: true, stdio: 'ignore' });
        npmInstall.unref();
        installing = true;
      }

      emit('done', {
        success: true,
        installing,
        app: {
          kind: 'app' as const,
          name: repoName,
          directory: appRoot,
          displayName: repoName,
          path: targetPath,
          sandboxId,
          appRoot,
          framework: inferredFramework,
          scripts: detected?.scripts || [],
          type: inferredType,
          previewable: inferredPreviewable,
          isMonorepo: detected?.isMonorepo ?? false,
          packages: detected?.packages,
          hasPackageJson: detected?.hasPackageJson ?? fs.existsSync(packageJsonPath),
        },
      });
      res.end();
      return;
      } catch (err) {
        // Unhandled throw past shield creation — nuke the orphan sandbox
        await cleanupProject(sandboxId).catch(() => {});
        emit('error', {
          error: (err as Error).message || 'Unexpected failure during sandbox setup',
          code: 'internal_error',
        });
        res.end();
        return;
      }
    }

    // POST /api/active-project — set the active sandbox (and, optionally, the
    if (req.method === 'POST' && pathname === '/api/active-project') {
      const body = await parseBody(req);
      const project = body.project as string;
      if (!project) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Missing project' }));
        return;
      }
      const normalised = resolveProjectDir(project);
      if (!normalised) {
        res.writeHead(404);
        res.end(JSON.stringify({ success: false, error: `Project not found: ${project}` }));
        return;
      }
      const parts = normalised.split('/');
      const sandboxSlug = parts[0]!;
      const success = setActiveProject(sandboxSlug);
      // If the caller passed a nested path (app root), persist the second-segment
      if (success && parts.length >= 2) {
        setActiveApp(sandboxSlug, parts[1]!);
      }
      res.writeHead(success ? 200 : 404);
      res.end(JSON.stringify({ success, project: normalised, sandbox: sandboxSlug }));
      return;
    }

    // DELETE /api/apps/:directory — delete a sandbox or a single app inside one.
    if (req.method === 'DELETE' && pathname.startsWith('/api/apps/')) {
      const appIdentifier = decodeURIComponent(pathname.replace('/api/apps/', ''));

      if (!appIdentifier) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Missing app identifier' }));
        return;
      }

      // sandbox-slug-first shape and traversal safety.
      const normalised = resolveProjectDir(appIdentifier);
      if (!normalised) {
        res.writeHead(404);
        res.end(JSON.stringify({ success: false, error: 'App not found' }));
        return;
      }

      const apps = detectApps();
      const app = apps.find(a => a.directory === normalised);
      if (!app) {
        res.writeHead(404);
        res.end(JSON.stringify({ success: false, error: 'App not found' }));
        return;
      }

      if (app.kind === 'package') {
        res.writeHead(400);
        res.end(JSON.stringify({
          success: false,
          error: 'Monorepo packages are managed inside their app — delete the app root to remove all packages, or edit the monorepo directly.',
        }));
        return;
      }

      const appPath = path.join(ROOT_DIR, app.directory);

      // Safety checks — the resolved path must stay strictly inside ROOT_DIR
      // and must not equal ROOT_DIR itself.
      const resolvedPath = path.resolve(appPath);
      if (!resolvedPath.startsWith(ROOT_DIR + path.sep) || resolvedPath === ROOT_DIR) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid app path' }));
        return;
      }

      const { exec } = await import('child_process');
      const runCmd = (cmd: string): Promise<{ success: boolean; output: string; error?: string }> =>
        new Promise((resolve) => {
          exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
            resolve({
              success: !err,
              output: stdout.trim(),
              error: err ? stderr.trim() || err.message : undefined,
            });
          });
        });

      const cleanup: string[] = [];

      // Find this app's deployment metadata by matching projectPath
      const appsMetaDir = `${HOME}/.ellul/apps`;
      let deployedSandboxId: string | null = null;
      let deployedMetaFile: string | null = null;

      if (fs.existsSync(appsMetaDir)) {
        try {
          const metaFiles = fs.readdirSync(appsMetaDir).filter(f => f.endsWith('.json'));
          for (const metaFile of metaFiles) {
            const metaPath = path.join(appsMetaDir, metaFile);
            try {
              const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
              // Match by projectPath to ensure we have the exact app
              if (meta.projectPath === appPath) {
                deployedSandboxId = meta.name;
                deployedMetaFile = metaPath;
                break;
              }
            } catch {
              // Skip invalid JSON files
            }
          }
        } catch {
          // Can't read apps dir, skip deployment cleanup
        }
      }

      try {
        // ── Synchronous cleanup (instant) ──
        if (deployedSandboxId) {
          const caddyConfigPath = `/etc/caddy/sites-enabled/${deployedSandboxId}.caddy`;
          if (fs.existsSync(caddyConfigPath)) {
            fs.unlinkSync(caddyConfigPath);
            cleanup.push('caddy-config');
          }
        }

        // 3. Remove app metadata JSON - the specific file we found
        if (deployedMetaFile && fs.existsSync(deployedMetaFile)) {
          fs.unlinkSync(deployedMetaFile);
          cleanup.push('app-metadata');
        }

        // Release preview ports for this app and all sub-apps (monorepo packages).
        try {
          const portsReleased = releasePortsByPrefix(app.directory);
          if (portsReleased > 0) cleanup.push(`preview-ports(${portsReleased})`);
        } catch {}

        // Remove companions that belong to the deleted sandbox.
        try {
          const removedCompanions = removeCompanionsByPrefix(app.directory);
          if (removedCompanions.length > 0) cleanup.push(`companions(${removedCompanions.length})`);
        } catch {}

        // Clear active preview pointer if it points to the deleted sandbox.
        try {
          const previewFile = `${HOME}/.ellul/preview-app`;
          if (fs.existsSync(previewFile)) {
            const active = fs.readFileSync(previewFile, 'utf8').trim();
            if (active === app.directory || active.startsWith(app.directory + '/')) {
              fs.unlinkSync(previewFile);
              cleanup.push('preview-pointer');
            }
          }
        } catch {}

        // Remove deployment snapshot (sync)
        try {
          const deploymentPath = `${HOME}/.ellul/deployments/${app.directory}`;
          if (fs.existsSync(deploymentPath)) {
            fs.rmSync(deploymentPath, { recursive: true, force: true });
            cleanup.push('deployment-snapshot');
          }
        } catch {}

        // Clear active sandbox/app pointers when they refer to what's being
        try {
          if (app.kind === 'sandbox') {
            const activeFile = `${HOME}/.ellul/active-project`;
            if (fs.existsSync(activeFile) && fs.readFileSync(activeFile, 'utf8').trim() === app.directory) {
              fs.unlinkSync(activeFile);
            }
          } else if (app.kind === 'app' && app.sandboxId) {
            const sandboxMetaPath = path.join(ROOT_DIR, app.sandboxId, 'ellul.json');
            if (fs.existsSync(sandboxMetaPath)) {
              try {
                const meta = JSON.parse(fs.readFileSync(sandboxMetaPath, 'utf8'));
                const appSub = app.directory.split('/')[1];
                if (meta.activeApp === appSub) {
                  meta.activeApp = null;
                  fs.writeFileSync(sandboxMetaPath, JSON.stringify(meta, null, 2));
                }
              } catch {}
            }
          }
        } catch {}

        // Fire-and-forget thread cleanup (non-blocking). deleteThreadsByProject
        try {
          let internalToken = '';
          try { internalToken = fs.readFileSync('/run/shield/internal-file-api.token', 'utf8').trim(); } catch {}
          const cleanupReq = http.request(
            { hostname: '127.0.0.1', port: 7700, path: '/api/cleanup-project', method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Internal-Token': internalToken } },
            (cleanupRes) => {
              if (cleanupRes.statusCode === 200) cleanup.push('threads');
            }
          );
          cleanupReq.write(JSON.stringify({ project: app.directory }));
          cleanupReq.end();
        } catch {}

        // ── Critical path: transactional delete via coordinator ──
        // If shield fails, we must NOT fall through to the coordinator's
        let shieldDeletedTree = false;
        if (app.kind === 'sandbox') {
          let shieldFailed: Error | null = null;
          let shieldStatus: number | null = null;
          let shieldBody: string | null = null;
          try {
            const { callShieldInternal } = await import('@vps/shared/shield-client');
            const delResp = await callShieldInternal(
              `/api/internal/projects/${encodeURIComponent(app.directory)}`,
              { method: 'DELETE' },
            );
            shieldStatus = delResp.status;
            if (delResp.ok) {
              const delResult = (await delResp.json().catch(() => ({}))) as { destroyed?: string[] };
              for (const item of delResult.destroyed || []) cleanup.push(item);
              shieldDeletedTree = !fs.existsSync(appPath);
            } else {
              shieldBody = await delResp.text().catch(() => '');
              shieldFailed = new Error(`shield returned ${delResp.status}: ${shieldBody.slice(0, 400)}`);
            }
          } catch (err) {
            shieldFailed = err as Error;
          }

          if (shieldFailed) {
            console.error(
              `[file-api] shield sandbox delete failed (${shieldStatus ?? 'no-response'}) — refusing to fs.rm from dev user:`,
              shieldFailed.message,
            );
            res.writeHead(500);
            res.end(JSON.stringify({
              success: false,
              error: `Sandbox delete failed at shield boundary: ${shieldFailed.message}`,
              partialCleanup: cleanup,
            }));
            return;
          }
        }

        const deleteResult = await coordinatedDelete(app.directory, {
          log: (level, msg, ctx) => {
            const rec = {
              level,
              time: new Date().toISOString(),
              svc: 'sandbox-delete',
              msg,
              ...(ctx ?? {}),
            };
            (level === 'error' ? console.error : console.log)(JSON.stringify(rec));
          },
          // callers are responsible for local cleanup and we don't
          releaseRoutes: async () => [],
          releasePort: () => {},
          skipFsRm: shieldDeletedTree,
        });

        if (!deleteResult.ok) {
          console.error(
            `[file-api] coordinated delete failed at step=${deleteResult.failedAt} for ${app.directory}`,
            JSON.stringify(deleteResult.steps),
          );
          res.writeHead(500);
          res.end(
            JSON.stringify({
              success: false,
              error: `Delete failed at step "${deleteResult.failedAt}".`,
              steps: deleteResult.steps,
              partialCleanup: cleanup,
            }),
          );
          return;
        }
        cleanup.push(
          'preview-unit-stopped',
          'install-markers-cleared',
          shieldDeletedTree ? 'directory' : 'directory-rm-verified',
          'systemd-reset-failed',
        );

        // ── Namespace teardown (synchronous — must complete before response) ──
        if (app.kind === 'sandbox') {
          try {
            await runCmd(`sudo /usr/local/bin/ellul-agent-namespace teardown ${app.directory}`);
            cleanup.push('namespace-teardown');
            console.log(`[file-api] Namespace teardown complete for "${app.directory}"`);
          } catch (nsTeardownErr) {
            console.error(`[file-api] Namespace teardown FAILED for "${app.directory}":`, (nsTeardownErr as Error).message);
            cleanup.push('namespace-teardown-failed');
          }
        }

        // ── Background cleanup: stop processes + resources (don't block response) ──
        const bgCleanup = async () => {
          const bg: Promise<void>[] = [];

          if (deployedSandboxId) {
            bg.push(runCmd(`pm2 delete "${deployedSandboxId}" 2>/dev/null || true`).then(() => {}).catch(() => {}));
          }
          // we don't leave orphan PM2 entries for nested apps.
          bg.push(runCmd(`pm2 delete "preview-${app.directory}" 2>/dev/null || true`).then(() => {}).catch(() => {}));
          if (app.kind === 'sandbox') {
            bg.push(runCmd(`pm2 jlist 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{JSON.parse(d).forEach(p=>{if(typeof p.name==='string'&&p.name.startsWith('preview-${app.directory}/'))console.log(p.name);});}catch{}})" | xargs -I {} pm2 delete {} 2>/dev/null || true`).then(() => {}).catch(() => {}));
          }

          if (cleanup.includes('caddy-config')) {
            bg.push(runCmd('systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true').then(() => {}).catch(() => {}));
          }

          if (deployedSandboxId) {
            bg.push((async () => {
              try {
                const { callShieldInternal } = await import('@vps/shared/shield-client');
                await callShieldInternal(`/api/internal/secrets/${encodeURIComponent(deployedSandboxId)}`, { method: 'DELETE' });
              } catch {}
            })());
          }

          await Promise.allSettled(bg);
          console.log(`[file-api] Background cleanup done for "${app.name}"`);
        };
        bgCleanup().catch(() => {});

        console.log(`[file-api] Deleted app "${app.name}" with cleanup: ${cleanup.join(', ')}`);

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, deleted: app.name, cleanup }));
        return;
      } catch (e) {
        const error = e as Error;
        console.error(`[file-api] Error deleting app "${app.name}":`, error.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: error.message, partialCleanup: cleanup }));
        return;
      }
    }

    // GET /api/deployment/:name/versions - List available deployment versions
    if (req.method === 'GET' && pathname.match(/^\/api\/deployment\/[^/]+\/versions$/)) {
      const parts = pathname.split('/');
      const deployName = decodeURIComponent(parts[3] || '');

      if (!deployName || !/^[a-z0-9][a-z0-9-]*$/.test(deployName)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid deployment name' }));
        return;
      }

      const deployPath = path.join(HOME, '.ellul', 'deployments', deployName);
      if (!fs.existsSync(deployPath)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Deployment not found', name: deployName }));
        return;
      }

      // Read timestamp directories, resolve current symlink
      const entries = fs.readdirSync(deployPath).filter(e => /^\d+$/.test(e)).sort((a, b) => Number(a) - Number(b));
      let currentTs: string | null = null;
      try {
        const target = fs.readlinkSync(path.join(deployPath, 'current'));
        currentTs = path.basename(target);
      } catch { /* no current symlink */ }

      const versions = entries.map((ts, i) => ({
        id: ts,
        label: `Version ${i + 1}`,
        timestamp: Number(ts),
        isCurrent: ts === currentTs,
      }));

      res.writeHead(200);
      res.end(JSON.stringify({ versions }));
      return;
    }

    // GET /api/deployment/:name/tree - Get file tree for a deployment snapshot
    if (req.method === 'GET' && pathname.match(/^\/api\/deployment\/[^/]+\/tree$/)) {
      const parts = pathname.split('/');
      const deployName = decodeURIComponent(parts[3] || '');

      if (!deployName || !/^[a-z0-9][a-z0-9-]*$/.test(deployName)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid deployment name' }));
        return;
      }

      const deployPath = path.join(HOME, '.ellul', 'deployments', deployName);
      if (!fs.existsSync(deployPath)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Deployment snapshot not found', name: deployName }));
        return;
      }

      // Resolve version: ?version=<timestamp> or default to current symlink
      const versionParam = parsedUrl.query.version as string | undefined;
      let snapshotPath: string;
      if (versionParam && /^\d+$/.test(versionParam)) {
        snapshotPath = path.join(deployPath, versionParam);
      } else {
        snapshotPath = path.join(deployPath, 'current');
      }

      if (!fs.existsSync(snapshotPath)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Version not found', name: deployName }));
        return;
      }

      const tree = getTree(snapshotPath);
      const treeJson = JSON.stringify({ root: deployName, tree });
      res.writeHead(200, { 'Content-Length': Buffer.byteLength(treeJson) });
      res.end(treeJson);
      return;
    }

    // GET /api/deployment/:name/file?path=... - Get file content from a deployment snapshot
    if (req.method === 'GET' && pathname.match(/^\/api\/deployment\/[^/]+\/file$/)) {
      const parts = pathname.split('/');
      const deployName = decodeURIComponent(parts[3] || '');

      if (!deployName || !/^[a-z0-9][a-z0-9-]*$/.test(deployName)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid deployment name' }));
        return;
      }

      const filePath = parsedUrl.query.path as string;
      if (!filePath) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing path parameter' }));
        return;
      }

      const deployPath = path.join(HOME, '.ellul', 'deployments', deployName);
      if (!fs.existsSync(deployPath)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Deployment snapshot not found', name: deployName }));
        return;
      }

      // Resolve version: ?version=<timestamp> or default to current symlink
      const versionParam = parsedUrl.query.version as string | undefined;
      let snapshotPath: string;
      if (versionParam && /^\d+$/.test(versionParam)) {
        snapshotPath = path.join(deployPath, versionParam);
      } else {
        snapshotPath = path.join(deployPath, 'current');
      }

      if (!fs.existsSync(snapshotPath)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Version not found', name: deployName }));
        return;
      }

      const result = getFileContent(filePath, snapshotPath);
      if (result.error) {
        res.writeHead(result.statusCode);
        res.end(JSON.stringify({ error: result.error }));
        return;
      }

      res.setHeader('Content-Type', 'text/plain');
      res.writeHead(200, { 'Content-Length': Buffer.byteLength(result.content!) });
      res.end(result.content);
      return;
    }

    // GET /api/deployment/:name/logs - Get PM2 logs for a deployment
    if (req.method === 'GET' && pathname.match(/^\/api\/deployment\/[^/]+\/logs$/)) {
      const parts = pathname.split('/');
      const deployName = decodeURIComponent(parts[3] || '');

      if (!deployName || !/^[a-z0-9][a-z0-9-]*$/.test(deployName)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid deployment name' }));
        return;
      }

      const linesParam = parseInt(parsedUrl.query.lines as string || '100', 10);
      const lines = Math.min(Math.max(linesParam, 1), 500);
      const logType = (parsedUrl.query.type as string) || 'all';

      if (!['out', 'err', 'all'].includes(logType)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid type parameter (out, err, all)' }));
        return;
      }

      // Read logs through shield's internal API (protected directory, with secret redaction)
      try {
        const { callShieldInternal } = await import('@vps/shared/shield-client');
        const shieldResp = await callShieldInternal(
          `/api/internal/logs/${encodeURIComponent(deployName)}?lines=${lines}&type=${logType}`,
          { method: 'GET' },
        );
        if (!shieldResp.ok) throw new Error(`Shield returned ${shieldResp.status}`);
        const data = await shieldResp.json() as { logs?: unknown[] };
        res.writeHead(200);
        res.end(JSON.stringify({ logs: data.logs || [], name: deployName }));
      } catch {
        res.writeHead(502);
        res.end(JSON.stringify({ error: 'Failed to read logs from shield', logs: [] }));
      }
      return;
    }

    // POST /api/deploy-authorize - Deploy gate: authorize agent deployment from console UI
    if (req.method === 'POST' && pathname === '/api/deploy-authorize') {
      const MAX_BODY = 4096;
      let body = '';
      let aborted = false;

      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > MAX_BODY) {
          aborted = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          req.destroy();
        }
      });

      req.on('error', (err) => {
        if (aborted) return;
        console.error('[file-api] deploy-authorize request error:', err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request stream error' }));
        }
      });

      req.on('end', async () => {
        if (aborted) return;
        try {
          const { project, sandboxId, port: reqPort } = JSON.parse(body) as {
            project?: string;
            sandboxId?: string;
            port?: number;
          };

          if (!project) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'project is required' }));
            return;
          }

          // 1. Open deploy gate on sovereign-shield (forward browser session for auth)
          const sessionId = extractCodeSession(headers['cookie']) || extractAuthSession(headers['x-auth-session']);
          const gateController = new AbortController();
          const gateTimeout = setTimeout(() => gateController.abort(), 10_000);

          let gateRes: Response;
          try {
            gateRes = await fetch('http://127.0.0.1:3005/api/workflow/deploy-gate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ project, sessionId, cookie: headers['cookie'] }),
              signal: gateController.signal,
            });
          } finally {
            clearTimeout(gateTimeout);
          }

          if (!gateRes.ok) {
            const gateErr = await gateRes.json().catch(() => ({ error: 'Gate open failed' }));
            res.writeHead(gateRes.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(gateErr));
            return;
          }

          const { token, expiresAt } = (await gateRes.json()) as { token: string; expiresAt: number };

          // 2. Inject deploy instruction to agent via agent-bridge (fire-and-forget)
          const bridgeController = new AbortController();
          const bridgeTimeout = setTimeout(() => bridgeController.abort(), 10_000);

          fetch('http://127.0.0.1:7700/api/internal/deploy-authorized', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project, token, sandboxId, port: reqPort }),
            signal: bridgeController.signal,
          })
            .catch((err) => console.error('[file-api] deploy-authorized bridge call failed:', (err as Error).message))
            .finally(() => clearTimeout(bridgeTimeout));

          // 3. Return token to console
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, token, expiresAt }));
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Deploy authorize failed: ${(err as Error).message}` }));
          }
        }
      });
      return;
    }

    // POST /api/git-push-authorize - Git push gate: authorize agent git push from console UI
    if (req.method === 'POST' && pathname === '/api/git-push-authorize') {
      const MAX_BODY = 4096;
      let body = '';
      let aborted = false;

      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (body.length > MAX_BODY) {
          aborted = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          req.destroy();
        }
      });

      req.on('error', (err) => {
        if (aborted) return;
        console.error('[file-api] git-push-authorize request error:', err.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request stream error' }));
        }
      });

      req.on('end', async () => {
        if (aborted) return;
        try {
          const { project } = JSON.parse(body) as { project?: string };

          if (!project) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'project is required' }));
            return;
          }

          // 1. Open git-push gate on sovereign-shield (forward browser session for auth)
          const sessionId = extractCodeSession(headers['cookie']) || extractAuthSession(headers['x-auth-session']);
          const gateController = new AbortController();
          const gateTimeout = setTimeout(() => gateController.abort(), 10_000);

          let gateRes: Response;
          try {
            gateRes = await fetch('http://127.0.0.1:3005/api/workflow/action-gate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'git-push', project, sessionId, cookie: headers['cookie'] }),
              signal: gateController.signal,
            });
          } finally {
            clearTimeout(gateTimeout);
          }

          if (!gateRes.ok) {
            const gateErr = await gateRes.json().catch(() => ({ error: 'Gate open failed' }));
            res.writeHead(gateRes.status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(gateErr));
            return;
          }

          const { token, expiresAt } = (await gateRes.json()) as { token: string; expiresAt: number };

          // 2. Inject git push instruction to agent via agent-bridge (fire-and-forget)
          const bridgeController = new AbortController();
          const bridgeTimeout = setTimeout(() => bridgeController.abort(), 10_000);

          fetch('http://127.0.0.1:7700/api/internal/git-push-authorized', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project, token }),
            signal: bridgeController.signal,
          })
            .catch((err) => console.error('[file-api] git-push-authorized bridge call failed:', (err as Error).message))
            .finally(() => clearTimeout(bridgeTimeout));

          // 3. Return token to console
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, token, expiresAt }));
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Git push authorize failed: ${(err as Error).message}` }));
          }
        }
      });
      return;
    }

    // POST /api/deployment/:name/redeploy - Trigger redeployment via sovereign-shield
    if (req.method === 'POST' && pathname.match(/^\/api\/deployment\/[^/]+\/redeploy$/)) {
      const parts = pathname.split('/');
      const deployName = decodeURIComponent(parts[3] || '');

      if (!deployName || !/^[a-z0-9][a-z0-9-]*$/.test(deployName)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid deployment name' }));
        return;
      }

      // Read app metadata to get deploy params
      const metaFile = path.join(HOME, '.ellul', 'apps', `${deployName}.json`);
      if (!fs.existsSync(metaFile)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Deployment not found' }));
        return;
      }

      let meta: Record<string, unknown>;
      try {
        meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      } catch {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to read deployment metadata' }));
        return;
      }

      try {
        // Open deploy gate first (UI-initiated redeploy — forward browser session for auth)
        const redeploySessionId = extractCodeSession(headers['cookie']) || extractAuthSession(headers['x-auth-session']);
        let deployToken: string | undefined;
        try {
          const gateController = new AbortController();
          const gateTimeout = setTimeout(() => gateController.abort(), 10_000);
          const gateRes = await fetch('http://127.0.0.1:3005/api/workflow/deploy-gate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project: String(meta.projectPath || meta.name), sessionId: redeploySessionId, cookie: headers['cookie'] }),
            signal: gateController.signal,
          });
          clearTimeout(gateTimeout);
          if (gateRes.ok) {
            const gateData = (await gateRes.json()) as { token: string };
            deployToken = gateData.token;
          }
        } catch (e) {
          console.error('[file-api] Failed to open deploy gate for redeploy:', (e as Error).message);
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000);

        const shieldRes = await fetch('http://127.0.0.1:3005/api/workflow/expose', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: meta.name,
            port: meta.port,
            projectPath: meta.projectPath,
            stack: meta.stack,
            deployToken,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const shieldData = await shieldRes.json();

        if (!shieldRes.ok) {
          res.writeHead(shieldRes.status);
          res.end(JSON.stringify(shieldData));
          return;
        }

        res.writeHead(200);
        res.end(JSON.stringify(shieldData));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: `Redeploy failed: ${(e as Error).message}` }));
      }
      return;
    }

    // DELETE /api/deployment/:name - Remove a deployment via sovereign-shield
    if (req.method === 'DELETE' && pathname.match(/^\/api\/deployment\/[^/]+$/) && !pathname.includes('/tree') && !pathname.includes('/file') && !pathname.includes('/logs') && !pathname.includes('/redeploy')) {
      const parts = pathname.split('/');
      const deployName = decodeURIComponent(parts[3] || '');

      if (!deployName || !/^[a-z0-9][a-z0-9-]*$/.test(deployName)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid deployment name' }));
        return;
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        const shieldRes = await fetch('http://127.0.0.1:3005/api/workflow/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: deployName }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const shieldData = await shieldRes.json();

        if (!shieldRes.ok) {
          res.writeHead(shieldRes.status);
          res.end(JSON.stringify(shieldData));
          return;
        }

        res.writeHead(200);
        res.end(JSON.stringify(shieldData));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: `Remove failed: ${(e as Error).message}` }));
      }
      return;
    }

    // DELETE /api/deployments/project/:project - Remove ALL deployments for a project
    if (req.method === 'DELETE' && pathname.match(/^\/api\/deployments\/project\/[^/]+$/)) {
      const projectName = decodeURIComponent(pathname.split('/').pop() || '');

      if (!projectName || !/^[a-z0-9][a-z0-9-]*$/.test(projectName)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid project name' }));
        return;
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000);

        const shieldRes = await fetch('http://127.0.0.1:3005/api/workflow/remove-project', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: projectName }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const shieldData = await shieldRes.json();

        if (!shieldRes.ok) {
          res.writeHead(shieldRes.status);
          res.end(JSON.stringify(shieldData));
          return;
        }

        res.writeHead(200);
        res.end(JSON.stringify(shieldData));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: `Remove project failed: ${(e as Error).message}` }));
      }
      return;
    }

    // GET /api/app/:directory — Resolve a selection + auto-activate preview.
    if (req.method === 'GET' && pathname.startsWith('/api/app/') && !pathname.includes('/tree') && !pathname.includes('/context') && !pathname.includes('/status') && !pathname.includes('/integrations')) {
      const appIdentifier = decodeURIComponent(pathname.replace('/api/app/', ''));

      if (!appIdentifier) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing app identifier' }));
        return;
      }

      const detectedApps = detectApps();
      const config = readConfig();
      const hidden = new Set(config.hidden || []);

      // Apply config overrides onto the flat list before shaping, so overridden
      const appsForSelection = detectedApps
        .filter((a) => !hidden.has(a.directory))
        .map((app) => {
          const overrides = config.overrides || {};
          const override = overrides[app.directory];
          if (!override) return app;
          return {
            ...app,
            name: (override.name as string) || app.name,
            displayName: (override.name as string) || app.displayName,
            type: (override.type as typeof app.type) || app.type,
            previewable: override.previewable !== undefined ? override.previewable as boolean : app.previewable,
            framework: (override.framework as string) || app.framework,
          };
        });

      const selection = shapeSingleSelection(appsForSelection, appIdentifier);
      if (!selection.sandbox) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'App not found', directory: appIdentifier }));
        return;
      }

      // Same projectId enrichment as /api/apps — only for the returned sandbox.
      const selectionEntries = collectProjectEnsureEntries([selection.sandbox]);
      if (selectionEntries.length > 0) {
        const selectionIds = await ensureProjectIds(selectionEntries);
        applyProjectIds([selection.sandbox], selectionIds);
      }

      // Enrich the sandbox entry with pinned/createdAt/activeApp from its ellul.json.
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(selection.sandbox.path, 'ellul.json'), 'utf8')) as {
          pinned?: boolean; createdAt?: string; activeApp?: string | null;
        };
        selection.sandbox.pinned = meta.pinned === true;
        if (typeof meta.createdAt === 'string') selection.sandbox.createdAt = meta.createdAt;
        selection.sandbox.activeApp = typeof meta.activeApp === 'string' && meta.activeApp.length > 0
          ? meta.activeApp
          : null;
      } catch {}

      const sandbox: ApiSandbox = selection.sandbox;
      let app: ApiApp | null = selection.app;
      const selectedPackage: ApiPackage | null = selection.selectedPackage;

      // Determine whether the backend auto-resolved the caller's URL. If the
      let redirectTo: string | undefined;
      if (appIdentifier === sandbox.id && app && sandbox.apps.length === 1) {
        redirectTo = app.directory;
      }

      // monorepo root; those don't auto-start)
      const previewTarget = selectedPackage
        ? selectedPackage
        : (app && !app.isMonorepo && app.previewable ? app : null);
      // Preview health is always keyed by app directory, not sandbox slug.
      const previewKey = previewTarget?.directory ?? null;
      const health = previewKey ? await getPreviewHealth(previewKey) : await getPreviewHealth();

      // POST /api/preview; the 2026-04-22 regression traced to a GET
      // so it cannot seed the loop. It exists to avoid an iframe-404 race
      if (previewTarget && previewTarget.previewable) {
        ensureCaddyRoute(getProjectPort(previewTarget.directory));
      } else if (app?.isMonorepo) {
        // companion preview stay up, don't start anything new.
        if (health.app && health.active) ensureCaddyRoute(health.port);
      }
      // Empty-sandbox cleanup (previously `stopPreview()` here) moved out —

      // Persist the active selection: sandbox slug always, sandbox's activeApp
      setActiveProject(sandbox.id);
      if (app && app.sandboxId === sandbox.id) {
        setActiveApp(sandbox.id, app.subdir);
      }

      // Context files (sandbox-level only — app-level context is handled by agent-bridge)
      const contextDir = `${HOME}/.ellul/context`;
      const projectContextPath = path.join(contextDir, `${sandbox.id}.md`);
      const globalContextPath = path.join(contextDir, 'global.md');
      const hasProjectContext = fs.existsSync(projectContextPath);
      const hasGlobalContext = fs.existsSync(globalContextPath);

      const response: ApiAppResponse = {
        sandbox,
        app,
        selectedPackage,
        redirectTo: redirectTo && redirectTo !== appIdentifier ? redirectTo : undefined,
        preview: {
          active: health.active,
          app: health.app || (previewTarget && previewTarget.previewable ? previewTarget.directory : null),
          // `activated` (and the 'starting' phase override that paired with
          activated: false,
          port: health.port,
          phase: health.phase,
          error: health.error ?? null,
          logTail: health.logTail ?? null,
          healAttempts: health.healAttempts ?? 0,
          healStatus: health.healStatus ?? null,
          httpStatus: health.httpStatus,
          orphanReason: health.orphanReason,
          recoveryHint: health.recoveryHint,
        },
        context: {
          hasProjectContext,
          hasGlobalContext,
        },
      };
      const bodyJson = JSON.stringify(response);
      res.writeHead(200, { 'Content-Length': Buffer.byteLength(bodyJson) });
      res.end(bodyJson);
      return;
    }

    // GET /api/app/:directory/tree - Get file tree for specific app
    if (req.method === 'GET' && pathname.match(/^\/api\/app\/[^/]+\/tree$/)) {
      const parts = pathname.split('/');
      const appIdentifier = decodeURIComponent(parts[3] || '');

      if (!appIdentifier) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing app identifier' }));
        return;
      }

      // Resolve app directory
      const resolvedDir = resolveProjectDir(appIdentifier);
      if (!resolvedDir) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'App not found', directory: appIdentifier }));
        return;
      }
      // sandbox root (ellul.json, AGENTS.md, CLAUDE.md) is never exposed.
      // The UI happy path never requests this — a 400 here stops any future
      if (resolvedDir.split('/').length === 1) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'no_app_selected', directory: resolvedDir }));
        return;
      }

      const appPath = path.join(ROOT_DIR, resolvedDir);
      const tree = getTree(appPath);

      // Get git status for the app
      const { exec } = await import('child_process');
      const runCmd = (cmd: string): Promise<string> =>
        new Promise((resolve) => {
          exec(cmd, { cwd: appPath, timeout: 5000 }, (err, stdout) => {
            resolve(err ? '' : stdout.trim());
          });
        });

      const statusOutput = await runCmd('git status --porcelain');
      const modified: Array<{ status: string; file: string }> = [];
      if (statusOutput) {
        for (const line of statusOutput.split('\n')) {
          if (line.trim()) {
            const statusCode = line.substring(0, 2);
            const file = line.substring(3);
            modified.push({ status: statusCode.trim() || 'M', file });
          }
        }
      }

      const appTreeJson = JSON.stringify({
        root: resolvedDir,
        tree,
        gitStatus: { modified },
      });
      res.writeHead(200, { 'Content-Length': Buffer.byteLength(appTreeJson) });
      res.end(appTreeJson);
      return;
    }

    // GET /api/app/:directory/context - Get context files for specific app
    if (req.method === 'GET' && pathname.match(/^\/api\/app\/[^/]+\/context$/)) {
      const parts = pathname.split('/');
      const appIdentifier = decodeURIComponent(parts[3] || '');

      if (!appIdentifier) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing app identifier' }));
        return;
      }

      // Resolve app directory
      const resolvedDir = resolveProjectDir(appIdentifier);
      if (!resolvedDir) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'App not found', directory: appIdentifier }));
        return;
      }

      // Get all context files and filter for this app
      const allFiles = listContextFiles();
      const appContextFiles = allFiles.filter(f =>
        f.type === 'global' || f.project === resolvedDir
      );

      const ctxJson = JSON.stringify({ files: appContextFiles });
      res.writeHead(200, { 'Content-Length': Buffer.byteLength(ctxJson) });
      res.end(ctxJson);
      return;
    }

    // GET /api/app/:directory/status - Get preview/build status for specific app
    if (req.method === 'GET' && pathname.match(/^\/api\/app\/[^/]+\/status$/)) {
      const parts = pathname.split('/');
      const appIdentifier = decodeURIComponent(parts[3] || '');

      if (!appIdentifier) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing app identifier' }));
        return;
      }

      // Resolve app directory
      const resolvedDir = resolveProjectDir(appIdentifier);
      if (!resolvedDir) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'App not found', directory: appIdentifier }));
        return;
      }

      // Parameterized health check handles monorepo parent→child resolution
      const health = await getPreviewHealth(resolvedDir);

      res.writeHead(200);
      res.end(JSON.stringify({
        directory: resolvedDir,
        preview: {
          active: health.active,
          app: health.app,
          isCurrentApp: !!health.app,
          phase: health.phase,
          port: health.port,
          error: health.error ?? null,
          logTail: health.logTail ?? null,
          healAttempts: health.healAttempts ?? 0,
          healStatus: health.healStatus ?? null,
        },
      }));
      return;
    }

    // GET /api/app/:directory/integrations - Resolved integration state for the chat Actions dropdown
    if (req.method === 'GET' && pathname.match(/^\/api\/app\/[^/]+\/integrations$/)) {
      const parts = pathname.split('/');
      const appIdentifier = decodeURIComponent(parts[3] || '');
      const result = await handleGetIntegrations(appIdentifier, resolveProjectDir);
      res.writeHead(result.status);
      res.end(JSON.stringify(result.body));
      return;
    }

    // GET /api/app-integrations?project=<id> — same output as the `/api/app/:directory/integrations`
    if (req.method === 'GET' && pathname === '/api/app-integrations') {
      const appIdentifier = (parsedUrl.query.project as string) || '';
      const result = await handleGetIntegrations(appIdentifier, resolveProjectDir);
      res.writeHead(result.status);
      res.end(JSON.stringify(result.body));
      return;
    }

    // POST /api/app/:directory/integrations/invalidate - Drop cached integrations; forces revalidation
    if (req.method === 'POST' && pathname.match(/^\/api\/app\/[^/]+\/integrations\/invalidate$/)) {
      const parts = pathname.split('/');
      const appIdentifier = decodeURIComponent(parts[3] || '');
      const result = handleInvalidateIntegrations(appIdentifier, resolveProjectDir);
      res.writeHead(result.status);
      res.end(JSON.stringify(result.body));
      return;
    }

    // GET /api/openapi-spec?app=<directory> - Probe running dev server for OpenAPI spec
    if (req.method === 'GET' && pathname === '/api/openapi-spec') {
      const appDir = parsedUrl.query.app as string;
      if (!appDir) {
        res.writeHead(400);
        res.end(JSON.stringify({ found: false, reason: 'Missing app parameter' }));
        return;
      }

      // Resolve and find the app
      const resolvedDir = resolveProjectDir(appDir);
      if (!resolvedDir) {
        res.writeHead(404);
        res.end(JSON.stringify({ found: false, reason: 'App not found' }));
        return;
      }

      const appPath = path.join(ROOT_DIR, resolvedDir);

      // Check preview is running
      const previewHealth = await getPreviewHealth(resolvedDir);
      const canProbe = previewHealth.active;

      // Get the app's configured port and info
      const allApps = detectApps();
      const appInfo = allApps.find(a => a.directory === resolvedDir);
      const port = appInfo?.port ?? getProjectPort(resolvedDir);

      // Check in-memory cache (path → spec, 30s TTL) — covers both probe and static
      const cacheKey = `${resolvedDir}:${port}`;
      const cached = openApiSpecCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < 30000) {
        resolveOpenApiHeal(resolvedDir);
        res.writeHead(200);
        res.end(JSON.stringify({ found: true, path: cached.path, spec: cached.spec, source: cached.path === 'static-analysis' ? 'static' : 'probe' }));
        return;
      }

      // Check static analysis cache
      const staticCacheKey = `static:${resolvedDir}`;
      const staticCached = openApiSpecCache.get(staticCacheKey);

      // Layer 1: Probe running app for OpenAPI spec
      if (canProbe) {
        const specPaths = [
          '/openapi.json',
          '/swagger.json',
          '/api-docs',
          '/api-docs/swagger.json',
          '/api-docs/openapi.json',
          '/documentation/json',
          '/docs/json',
          '/api-json',
          '/swagger-json',
          '/doc',
          '/v3/api-docs',
          '/v2/api-docs',
          '/api/openapi.json',
          '/api/schema/',
          '/schema/',
          '/swagger/v1/swagger.json',
          '/swagger/v2/swagger.json',
          '/apispec.json',
        ];

        const timeout = setTimeout(() => {}, 5000);

        try {
          const results = await Promise.allSettled(
            specPaths.map(async (specPath) => {
              const ac = new AbortController();
              const t = setTimeout(() => ac.abort(), 2000);
              try {
                const response = await fetch(`http://localhost:${port}${specPath}`, {
                  signal: ac.signal,
                  headers: { 'Accept': 'application/json' },
                });
                if (!response.ok) return null;
                const text = await response.text();
                const json = JSON.parse(text);
                if (json.openapi || json.swagger) {
                  return { path: specPath, spec: json };
                }
                return null;
              } finally {
                clearTimeout(t);
              }
            })
          );

          clearTimeout(timeout);

          for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
              const { path: specPath, spec } = result.value;
              openApiSpecCache.set(cacheKey, { path: specPath, spec, timestamp: Date.now() });
              resolveOpenApiHeal(resolvedDir);
              res.writeHead(200);
              res.end(JSON.stringify({ found: true, path: specPath, spec, source: 'probe' }));
              return;
            }
          }
        } catch {
          clearTimeout(timeout);
          // Probing failed — fall through to static analysis
        }
      }

      // Layer 3: Static source analysis (works for ALL languages, even before preview starts)
      if (staticCached && Date.now() - staticCached.timestamp < 30000) {
        resolveOpenApiHeal(resolvedDir);
        res.writeHead(200);
        res.end(JSON.stringify({ found: true, path: staticCached.path, spec: staticCached.spec, source: 'static' }));
        return;
      }

      const framework = appInfo?.framework || 'unknown';

      try {
        const result = analyzeRoutesFromSource(appPath, framework);
        if (result && result.routes.length > 0) {
          openApiSpecCache.set(staticCacheKey, { path: 'static-analysis', spec: result.spec, timestamp: Date.now() });
          resolveOpenApiHeal(resolvedDir);
          res.writeHead(200);
          res.end(JSON.stringify({ found: true, path: 'static-analysis', spec: result.spec, source: 'static' }));
          return;
        }
      } catch {}

      // No spec found — trigger OpenAPI self-healing if app is running
      if (canProbe) {
        checkAndHealOpenApi(resolvedDir, framework);
      }

      const { healStatus, healAttempts, maxHealAttempts } = getOpenApiHealState(resolvedDir);
      res.writeHead(200);
      res.end(JSON.stringify({ found: false, reason: 'No routes discovered', healStatus, healAttempts, maxHealAttempts }));
      return;
    }

    // All git credentials are in sovereign-shield's process memory (never on disk).
    if (req.method === 'POST' && pathname.match(/^\/api\/app\/[^/]+\/git-pull$/)) {
      const parts = pathname.split('/');
      const appIdentifier = decodeURIComponent(parts[3] || '');

      if (!appIdentifier) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Missing app identifier' }));
        return;
      }

      // Resolve app directory — must already exist. Sandbox dirs are ONLY
      // ownership + entitlement caps. Creating dirs here would bypass both.
      const dirName = resolveProjectDir(appIdentifier);
      if (!dirName) {
        res.writeHead(404);
        res.end(JSON.stringify({ success: false, error: `Project "${appIdentifier}" not found` }));
        return;
      }
      const appPath = path.join(ROOT_DIR, dirName);

      const hasGit = fs.existsSync(path.join(appPath, '.git'));

      console.log(`[file-api] Git pull for ${dirName} (hasGit: ${hasGit})`);

      try {
        if (!hasGit) {
          // Fresh project — delegate full setup to sovereign-shield
          const { callShieldInternal } = await import('@vps/shared/shield-client');
          const setupRes = await callShieldInternal('/_internal/git-setup', {
            method: 'POST',
            body: { sandboxId: dirName },
          });
          if (!setupRes.ok) {
            const err = await setupRes.text();
            res.writeHead(500);
            res.end(JSON.stringify({ success: false, error: `Git setup failed: ${err}` }));
            return;
          }
        } else {
          // Existing repo — delegate pull to sovereign-shield
          const { callShieldInternal: callShield } = await import('@vps/shared/shield-client');
          const pullRes = await callShield('/api/internal/git-pull', {
            method: 'POST',
            body: { project: dirName },
          });
          if (!pullRes.ok) {
            const err = await pullRes.text();
            res.writeHead(500);
            res.end(JSON.stringify({ success: false, error: `Git pull failed: ${err}` }));
            return;
          }
        }

        // Detect app framework after pull
        const detected = detectApps().find(a => a.directory === dirName);

        // after the console receives this response, so node_modules must be ready.
        const packageJsonPath = path.join(appPath, 'package.json');
        if (fs.existsSync(packageJsonPath) && !fs.existsSync(path.join(appPath, 'node_modules'))) {
          const lockFile = fs.existsSync(path.join(appPath, 'pnpm-lock.yaml'))
            ? 'pnpm' : fs.existsSync(path.join(appPath, 'yarn.lock'))
            ? 'yarn' : 'npm';
          const { exec } = await import('child_process');
          try {
            await new Promise<void>((resolve) => {
              exec(`${lockFile} install`, { cwd: appPath, timeout: 120000 }, () => resolve());
            });
          } catch {}
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          directory: dirName,
          framework: detected?.framework || 'unknown',
          type: detected?.type || 'unknown',
        }));
      } catch (e) {
        const error = e as Error;
        console.error(`[file-api] Git pull failed for ${dirName}:`, error.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
      return;
    }

    // POST /api/runtime/install — on-demand runtime installation
    if (req.method === 'POST' && pathname === '/api/runtime/install') {
      const body = await parseBody(req);
      const runtime = body.runtime as string | undefined;
      const ALLOWED = ['ruby', 'go', 'rust', 'elixir', 'php', 'dart', 'flutter'];

      if (!runtime || !ALLOWED.includes(runtime)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: `Invalid runtime. Allowed: ${ALLOWED.join(', ')}` }));
        return;
      }

      // Concurrency guard — prevent parallel installs racing on dpkg/filesystem
      if (installingRuntimes.has(runtime)) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: `${runtime} installation already in progress` }));
        return;
      }

      installingRuntimes.add(runtime);
      try {
        const { execSync } = await import('child_process');
        // Run the installer script via sudo (sudoers entry allows this without password)
        execSync(`sudo /usr/local/bin/ellul-install-runtime ${runtime}`, {
          timeout: 300000, // 5 min max
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, runtime }));
      } catch (e) {
        const err = e as Error & { stderr?: string };
        console.error(`[file-api] Runtime install failed for ${runtime}:`, err.stderr || err.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, runtime, error: (err.stderr || err.message).slice(0, 500) }));
      } finally {
        installingRuntimes.delete(runtime);
      }
      return;
    }

    // ── Install Manager API ──────────────────────────────────────────────
    // owner, one lock per install root, one state file — races across

    // call repeatedly — a live install never spawns a duplicate, a
    if (req.method === 'POST' && pathname === '/api/internal/install') {
      if (!hasInternalJwt) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Forbidden: internal endpoint' }));
        return;
      }
      const body = await parseBody(req);
      const projectInput = body.project as string | undefined;
      const force = body.force === true;
      if (!projectInput) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'project is required' }));
        return;
      }
      const resolved = resolveProjectDir(projectInput);
      if (!resolved) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid project identifier' }));
        return;
      }
      const appPath = path.join(ROOT_DIR, resolved);
      const status = requestInstall(appPath, { force });
      res.writeHead(200);
      res.end(JSON.stringify(status));
      return;
    }

    // GET /api/internal/install/status?project=<id>[&logTail=1]
    if (req.method === 'GET' && pathname === '/api/internal/install/status') {
      if (!hasInternalJwt) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Forbidden: internal endpoint' }));
        return;
      }
      const projectInput = parsedUrl.query.project as string | undefined;
      const withLogTail = parsedUrl.query.logTail === '1';
      if (!projectInput) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'project is required' }));
        return;
      }
      const resolved = resolveProjectDir(projectInput);
      if (!resolved) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid project identifier' }));
        return;
      }
      const appPath = path.join(ROOT_DIR, resolved);
      const status = getInstallStatus(appPath, { withLogTail });
      res.writeHead(200);
      res.end(JSON.stringify(status));
      return;
    }

    // POST /api/internal/install/cancel — kill the running install
    if (req.method === 'POST' && pathname === '/api/internal/install/cancel') {
      if (!hasInternalJwt) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Forbidden: internal endpoint' }));
        return;
      }
      const body = await parseBody(req);
      const projectInput = body.project as string | undefined;
      if (!projectInput) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'project is required' }));
        return;
      }
      const resolved = resolveProjectDir(projectInput);
      if (!resolved) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid project identifier' }));
        return;
      }
      const appPath = path.join(ROOT_DIR, resolved);
      const status = cancelInstall(appPath);
      res.writeHead(200);
      res.end(JSON.stringify(status));
      return;
    }

    // DELETE /api/internal/install/node_modules — wipe install artifacts
    if (req.method === 'DELETE' && pathname === '/api/internal/install/node_modules') {
      if (!hasInternalJwt) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Forbidden: internal endpoint' }));
        return;
      }
      const body = await parseBody(req);
      const projectInput = body.project as string | undefined;
      if (!projectInput) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'project is required' }));
        return;
      }
      const resolved = resolveProjectDir(projectInput);
      if (!resolved) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid project identifier' }));
        return;
      }
      const appPath = path.join(ROOT_DIR, resolved);
      const status = wipeInstallTree(appPath);
      res.writeHead(200);
      res.end(JSON.stringify(status));
      return;
    }

    // GET/POST /api/preview
    if (pathname === '/api/preview') {
      if (req.method === 'GET') {
        const health = await getPreviewHealth();
        let autoStarted = false;

        if (health.app) {
          // Defense-in-depth: verify Caddy route on every poll.
          ensureCaddyRoute(health.port);

          if (!health.active) {
            // Auto-start if the unit isn't live — systemd cold starts handle
            const result = await startPreview(health.app);
            if (result.success) {
              autoStarted = true;
            }
          }
        }

        res.writeHead(200);
        res.end(JSON.stringify({ app: health.app, running: health.active || autoStarted, autoStarted }));
        return;
      }

      if (req.method === 'POST') {
        const body = await parseBody(req);
        const { app: appDir, script } = body as { app?: string; script?: string };
        const result = await setPreviewApp(appDir || null, script);

        // Poll health until the dev server is actually serving HTTP.
        let health = await getPreviewHealth(appDir || undefined);
        if (appDir && health.app === appDir && !health.active && health.phase !== 'crashed') {
          for (let i = 0; i < 10; i++) {
            await new Promise<void>(r => setTimeout(r, 1000));
            health = await getPreviewHealth(appDir);
            if (health.active || health.phase === 'crashed') break;
          }
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ...result, health }));
        return;
      }
    }

    // POST /api/preview/restart — reset-failed + restart the preview unit.
    if (req.method === 'POST' && pathname === '/api/preview/restart') {
      const body = await parseBody(req);
      const { app: appDir } = body as { app?: string };
      if (!appDir) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing "app" field' }));
        return;
      }
      const r = await restartPreview(appDir);
      res.writeHead(r.ok ? 200 : 500);
      res.end(JSON.stringify(r));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/preview/spec') {
      const appDir = typeof parsedUrl.query?.app === 'string' ? parsedUrl.query.app : null;
      if (!appDir) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Missing "app" param' })); return; }
      const resolvedDir = resolveProjectDir(appDir);
      if (!resolvedDir) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: 'Invalid directory' })); return; }
      const { readSpec } = require('@vps/shared/preview-spec') as typeof import('@vps/shared/preview-spec');
      const spec = readSpec(path.join(ROOT_DIR, resolvedDir));
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, spec: spec ?? null }));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/preview/spec') {
      const body = await parseBody(req);
      const {
        app: appDir,
        start,
        port: reqPort,
        runtime: reqRuntime,
        prodStart: reqProdStart,
        env: reqEnv,
        prodEnv: reqProdEnv,
        mode: reqMode,
      } = body as {
        app?: string;
        start?: string;
        port?: number;
        runtime?: string;
        prodStart?: string;
        env?: Record<string, string>;
        prodEnv?: Record<string, string>;
        mode?: string;
      };
      if (!appDir || typeof appDir !== 'string') {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: 'Missing "app" field' }));
        return;
      }
      if (!start || typeof start !== 'string' || !start.trim()) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: 'Missing or empty "start" field' }));
        return;
      }
      const resolvedDir = resolveProjectDir(appDir);
      if (!resolvedDir) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: 'Invalid or non-existent app directory' }));
        return;
      }
      // Port: prefer the client's explicit choice when valid, else fall
      let chosenPort: number;
      if (typeof reqPort === 'number' && Number.isFinite(reqPort) && reqPort > 0 && reqPort < 65536) {
        chosenPort = Math.floor(reqPort);
      } else {
        chosenPort = getProjectPort(resolvedDir);
      }
      // Validate runtime against the narrow PreviewRuntime set. The
      const VALID_RUNTIMES = new Set([
        'node', 'python', 'ruby', 'go', 'rust', 'php', 'dotnet',
        'java', 'elixir', 'bun', 'static',
      ]);
      const runtime = (typeof reqRuntime === 'string' && VALID_RUNTIMES.has(reqRuntime))
        ? (reqRuntime as 'node')
        : 'node';

      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { writeSpec, readSpec } = require('@vps/shared/preview-spec') as typeof import('@vps/shared/preview-spec');
      const appPath = path.join(ROOT_DIR, resolvedDir);
      try {
        // Preserve fields the client didn't touch (env overrides,
        const existing = readSpec(appPath) ?? undefined;
        const merged = {
          version: 1 as const,
          runtime,
          start: start.trim(),
          port: chosenPort,
          ...(reqProdStart && typeof reqProdStart === 'string' && reqProdStart.trim()
            ? { prodStart: reqProdStart.trim() }
            : existing?.prodStart
              ? { prodStart: existing.prodStart }
              : {}),
          ...(isValidEnvRecord(reqEnv) ? { env: reqEnv } : existing?.env ? { env: existing.env } : {}),
          ...(isValidEnvRecord(reqProdEnv) ? { prodEnv: reqProdEnv } : existing?.prodEnv ? { prodEnv: existing.prodEnv } : {}),
          ...(reqMode === 'hot' || reqMode === 'warm' ? { mode: reqMode as 'hot' | 'warm' } : existing?.mode ? { mode: existing.mode } : {}),
          ...(existing?.openApiPath ? { openApiPath: existing.openApiPath } : {}),
        };
        writeSpec(appPath, merged);
        // Stop + start (not restart) so we get the full
        await stopPreview(resolvedDir);
        const preview = await startPreview(resolvedDir);
        // Fresh health — lets the client populate its query cache
        const health = await getPreviewHealth(resolvedDir);
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, spec: merged, preview, health }));
        return;
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
        return;
      }
    }

    // apart from "user sees a blank page because of a platform bug."
    if (req.method === 'POST' && pathname === '/api/preview/verify') {
      const body = await parseBody(req);
      const { app: appDir } = body as { app?: string };
      if (!appDir) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing "app" field' }));
        return;
      }
      const cached = previewVerifyCache.get(appDir);
      const now = Date.now();
      if (cached && (now - cached.at) < PREVIEW_VERIFY_CACHE_TTL_MS) {
        recordVerifyCacheOutcome(true);
        res.writeHead(200);
        res.end(JSON.stringify({ ...cached.result, cached: true, ageMs: now - cached.at }));
        return;
      }
      recordVerifyCacheOutcome(false);
      const result = await probePreview(appDir);
      const entry = { ...result } as unknown as Record<string, unknown>;
      previewVerifyCache.set(appDir, { at: now, result: entry });
      res.writeHead(200);
      res.end(JSON.stringify({ ...entry, cached: false, ageMs: 0 }));
      return;
    }

    // GET /api/preview/health — structured health for agent-bridge polling
    if (req.method === 'GET' && pathname === '/api/preview/health') {
      const queryProject = parsedUrl.query.project as string | undefined;
      const health = await getPreviewHealth(queryProject || undefined);
      res.writeHead(200);
      res.end(JSON.stringify(health));
      return;
    }

    // GET /api/preview/metrics — operational counters for observability
    if (req.method === 'GET' && pathname === '/api/preview/metrics') {
      res.writeHead(200);
      res.end(JSON.stringify(getPreviewMetrics()));
      return;
    }

    // GET /api/metrics — Prometheus text exposition (full preview-
    if (req.method === 'GET' && pathname === '/api/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.1.0; charset=utf-8' });
      res.end(renderPreviewPrometheus());
      return;
    }

    // GET /api/metrics.json — JSON snapshot for consumers that want
    if (req.method === 'GET' && pathname === '/api/metrics.json') {
      res.writeHead(200);
      res.end(JSON.stringify(previewMetricsSnapshot()));
      return;
    }

    // boot-durable safety net (the in-process tick handles normal
    if (req.method === 'POST' && pathname === '/api/preview/reconcile') {
      const internalToken = req.headers['x-internal-token'];
      let expected = '';
      try { expected = fs.readFileSync('/run/shield/internal-file-api.token', 'utf8').trim(); } catch {}
      if (!internalToken || !expected || internalToken !== expected) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      try {
        const report = await reconcileOnce((level, msg, ctx) => {
          const rec = { level, time: new Date().toISOString(), svc: 'preview-reconciler-oneshot', msg, ...(ctx ?? {}) };
          (level === 'error' ? console.error : console.log)(JSON.stringify(rec));
        });
        res.writeHead(200);
        res.end(JSON.stringify(report));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
      return;
    }

    // GET /api/preview/all — multi-preview health (primary + companions)
    if (req.method === 'GET' && pathname === '/api/preview/all') {
      res.writeHead(200);
      res.end(JSON.stringify(await getAllPreviewHealth()));
      return;
    }

    // GET /api/preview/estimate — RAM estimate for a package before starting
    if (req.method === 'GET' && pathname === '/api/preview/estimate') {
      const app = typeof parsedUrl.query?.app === 'string' ? parsedUrl.query.app : null;
      if (!app) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing "app" query parameter' }));
        return;
      }
      try {
        const reservation = resolveCandidateReservation(app);
        const signals = readAdmissionSignals();
        res.writeHead(200);
        res.end(JSON.stringify({
          estimatedSteadyMB: reservation.steadyMB,
          estimatedPeakMB: reservation.devPeakMB,
          availableMB: signals.memAvailableMB,
          totalMB: signals.physicalMB,
          wouldFit: reservation.steadyMB <= signals.memAvailableMB,
          frameworkId: reservation.frameworkId,
        }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    // POST /api/preview/companion — start a companion preview
    if (req.method === 'POST' && pathname === '/api/preview/companion') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { app, pathPrefix } = JSON.parse(body) as { app?: string; pathPrefix?: string };
          if (!app) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing "app" field' }));
            return;
          }
          const result = await startCompanionPreview(app, pathPrefix);
          res.writeHead(result.success ? 200 : 400);
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
      });
      return;
    }

    // DELETE /api/preview/companion — stop a companion preview
    if (req.method === 'DELETE' && pathname === '/api/preview/companion') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        try {
          const { app } = JSON.parse(body) as { app?: string };
          if (!app) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing "app" field' }));
            return;
          }
          await stopCompanionPreview(app);
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: (e as Error).message }));
        }
      });
      return;
    }

    // GET/POST/DELETE /api/context
    if (pathname === '/api/context') {
      const fileName = parsedUrl.query.file as string | undefined;

      if (req.method === 'GET' && !fileName) {
        const files = listContextFiles();
        const json = JSON.stringify({ files });
        res.writeHead(200, { 'Content-Length': Buffer.byteLength(json) });
        res.end(json);
        return;
      }

      if (req.method === 'GET' && fileName) {
        const result = getContextFile(fileName);
        if (!result) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'File not found' }));
          return;
        }
        const json = JSON.stringify(result);
        res.writeHead(200, { 'Content-Length': Buffer.byteLength(json) });
        res.end(json);
        return;
      }

      if (req.method === 'POST') {
        const body = await parseBody(req);
        const { file, content } = body as { file?: string; content?: string };
        if (!file || content === undefined) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing file or content' }));
          return;
        }
        const result = saveContextFile(file, content);
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === 'DELETE' && fileName) {
        const result = deleteContextFile(fileName);
        res.writeHead(result.success ? 200 : result.error === 'File not found' ? 404 : 403);
        res.end(JSON.stringify(result));
        return;
      }
    }

    // GET/POST /api/zeroclaw/workspace
    if (pathname === '/api/zeroclaw/workspace') {
      const wsFile = parsedUrl.query.file as string | undefined;

      if (req.method === 'GET' && !wsFile) {
        const files = listZeroclawWorkspaceFiles();
        res.writeHead(200);
        res.end(JSON.stringify({ files }));
        return;
      }

      if (req.method === 'GET' && wsFile) {
        const result = getZeroclawWorkspaceFile(wsFile);
        if (!result) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'File not found' }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === 'POST') {
        const body = await parseBody(req);
        const { file, content } = body as { file?: string; content?: string };
        if (!file || content === undefined) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing file or content' }));
          return;
        }
        const result = saveZeroclawWorkspaceFile(file, content);
        res.writeHead(result.success ? 200 : 400);
        res.end(JSON.stringify(result));
        return;
      }
    }

    // GET /api/zeroclaw/channels
    if (req.method === 'GET' && pathname === '/api/zeroclaw/channels') {
      const project = parsedUrl.query.project as string | undefined;
      const channels = getZeroclawChannels(project);
      res.writeHead(200);
      res.end(JSON.stringify({ channels }));
      return;
    }

    // PUT /api/zeroclaw/channels/:channel
    if (req.method === 'PUT' && pathname.startsWith('/api/zeroclaw/channels/')) {
      const channel = pathname.split('/').pop();
      if (!channel) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing channel' }));
        return;
      }
      const project = parsedUrl.query.project as string | undefined;
      const body = await parseBody(req);
      const result = saveZeroclawChannel(channel, body as Record<string, unknown>, project);
      res.writeHead(result.success ? 200 : 400);
      res.end(JSON.stringify(result));
      return;
    }

    // GET /api/zeroclaw/channels/whatsapp/qr — self-contained QR pairing page (for iframe)
    if (req.method === 'GET' && pathname === '/api/zeroclaw/channels/whatsapp/qr') {
      const project = parsedUrl.query.project as string | undefined;
      const html = getWhatsAppQrPageHtml(project);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // GET /api/zeroclaw/channels/whatsapp/qr-stream — SSE stream of QR data
    if (req.method === 'GET' && pathname === '/api/zeroclaw/channels/whatsapp/qr-stream') {
      const project = parsedUrl.query.project as string | undefined;
      handleWhatsAppQrStream(res, project);
      return;
    }

    // POST /api/zeroclaw/channels/whatsapp/login — start WhatsApp QR pairing
    if (req.method === 'POST' && pathname === '/api/zeroclaw/channels/whatsapp/login') {
      const project = parsedUrl.query.project as string | undefined;
      const result = startWhatsAppLogin(project, broadcast);
      res.writeHead(result.success ? 200 : 500);
      res.end(JSON.stringify(result));
      return;
    }

    // DELETE /api/zeroclaw/channels/whatsapp/login — stop WhatsApp QR pairing
    if (req.method === 'DELETE' && pathname === '/api/zeroclaw/channels/whatsapp/login') {
      stopWhatsAppLogin();
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // GET /api/zeroclaw/llm-key — check BYOK key status
    if (req.method === 'GET' && pathname === '/api/zeroclaw/llm-key') {
      const result = getZeroclawLlmKey();
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    // PUT /api/zeroclaw/llm-key — save BYOK key
    if (req.method === 'PUT' && pathname === '/api/zeroclaw/llm-key') {
      const body = await parseBody(req);
      const provider = body.provider as string | undefined;
      const apiKey = body.apiKey as string | undefined;
      if (!provider || !apiKey) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing provider or apiKey' }));
        return;
      }
      const modelId = body.modelId as string | undefined;
      const result = saveZeroclawLlmKey(provider, apiKey, modelId);
      res.writeHead(result.success ? 200 : 400);
      res.end(JSON.stringify(result));
      return;
    }

    // DELETE /api/zeroclaw/llm-key — remove BYOK key
    if (req.method === 'DELETE' && pathname === '/api/zeroclaw/llm-key') {
      const result = removeZeroclawLlmKey();
      res.writeHead(200);
      res.end(JSON.stringify(result));
      return;
    }

    // GET /api/assets/:app/icon
    if (req.method === 'GET' && pathname.startsWith('/api/assets/') && pathname.endsWith('/icon')) {
      const pathParts = pathname.split('/');
      const appIdentifier = pathParts[3];

      if (!appIdentifier) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing app identifier' }));
        return;
      }

      // Resolve identifier to directory (supports both directory and name)
      const directory = resolveProjectDir(appIdentifier);
      if (!directory) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'App not found' }));
        return;
      }

      const appPath = path.join(ROOT_DIR, directory);

      const searchPaths = [
        '.ellul/icon.png',
        'public/favicon.ico',
        'public/logo.png',
        'public/icon.png',
        'static/favicon.ico',
        'static/logo.png',
        'assets/logo.png',
        'logo.png',
      ];

      for (const p of searchPaths) {
        const fullPath = path.join(appPath, p);
        if (fs.existsSync(fullPath)) {
          const ext = path.extname(fullPath).toLowerCase();
          const mimeTypes: Record<string, string> = {
            '.png': 'image/png',
            '.ico': 'image/x-icon',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.svg': 'image/svg+xml',
          };
          const contentType = mimeTypes[ext] || 'application/octet-stream';

          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', 'public, max-age=3600');
          res.writeHead(200);
          res.end(fs.readFileSync(fullPath));
          return;
        }
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'No icon found' }));
      return;
    }

    // POST /api/processes/kill-ports
    if (req.method === 'POST' && pathname === '/api/processes/kill-ports') {
      const body = await parseBody(req);
      const { ports } = body as { ports?: number[] };

      if (!Array.isArray(ports)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid ports: expected array' }));
        return;
      }

      const result = killProcessesOnPorts(ports);
      res.writeHead(result.success ? 200 : 400);
      res.end(JSON.stringify(result));
      return;
    }

    // Hydrate workspace from Neon snapshot (called by platform during wake)
    if (req.method === 'POST' && pathname === '/api/hydrate') {
      const body = await parseBody(req);
      const { snapshotId } = body as { snapshotId?: string };

      if (!snapshotId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Missing snapshotId' }));
        return;
      }

      // Read server config from filesystem
      const { execFileSync } = await import('child_process');
      const serverId = fs.readFileSync(PATHS.SERVER_ID, 'utf8').trim();
      const apiUrl = fs.readFileSync(PATHS.API_URL, 'utf8').trim();
      const aiProxyToken = process.env.AI_PROXY_TOKEN?.trim() || '';

      console.log(`[file-api] Hydrating workspace from snapshot ${snapshotId.slice(0, 8)}...`);

      try {
        // Run hydrate.sh script (packaged at /opt/ellul/startup-agent/hydrate.sh)
        const hydratePath = '/opt/ellul/startup-agent/hydrate.sh';
        if (!fs.existsSync(hydratePath)) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'hydrate.sh not found' }));
          return;
        }

        // to the control plane — pass via env so it never appears in
        execFileSync('bash', [hydratePath, serverId, apiUrl], {
          timeout: 300_000, // 5 min max
          stdio: 'inherit',
          env: { ...process.env, ELLUL_AI_PROXY_TOKEN: aiProxyToken },
        });

        console.log('[file-api] Hydration complete');
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (hydrateErr) {
        const errMsg = hydrateErr instanceof Error ? hydrateErr.message : 'Unknown error';
        console.error('[file-api] Hydration failed:', errMsg);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Hydration failed', details: errMsg }));
      }
      return;
    }

    // ============================================
    // Daemon infrastructure endpoints (JWT authenticated)
    // ============================================

    // POST /api/maintenance-mode — Toggle 503 maintenance page during migrations
    if (req.method === 'POST' && pathname === '/api/maintenance-mode') {
      const body = await parseBody(req);
      const { enabled } = body as { enabled?: boolean };

      try {
        const maintenanceFlag = '/tmp/ellul-maintenance.flag';
        if (enabled) {
          fs.writeFileSync(maintenanceFlag, `${Date.now()}`);
          console.log('[file-api] Maintenance mode ENABLED');
        } else {
          try { fs.unlinkSync(maintenanceFlag); } catch {}
          console.log('[file-api] Maintenance mode DISABLED');
        }
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, enabled: !!enabled }));
      } catch (e) {
        const error = e as Error;
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
      return;
    }

    // POST /api/wake-enforcer — Send SIGUSR1 to the enforcer for instant command pickup.
    if (req.method === 'POST' && pathname === '/api/wake-enforcer') {
      // Auth: verify the AI proxy token matches what's stored on this VPS
      const authHeader = req.headers['authorization'] || '';
      const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      const storedToken = process.env.AI_PROXY_TOKEN?.trim() || '';

      if (!bearerToken || !storedToken || bearerToken !== storedToken) {
        res.writeHead(401);
        res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
        return;
      }

      try {
        const { execSync } = await import('child_process');
        const pidFile = '/run/ellul-enforcer.pid';
        if (fs.existsSync(pidFile)) {
          const pid = fs.readFileSync(pidFile, 'utf8').trim();
          if (/^\d+$/.test(pid)) {
            execSync(`kill -USR1 ${pid}`, { timeout: 5_000 });
            res.writeHead(200);
            res.end(JSON.stringify({ success: true, pid: parseInt(pid) }));
          } else {
            res.writeHead(500);
            res.end(JSON.stringify({ success: false, error: 'Invalid PID in pidfile' }));
          }
        } else {
          res.writeHead(404);
          res.end(JSON.stringify({ success: false, error: 'Enforcer PID file not found' }));
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[file-api] wake-enforcer failed: ${msg}`);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: msg }));
      }
      return;
    }

    // POST /api/mount-volume — Mount a block volume at the user's home directory (hibernate wake)
    if (req.method === 'POST' && pathname === '/api/mount-volume') {
      const body = await parseBody(req);
      const { volumeDevice, luksPassphrase } = body as {
        volumeDevice?: string;
        luksPassphrase?: string;
      };

      if (!volumeDevice) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Missing volumeDevice' }));
        return;
      }

      if (!isValidDevicePath(volumeDevice)) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid volume device path' }));
        return;
      }

      try {
        const { execSync } = await import('child_process');
        const { writeFileSync, unlinkSync } = await import('fs');

        // Fixed well-known key file path on tmpfs (never hits disk, never in CLI args).
        // Using a fixed path avoids leaking the filename in ps output.
        const LUKS_KEY_PATH = '/dev/shm/.luks-platform-key';
        if (luksPassphrase) {
          writeFileSync(LUKS_KEY_PATH, luksPassphrase, { mode: 0o600 });
        }

        let result: string;
        try {
          result = execSync(
            `sudo /usr/local/bin/ellul-mount-volume mount "${volumeDevice}"`,
            { timeout: 120_000, encoding: 'utf8' }
          );
        } finally {
          // Belt-and-suspenders cleanup (script also deletes, but ensure no leak)
          try { unlinkSync(LUKS_KEY_PATH); } catch {}
        }
        const parsed = JSON.parse(result.trim());
        console.log(`[file-api] Volume mount result:`, parsed);
        res.writeHead(parsed.success ? 200 : 500);
        res.end(result.trim());
      } catch (e) {
        const error = e as Error;
        console.error('[file-api] Volume mount failed:', error.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
      return;
    }

    // POST /api/flush-volume — Flush filesystem buffers before volume detach (hibernate)
    if (req.method === 'POST' && pathname === '/api/flush-volume') {
      try {
        const { execSync } = await import('child_process');
        const result = execSync(
          'sudo /usr/local/bin/ellul-mount-volume flush',
          { timeout: 15_000, encoding: 'utf8' }
        );
        const parsed = JSON.parse(result.trim());
        res.writeHead(parsed.success ? 200 : 500);
        res.end(result.trim());
      } catch (e) {
        const error = e as Error;
        console.error('[file-api] Volume flush failed:', error.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
      return;
    }

    // Called when graceful flush-volume fails. Kills all processes on the mount,
    if (req.method === 'POST' && pathname === '/api/force-unmount') {
      try {
        const { execSync } = await import('child_process');
        const result = execSync(
          'sudo /usr/local/bin/ellul-mount-volume force-unmount',
          { timeout: 180_000, encoding: 'utf8' }
        );
        const parsed = JSON.parse(result.trim());
        console.log('[file-api] Force-unmount result:', parsed);
        res.writeHead(parsed.success ? 200 : 500);
        res.end(result.trim());
      } catch (e) {
        const error = e as Error;
        console.error('[file-api] Force-unmount failed:', error.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
      return;
    }

    // POST /api/grow-volume — Online-grow the service-home filesystem
    if (req.method === 'POST' && pathname === '/api/grow-volume') {
      try {
        const { execSync } = await import('child_process');
        const result = execSync(
          'sudo /usr/local/bin/ellul-mount-volume grow',
          { timeout: 120_000, encoding: 'utf8' }
        );
        const parsed = JSON.parse(result.trim());
        console.log('[file-api] Volume grow result:', parsed);
        res.writeHead(parsed.success ? 200 : 500);
        res.end(result.trim());
      } catch (e) {
        const error = e as Error;
        console.error('[file-api] Volume grow failed:', error.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
      return;
    }

    // POST /api/update-identity — Update server identity after migration
    if (req.method === 'POST' && pathname === '/api/update-identity') {
      const body = await parseBody(req);
      const { serverId, domain, userId, billingTier, product, deploymentModel, securityTier, userLocale } = body as {
        serverId?: string; domain?: string; userId?: string; billingTier?: string; product?: string; deploymentModel?: string; securityTier?: string; userLocale?: string;
      };

      if (!serverId) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Missing serverId' }));
        return;
      }

      // Validate inputs to prevent command injection
      const safePattern = /^[a-zA-Z0-9._:-]+$/;
      if (!safePattern.test(serverId)) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid serverId format' }));
        return;
      }
      if (domain && !safePattern.test(domain)) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid domain format' }));
        return;
      }
      if (userId && !safePattern.test(userId)) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid userId format' }));
        return;
      }
      if (billingTier && !safePattern.test(billingTier)) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid billingTier format' }));
        return;
      }
      if (product && !safePattern.test(product)) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid product format' }));
        return;
      }
      if (deploymentModel && !safePattern.test(deploymentModel)) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid deploymentModel format' }));
        return;
      }
      if (securityTier && !safePattern.test(securityTier)) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid securityTier format' }));
        return;
      }
      if (userLocale && !safePattern.test(userLocale)) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Invalid userLocale format' }));
        return;
      }

      try {
        const { execSync } = await import('child_process');

        // Build command args for the privileged helper
        let cmd = `sudo /usr/local/bin/ellul-update-identity --server-id=${serverId}`;
        if (domain) cmd += ` --domain=${domain}`;
        if (userId) cmd += ` --user-id=${userId}`;
        if (billingTier) cmd += ` --billing-tier=${billingTier}`;
        if (product) cmd += ` --product=${product}`;
        if (deploymentModel) cmd += ` --deployment-model=${deploymentModel}`;
        if (securityTier) cmd += ` --security-tier=${securityTier}`;
        if (userLocale) cmd += ` --user-locale=${userLocale}`;

        // The identity script uses `caddy reload` (not restart) to apply the new
        const result = execSync(cmd, { timeout: 120_000, encoding: 'utf8' });
        const trimmed = result.trim();
        // Extract last JSON line — helper script may emit non-JSON logs before final output
        const lastLine = trimmed.split('\n').pop() || '{}';
        const parsed = JSON.parse(lastLine);

        console.log(`[file-api] Identity updated: serverId=${serverId}, domain=${domain || 'unchanged'}`);
        res.writeHead(parsed.success ? 200 : 500);
        res.end(lastLine);
      } catch (e) {
        const error = e as Error;
        console.error('[file-api] Identity update failed:', error.message.slice(0, 500));
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: error.message.slice(0, 500) }));
      }
      return;
    }

    // ============================================
    // LUKS Volume Encryption endpoints (daemon API - JWT authenticated)
    // ============================================

    // POST /api/luks-init — First-time LUKS2 format with PRF key + optional recovery key
    if (req.method === 'POST' && pathname === '/api/luks-init') {
      const body = await parseBody(req);
      const { prfKey, recoveryKey, volumeDevice } = body as { prfKey?: string; recoveryKey?: string; volumeDevice?: string };

      if (!prfKey) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Missing prfKey' }));
        return;
      }

      const { execSync } = await import('child_process');

      // Decode PRF key — zeroed in finally block to minimize heap exposure
      let keyBuffer: Buffer | null = null;
      let recoveryBuffer: Buffer | null = null;

      try {
        keyBuffer = Buffer.from(prfKey as string, 'base64');
        if (keyBuffer.length !== 32) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Invalid PRF key length' }));
          return;
        }

        // Read volume device — accept from request body or from disk file
        const deviceFilePath = '/etc/ellul/volume-device';
        let device = '';
        if (volumeDevice) {
          device = volumeDevice;
          fs.mkdirSync('/etc/ellul', { recursive: true });
          fs.writeFileSync(deviceFilePath, device);
          fs.chmodSync(deviceFilePath, 0o644);
        } else if (fs.existsSync(deviceFilePath)) {
          device = fs.readFileSync(deviceFilePath, 'utf8').trim();
        }
        if (!device) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'No volume device configured' }));
          return;
        }
        if (!isValidDevicePath(device)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Invalid volume device path' }));
          return;
        }

        // Backup skeleton
        const skelTmp = `/tmp/skel-backup-${process.pid}`;
        execSync(`cp -a ${HOME}/. ${skelTmp}/`, { timeout: 30_000 });

        // Unmount if currently mounted
        try {
          execSync(`mountpoint -q ${HOME} && umount ${HOME}`, { timeout: 10_000 });
        } catch { /* not mounted, fine */ }

        // Flags MUST match enforcer (heartbeat.sh) and device-mount.sh exactly.
        console.log(`[file-api] LUKS formatting ${device}`);
        execSync(
          `cryptsetup luksFormat --type luks2 --cipher aes-xts-plain64 --key-size 512 --hash sha256 --pbkdf argon2id --pbkdf-memory 262144 --pbkdf-parallel 2 --batch-mode --key-file=- ${device}`,
          { input: keyBuffer, timeout: 120_000 }
        );

        // Add recovery key as slot 1 if provided
        if (recoveryKey) {
          recoveryBuffer = Buffer.from(recoveryKey as string, 'base64');
          const tmpKeyFile = `/tmp/luks-key-${process.pid}`;
          fs.writeFileSync(tmpKeyFile, keyBuffer, { mode: 0o600 });
          try {
            execSync(
              `cryptsetup luksAddKey --pbkdf pbkdf2 --pbkdf-force-iterations 1000 --key-file=${tmpKeyFile} ${device} -`,
              { input: recoveryBuffer, timeout: 120_000 }
            );
          } finally {
            // Securely wipe temp key file (shred overwrites on-disk blocks)
            try { execSync(`shred -fz -n 1 ${tmpKeyFile} && rm -f ${tmpKeyFile}`, { timeout: 5_000 }); }
            catch { try { fs.unlinkSync(tmpKeyFile); } catch {} }
          }
          console.log('[file-api] Recovery key added as LUKS key slot 1');
        }

        // Open LUKS container
        execSync(
          `cryptsetup luksOpen --key-file=- ${device} luks-home`,
          { input: keyBuffer, timeout: 30_000 }
        );

        // Format and mount
        execSync(`mkfs.ext4 -L ellul-home /dev/mapper/luks-home`, { timeout: 30_000 });
        execSync(`mount -o nosuid,nodev /dev/mapper/luks-home ${HOME}`, { timeout: 10_000 });

        // Restore skeleton and fix ownership
        execSync(`cp -a ${skelTmp}/. ${HOME}/`, { timeout: 30_000 });
        execSync(`rm -rf ${skelTmp}`, { timeout: 10_000 });

        // Read SVC_USER from config
        let svcUser = 'dev';
        try {
          if (fs.existsSync('/etc/default/ellul')) {
            const envContent = fs.readFileSync('/etc/default/ellul', 'utf8');
            const match = envContent.match(/PS_USER=(\w+)/);
            if (match?.[1]) svcUser = match[1];
          }
        } catch {}
        execSync(`chown -R ${svcUser}:${svcUser} ${HOME}`, { timeout: 30_000 });

        // Boot volume path is NEVER vault-bound — survives vault bind-mount overlay.
        fs.mkdirSync('/etc/ellul-bootstrap', { recursive: true, mode: 0o755 });
        fs.writeFileSync('/etc/ellul-bootstrap/volume-was-encrypted', '1', { mode: 0o644 });
        fs.writeFileSync('/etc/ellul/volume-was-encrypted', '1', { mode: 0o644 });

        // Notify API: volume_encrypted event (fire-and-forget)
        notifyApi('volume_encrypted').catch(() => {});

        console.log('[file-api] LUKS init complete');
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        const error = e as Error;
        console.error('[file-api] LUKS init failed:', error.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: error.message }));
      } finally {
        // Zero all key material — prevents lingering in V8 heap until GC
        if (keyBuffer) keyBuffer.fill(0);
        if (recoveryBuffer) recoveryBuffer.fill(0);
      }
      return;
    }

    // POST /api/luks-unlock — Wake unlock: open LUKS + mount
    if (req.method === 'POST' && pathname === '/api/luks-unlock') {
      const body = await parseBody(req);
      const { prfKey, volumeDevice } = body as { prfKey?: string; volumeDevice?: string };

      if (!prfKey) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Missing prfKey' }));
        return;
      }

      const { execSync } = await import('child_process');

      // Decode PRF key — zeroed in finally block
      let keyBuffer: Buffer | null = null;

      try {
        keyBuffer = Buffer.from(prfKey as string, 'base64');
        if (keyBuffer.length !== 32) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Invalid PRF key length' }));
          return;
        }

        // Check if already mounted
        try {
          execSync(`mountpoint -q ${HOME}`, { timeout: 5_000 });
          // Already mounted
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, alreadyMounted: true }));
          return;
        } catch { /* not mounted, proceed */ }

        // Read volume device — accept from request body (pool wake) or from disk file
        const deviceFilePath = '/etc/ellul/volume-device';
        let device = '';
        if (volumeDevice) {
          // Pool wake: API passes device path; persist for future use
          device = volumeDevice;
          fs.mkdirSync('/etc/ellul', { recursive: true });
          fs.writeFileSync(deviceFilePath, device);
          fs.chmodSync(deviceFilePath, 0o644);
        } else if (fs.existsSync(deviceFilePath)) {
          device = fs.readFileSync(deviceFilePath, 'utf8').trim();
        }
        if (!device) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'No volume device configured' }));
          return;
        }
        if (!isValidDevicePath(device)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Invalid volume device path' }));
          return;
        }

        // Wait for device to appear (cloud attach can be slow)
        let waited = 0;
        while (!fs.existsSync(device) && waited < 60) {
          await new Promise(r => setTimeout(r, 1000));
          waited++;
        }
        if (!fs.existsSync(device)) {
          res.writeHead(500);
          res.end(JSON.stringify({ success: false, error: `Device ${device} not found after 60s` }));
          return;
        }

        // Open LUKS — key via stdin
        console.log(`[file-api] LUKS unlocking ${device}`);
        execSync(
          `cryptsetup luksOpen --key-file=- ${device} luks-home`,
          { input: keyBuffer, timeout: 30_000 }
        );

        // Mount + vault restore via the mount script (single source of truth).
        const mountResult = execSync(
          `sudo /usr/local/bin/ellul-mount-volume mount "${device}"`,
          { timeout: 120_000, encoding: 'utf8' }
        );
        console.log(`[file-api] LUKS mount-volume result:`, mountResult.trim());

        // Handler in security.ts transitions server from awaiting_unlock → running.
        notifyApi('volume_unlocked').catch(() => {});

        console.log('[file-api] LUKS unlock + mount complete');
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        const error = e as Error;
        console.error('[file-api] LUKS unlock failed:', error.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: error.message }));
      } finally {
        // Zero key material — prevents lingering in V8 heap until GC
        if (keyBuffer) keyBuffer.fill(0);
      }
      return;
    }

    // luks-close moved to enforcer DIRECT command — file-api cannot safely unmount

    // POST /api/luks-rotate-key — Rotate LUKS PRF key without unmounting
    if (req.method === 'POST' && pathname === '/api/luks-rotate-key') {
      const body = await parseBody(req);
      const { currentPrfKey, newPrfKey } = body as { currentPrfKey?: string; newPrfKey?: string };

      if (!currentPrfKey || !newPrfKey) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Missing currentPrfKey or newPrfKey' }));
        return;
      }

      const { execSync } = await import('child_process');

      // Decode keys — zeroed in finally block
      let currentKeyBuffer: Buffer | null = null;
      let newKeyBuffer: Buffer | null = null;

      try {
        currentKeyBuffer = Buffer.from(currentPrfKey as string, 'base64');
        newKeyBuffer = Buffer.from(newPrfKey as string, 'base64');
        if (currentKeyBuffer.length !== 32 || newKeyBuffer.length !== 32) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Invalid key length (expected 32 bytes)' }));
          return;
        }

        // Read volume device from persisted config
        const deviceFilePath = '/etc/ellul/volume-device';
        if (!fs.existsSync(deviceFilePath)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'No volume device configured' }));
          return;
        }
        const device = fs.readFileSync(deviceFilePath, 'utf8').trim();
        if (!isValidDevicePath(device)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Invalid volume device path' }));
          return;
        }

        // Serialize concurrent rotation requests (single-process Node server).
        if (luksRotationInProgress) {
          res.writeHead(409);
          res.end(JSON.stringify({ success: false, error: 'Another key rotation is in progress' }));
          return;
        }
        luksRotationInProgress = true;

        try {
          // Step 1: Add new key using current key as authentication
          const tmpCurrentKeyFile = `/tmp/luks-cur-${process.pid}`;
          fs.writeFileSync(tmpCurrentKeyFile, currentKeyBuffer, { mode: 0o600 });
          try {
            execSync(
              `cryptsetup luksAddKey --key-file=${tmpCurrentKeyFile} ${device} -`,
              { input: newKeyBuffer, timeout: 120_000 }
            );
          } finally {
            // Securely wipe temp key file
            try { execSync(`shred -fz -n 1 ${tmpCurrentKeyFile} && rm -f ${tmpCurrentKeyFile}`, { timeout: 5_000 }); }
            catch { try { fs.unlinkSync(tmpCurrentKeyFile); } catch {} }
          }

          // Step 2: Remove old key — luksRemoveKey reads the key-to-remove from stdin
          execSync(
            `cryptsetup luksRemoveKey ${device} -`,
            { input: currentKeyBuffer, timeout: 120_000 }
          );

          console.log('[file-api] LUKS key rotation complete');
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
        } finally {
          luksRotationInProgress = false;
        }
      } catch (e) {
        const error = e as Error;
        console.error('[file-api] LUKS key rotation failed:', error.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: error.message }));
      } finally {
        // Zero all key material — prevents lingering in V8 heap until GC
        if (currentKeyBuffer) currentKeyBuffer.fill(0);
        if (newKeyBuffer) newKeyBuffer.fill(0);
      }
      return;
    }

    // PRF key comes directly from browser (API never sees it).
    if (req.method === 'POST' && pathname === '/api/luks-add-prf-slot') {
      const body = await parseBody(req);
      const { prfKey, platformKey } = body as { prfKey?: string; platformKey?: string };

      if (!prfKey || !platformKey) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Missing prfKey or platformKey' }));
        return;
      }

      const { execSync } = await import('child_process');
      let prfBuffer: Buffer | null = null;
      let platformBuffer: Buffer | null = null;

      try {
        prfBuffer = Buffer.from(prfKey as string, 'base64');
        platformBuffer = Buffer.from(platformKey as string, 'base64');
        if (prfBuffer.length !== 32 || platformBuffer.length !== 32) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Invalid key length (expected 32 bytes)' }));
          return;
        }

        const deviceFilePath = '/etc/ellul/volume-device';
        if (!fs.existsSync(deviceFilePath)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'No volume device configured' }));
          return;
        }
        const device = fs.readFileSync(deviceFilePath, 'utf8').trim();
        if (!isValidDevicePath(device)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Invalid volume device path' }));
          return;
        }

        // ── Header backup before keyslot modification (defense-in-depth) ──
        const hdrBackupDir = path.join(HOME, '.ellul-vault', 'luks-headers');
        execSync(`mkdir -p ${hdrBackupDir} && chmod 700 ${hdrBackupDir}`, { timeout: 5_000 });
        const hdrBackupFile = `${hdrBackupDir}/header-${Date.now()}-pre-add-prf.img`;
        execSync(
          `cryptsetup luksHeaderBackup ${device} --header-backup-file ${hdrBackupFile} && chmod 600 ${hdrBackupFile}`,
          { timeout: 30_000 }
        );
        // Rotate: keep max 5 backups
        execSync(`ls -t ${hdrBackupDir}/header-*.img 2>/dev/null | tail -n +6 | xargs -r rm -f`, { timeout: 5_000 });
        console.log(`[file-api] LUKS header backed up before add-prf-slot: ${hdrBackupFile}`);

        // Write platform key to tmpfs for authentication
        const tmpAuthKeyFile = `/tmp/luks-auth-${process.pid}`;
        fs.writeFileSync(tmpAuthKeyFile, platformBuffer, { mode: 0o600 });
        try {
          // Add PRF key to slot 1, authenticated by platform key
          execSync(
            `cryptsetup luksAddKey --key-slot 1 --key-file=${tmpAuthKeyFile} ${device} -`,
            { input: prfBuffer, timeout: 120_000 }
          );
        } finally {
          try { execSync(`shred -fz -n 1 ${tmpAuthKeyFile} && rm -f ${tmpAuthKeyFile}`, { timeout: 5_000 }); }
          catch { try { fs.unlinkSync(tmpAuthKeyFile); } catch {} }
        }

        console.log('[file-api] PRF key added to LUKS slot 1 (enhanced mode)');
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        const error = e as Error;
        console.error('[file-api] LUKS add PRF slot failed:', error.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: error.message }));
      } finally {
        if (prfBuffer) prfBuffer.fill(0);
        if (platformBuffer) platformBuffer.fill(0);
      }
      return;
    }

    // POST /api/luks-remove-slot — Remove a LUKS key slot by passphrase
    if (req.method === 'POST' && pathname === '/api/luks-remove-slot') {
      const body = await parseBody(req);
      const { slotKey } = body as { slotKey?: string };

      if (!slotKey) {
        res.writeHead(400);
        res.end(JSON.stringify({ success: false, error: 'Missing slotKey' }));
        return;
      }

      const { execSync } = await import('child_process');
      let keyBuffer: Buffer | null = null;

      try {
        keyBuffer = Buffer.from(slotKey as string, 'base64');
        if (keyBuffer.length !== 32) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Invalid key length (expected 32 bytes)' }));
          return;
        }

        const deviceFilePath = '/etc/ellul/volume-device';
        if (!fs.existsSync(deviceFilePath)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'No volume device configured' }));
          return;
        }
        const device = fs.readFileSync(deviceFilePath, 'utf8').trim();
        if (!isValidDevicePath(device)) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: 'Invalid volume device path' }));
          return;
        }

        // ── Header backup before keyslot removal (defense-in-depth) ──
        const hdrBackupDir = path.join(HOME, '.ellul-vault', 'luks-headers');
        execSync(`mkdir -p ${hdrBackupDir} && chmod 700 ${hdrBackupDir}`, { timeout: 5_000 });
        const hdrBackupFile = `${hdrBackupDir}/header-${Date.now()}-pre-remove-slot.img`;
        execSync(
          `cryptsetup luksHeaderBackup ${device} --header-backup-file ${hdrBackupFile} && chmod 600 ${hdrBackupFile}`,
          { timeout: 30_000 }
        );
        execSync(`ls -t ${hdrBackupDir}/header-*.img 2>/dev/null | tail -n +6 | xargs -r rm -f`, { timeout: 5_000 });
        console.log(`[file-api] LUKS header backed up before remove-slot: ${hdrBackupFile}`);

        // luksRemoveKey removes the slot that matches the provided passphrase
        execSync(
          `cryptsetup luksRemoveKey ${device} -`,
          { input: keyBuffer, timeout: 120_000 }
        );

        console.log('[file-api] LUKS slot removed');
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        const error = e as Error;
        console.error('[file-api] LUKS remove slot failed:', error.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: error.message }));
      } finally {
        if (keyBuffer) keyBuffer.fill(0);
      }
      return;
    }

    // POST /api/backup-identity — Delegated to sovereign-shield (owns the auth DB)
    if (req.method === 'POST' && pathname === '/api/backup-identity') {
      try {
        const { callShieldInternal } = await import('@vps/shared/shield-client');
        const shieldResp = await callShieldInternal('/api/internal/backup-identity', { method: 'POST' });
        const result = await shieldResp.json() as Record<string, unknown>;

        console.log(`[file-api] Identity backup delegated to shield: ${JSON.stringify(result)}`);
        res.writeHead(shieldResp.status);
        res.end(JSON.stringify(result));
      } catch (e) {
        const error = e as Error;
        console.error('[file-api] Identity backup delegation failed:', error.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
      return;
    }

    // POST /api/restore-identity — Restore passkey DB from volume backup after wake
    if (req.method === 'POST' && pathname === '/api/restore-identity') {
      try {
        const { execSync } = await import('child_process');
        const result = execSync(
          'sudo /usr/local/bin/ellul-restore-identity',
          { timeout: 30_000, encoding: 'utf8' }
        );
        const trimmed = result.trim();
        const lastLine = trimmed.split('\n').pop() || '{}';
        const parsed = JSON.parse(lastLine);

        console.log(`[file-api] Identity restore result:`, parsed);
        res.writeHead(parsed.success ? 200 : 500);
        res.end(lastLine);
      } catch (e) {
        const error = e as Error;
        console.error('[file-api] Identity restore failed:', error.message);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: error.message }));
      }
      return;
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (e) {
    const error = e as Error;
    const status = error.message === 'Invalid JSON body' ? 400 : 500;
    res.writeHead(status);
    res.end(JSON.stringify({ error: error.message }));
  }
});

// Handle server errors
server.on('error', (err: NodeJS.ErrnoException) => {
  console.error('[file-api] Server error:', err.message);
  if (err.code === 'EADDRINUSE') {
    console.error('[file-api] Port ' + PORT + ' is already in use. Retrying in 5 seconds...');
    setTimeout(() => {
      server.close();
      server.listen(PORT, '127.0.0.1');
    }, 5000);
  }
});

server.on('clientError', (err, socket) => {
  console.error('[file-api] Client error:', err.message);
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

// Start server
server.listen(PORT, '127.0.0.1', () => {
  console.log(`ellul File API running on port ${PORT}`);

  // Preview reconciliation on startup (after 5s delay to let systemd settle).
  setTimeout(() => {
    void (async () => {
      try {
        const activeApps = await listActiveUnits();
        if (activeApps.length > 0) {
          console.log(`[file-api] Startup reconciliation: ${activeApps.length} active preview(s) found`);
          for (const appDir of activeApps) {
            try {
              const port = getProjectPort(appDir);
              if (port > 0) {
                ensureCaddyRoute(port);
                console.log(`[file-api] Restored Caddy route for ${appDir} → :${port}`);
              }
            } catch (e) {
              console.warn(`[file-api] Failed to restore route for ${appDir}:`, (e as Error).message);
            }
          }
          // Update preview state file so the UI knows what's active
          if (activeApps[0]) {
            try {
              fs.writeFileSync(path.join(process.env.HOME || '/home/dev', '.ellul', 'preview-app'), activeApps[0]);
            } catch {}
          }
        }
      } catch {}
      try { await reconcilePortRegistry(); } catch {}
      try { await cleanupOrphanedPreviews(); } catch {}
      try { await reconcileCompanions(); } catch {}
    })();
  }, 5000);
  // Preview GC hourly
  setInterval(() => {
    void (async () => {
      try { await reconcilePortRegistry(); } catch {}
      try { await cleanupOrphanedPreviews(); } catch {}
      try { await reconcileCompanions(); } catch {}
    })();
  }, 3600000);

  // Push-based safety net: failed-unit GC + idle eviction +
  startPreviewRef.current = async (directory: string) => {
    const r = await startPreview(directory);
    return { success: r.success, error: r.error, failReason: r.failReason ?? null };
  };
  startReconciler((level, msg, ctx) => {
    const logRecord: Record<string, unknown> = {
      level,
      time: new Date().toISOString(),
      svc: 'preview-reconciler',
      msg,
      ...(ctx ?? {}),
    };
    console.log(JSON.stringify(logRecord));
  });
});

// Set up WebSocket
setupWebSocket(server);

// Initialize file watchers
setTimeout(initWatchers, 1000);
setInterval(initWatchers, 60000); // Re-scan periodically

// Polling fallback — fs.watch is unreliable on Linux VPS
startPollingFallback();

// Initialize server status watcher
setTimeout(initServerStatusWatcher, 2000);

// Initialize preview status watcher (broadcasts when AI starts/stops preview)
initPreviewStatusWatcher();

// Initialize watchdog health watcher — pushes /api/watchdog/health deltas over
initWatchdogHealthWatcher();

console.log('[WS] WebSocket server ready on /ws');
