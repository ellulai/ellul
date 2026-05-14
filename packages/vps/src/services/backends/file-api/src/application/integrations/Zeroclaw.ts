// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// ZeroClaw reads config.toml for gateway/model/security settings; ellul.json

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { isSandboxId } from '@ellul.ai/types';
import { HOME, ROOT_DIR } from '../../config';
import { getActiveProject } from '../files/Files';

const ZEROCLAW_DIR = `${HOME}/.zeroclaw`;
// Platform sidecar config — channels, BYOK keys, bindings (JSON, not TOML)
const CONFIG_FILE = `${ZEROCLAW_DIR}/ellul.json`;
// ZeroClaw's own config — gateway, model, security (TOML)
const TOML_CONFIG_FILE = `${ZEROCLAW_DIR}/config.toml`;

function getPlatformAiProxyUrl(): string {
  try {
    const z = fs.readFileSync('/etc/ellul/platform-zone', 'utf8').trim();
    return `custom:https://api.${z}/api/ai`;
  } catch {
    return '';
  }
}

// Get the per-project .zeroclaw/ workspace directory.
function getWorkspaceDir(): string {
  const activeProject = getActiveProject();
  if (activeProject) {
    return path.join(ROOT_DIR, activeProject, '.zeroclaw');
  }
  return `${ZEROCLAW_DIR}/workspace`;
}

// Allowed workspace files (prevents path traversal)
const ALLOWED_WORKSPACE_FILES = new Set([
  'AGENTS.md',
  'SOUL.md',
  'TOOLS.md',
  'IDENTITY.md',
  'USER.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
  'MEMORY.md',
]);

export interface WorkspaceFileInfo {
  name: string;
  size: number;
  modified: string;
  preview: string;
}

// List all workspace files in the active project's .zeroclaw/ directory.
export function listZeroclawWorkspaceFiles(): WorkspaceFileInfo[] {
  const wsDir = getWorkspaceDir();
  if (!fs.existsSync(wsDir)) {
    return [];
  }

  const files: WorkspaceFileInfo[] = [];
  for (const f of fs.readdirSync(wsDir)) {
    if (!f.endsWith('.md')) continue;
    const filePath = path.join(wsDir, f);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      files.push({
        name: f,
        size: stat.size,
        modified: stat.mtime.toISOString(),
        preview: content.slice(0, 200),
      });
    } catch {
      // Skip unreadable files
    }
  }
  return files;
}

// Get a workspace file's content.
export function getZeroclawWorkspaceFile(fileName: string): {
  content: string;
  size: number;
  modified: string;
} | null {
  if (!ALLOWED_WORKSPACE_FILES.has(fileName)) {
    return null;
  }

  const wsDir = getWorkspaceDir();
  const filePath = path.join(wsDir, fileName);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const realPath = fs.realpathSync(filePath);
  if (!realPath.startsWith(fs.realpathSync(wsDir))) {
    return null; // Prevent symlink traversal
  }

  const content = fs.readFileSync(realPath, 'utf8');
  const stat = fs.statSync(realPath);
  return {
    content,
    size: stat.size,
    modified: stat.mtime.toISOString(),
  };
}

// Save a workspace file.
export function saveZeroclawWorkspaceFile(
  fileName: string,
  content: string
): { success: boolean; error?: string } {
  if (!ALLOWED_WORKSPACE_FILES.has(fileName)) {
    return { success: false, error: 'File not allowed' };
  }

  const wsDir = getWorkspaceDir();
  fs.mkdirSync(wsDir, { recursive: true });
  const filePath = path.join(wsDir, fileName);
  fs.writeFileSync(filePath, content);
  return { success: true };
}

// because channels/secrets etc. are all sandbox-scoped.
function isValidProjectName(name: string): boolean {
  return isSandboxId(name);
}

// Read the channels section from config.toml.
export function getZeroclawChannels(project?: string): Record<string, unknown> {
  if (!fs.existsSync(CONFIG_FILE)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const config = JSON.parse(raw);
    const channels = config.channels || {};

    if (!project) {
      return channels;
    }

    // Extract per-project channel configs from multi-account structure
    const result: Record<string, unknown> = {};
    for (const [channelName, channelData] of Object.entries(channels)) {
      if (!channelData || typeof channelData !== 'object') continue;
      const cd = channelData as Record<string, unknown>;

      // Multi-account structure: channels.telegram.accounts.{accountId}
      const accounts = cd.accounts as Record<string, unknown> | undefined;
      if (accounts && typeof accounts === 'object' && accounts[project]) {
        const acct = accounts[project] as Record<string, unknown>;
        result[channelName] = { ...acct, enabled: true };
      }
    }
    return result;
  } catch {
    return {};
  }
}

// Save a single channel's config into config.toml.
export function saveZeroclawChannel(
  channel: string,
  channelConfig: Record<string, unknown>,
  project?: string,
): { success: boolean; error?: string } {
  const allowed = ['whatsapp', 'telegram', 'discord', 'slack'];
  if (!allowed.includes(channel)) {
    return { success: false, error: 'Unknown channel' };
  }

  if (project) {
    if (!isValidProjectName(project)) {
      return { success: false, error: 'Invalid project name' };
    }
    return saveProjectChannel(channel, channelConfig, project);
  }

  // Global (no project) — save to sidecar for per-project daemons to pick up
  let config: Record<string, unknown> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {}
  }
  if (!config.channels || typeof config.channels !== 'object') {
    config.channels = {};
  }
  (config.channels as Record<string, unknown>)[channel] = channelConfig;
  fs.mkdirSync(ZEROCLAW_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

  // Per-project daemons pick up channel changes on next spawn (config regenerated each time)

  return { success: true };
}

// --- WhatsApp QR login process management ---

let whatsappLoginProc: ChildProcess | null = null;
let whatsappLoginTimeout: NodeJS.Timeout | null = null;

// Strip ANSI escape sequences from a string.
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1B\][^\x07]*\x07/g, '');
}

// Start the WhatsApp QR login process.
export function startWhatsAppLogin(
  project: string | undefined,
  broadcastFn: (type: string, data: unknown) => void,
): { success: boolean; error?: string } {
  // Kill any existing login process
  stopWhatsAppLogin();

  // ZeroClaw WhatsApp pairing: configure channel, delete session to force re-pair,
  try {
    // 1. Save WhatsApp channel config to sidecar (per-project daemons read from sidecar)
    const sessionPath = `${ZEROCLAW_DIR}/whatsapp-session.db`;
    const whatsappConfig = { session_path: sessionPath, allowed_numbers: ['*'] };
    saveZeroclawChannel('whatsapp', whatsappConfig, project);

    // 2. Delete existing WhatsApp session to force QR re-pair
    try { fs.unlinkSync(sessionPath); } catch {}
    try { fs.unlinkSync(sessionPath + '-wal'); } catch {}
    try { fs.unlinkSync(sessionPath + '-shm'); } catch {}

    // 3. Restart the project's per-project daemon via agent-bridge.
    if (project) {
      try {
        execFileSync('curl', [
          '-sf', '-X', 'POST',
          '-H', 'Content-Type: application/json',
          '-d', JSON.stringify({ project }),
          'http://127.0.0.1:7700/api/internal/daemon-restart',
        ], { timeout: 5000, stdio: 'pipe' });
      } catch {}
    }

    // 4. Stream per-project daemon log for QR output.
    // Project must match the sandbox-id contract before we splice it into a
    // path passed to fs.writeFileSync / spawn('tail', ...) — otherwise a
    // crafted name (e.g. "../../etc/passwd") becomes an exfil/truncation sink.
    const safeProject = project && isSandboxId(project) ? project : null;
    const logFile = safeProject
      ? `/var/log/ellul/zeroclaw-${safeProject}.log`
      : '/var/log/ellul/zeroclaw.log';
    if (!fs.existsSync(logFile)) {
      try { fs.writeFileSync(logFile, '', { mode: 0o644 }); } catch {}
    }
    const proc = spawn('tail', ['-f', '-n', '0', logFile], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    whatsappLoginProc = proc;

    // QR data pattern: Baileys emits strings like "2@ABcd..." before ASCII rendering
    const qrDataPattern = /^\d+@[\w+/=]+,[\w+/=]+,[\w+/=]+/;
    // ASCII QR art detection: lines with Unicode block characters
    const asciiQrPattern = /[▄▀█░▌▐▓▒]{3,}/;

    let asciiQrLines: string[] = [];
    let qrFlushTimer: NodeJS.Timeout | null = null;

    // Flush QR block with debounce — waits for output to stop for 500ms
    const flushQrBlock = () => {
      if (qrFlushTimer) { clearTimeout(qrFlushTimer); qrFlushTimer = null; }
      if (asciiQrLines.length >= 20) {
        broadcastFn('whatsapp_qr', { asciiQr: asciiQrLines.join('\n'), status: 'waiting' });
      }
      asciiQrLines = [];
    };

    const scheduleFlush = () => {
      if (qrFlushTimer) clearTimeout(qrFlushTimer);
      qrFlushTimer = setTimeout(flushQrBlock, 500);
    };

    // ZeroClaw-specific patterns:
    const connectedPattern = /WhatsApp Web connected successfully/;
    const qrPayloadPattern = /WhatsApp Web QR payload:\s*(.+)/;

    const handleStdout = (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString());
      const lines = text.split('\n');
      for (const line of lines) {
        const trimmed = line.replace(/\r/g, '').trimEnd();
        if (!trimmed) continue;

        // Detect successful connection
        if (connectedPattern.test(trimmed)) {
          broadcastFn('whatsapp_qr', { status: 'connected' });
          stopWhatsAppLogin();
          return;
        }

        // Check for raw QR data string (Baileys format)
        if (qrDataPattern.test(trimmed)) {
          asciiQrLines = [];
          broadcastFn('whatsapp_qr', { qr: trimmed, status: 'waiting' });
        }
        // Check for ZeroClaw's QR payload fallback
        else if (qrPayloadPattern.test(trimmed)) {
          const match = trimmed.match(qrPayloadPattern);
          if (match?.[1]) {
            broadcastFn('whatsapp_qr', { qr: match[1].trim(), status: 'waiting' });
          }
        }
        // Check for ASCII QR art (Unicode block characters)
        else if (asciiQrPattern.test(trimmed)) {
          asciiQrLines.push(trimmed);
          scheduleFlush();
        }
      }
    };

    proc.stdout?.on('data', handleStdout);
    // tail -f on log file captures both stdout and stderr (systemd redirects both)

    proc.on('close', (code) => {
      if (whatsappLoginTimeout) {
        clearTimeout(whatsappLoginTimeout);
        whatsappLoginTimeout = null;
      }
      if (qrFlushTimer) {
        clearTimeout(qrFlushTimer);
        qrFlushTimer = null;
      }
      whatsappLoginProc = null;

      // Flush any remaining QR lines
      if (asciiQrLines.length >= 20) {
        broadcastFn('whatsapp_qr', { asciiQr: asciiQrLines.join('\n'), status: 'waiting' });
      }

      if (code === 0) {
        broadcastFn('whatsapp_qr', { status: 'connected' });
      } else {
        broadcastFn('whatsapp_qr', { status: 'error', error: `Process exited with code ${code}` });
      }
    });

    proc.on('error', (err) => {
      whatsappLoginProc = null;
      if (whatsappLoginTimeout) {
        clearTimeout(whatsappLoginTimeout);
        whatsappLoginTimeout = null;
      }
      broadcastFn('whatsapp_qr', { status: 'error', error: err.message });
    });

    // 2 minute timeout
    whatsappLoginTimeout = setTimeout(() => {
      if (whatsappLoginProc) {
        whatsappLoginProc.kill();
        whatsappLoginProc = null;
        broadcastFn('whatsapp_qr', { status: 'error', error: 'Login timed out (2 minutes)' });
      }
      whatsappLoginTimeout = null;
    }, 120_000);

    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

// Stop the WhatsApp login process if running.
export function stopWhatsAppLogin(): void {
  if (whatsappLoginTimeout) {
    clearTimeout(whatsappLoginTimeout);
    whatsappLoginTimeout = null;
  }
  if (whatsappLoginProc) {
    whatsappLoginProc.kill();
    whatsappLoginProc = null;
  }
}

// Serve WhatsApp QR login as an SSE stream.
export function handleWhatsAppQrStream(
  res: import('http').ServerResponse,
  project: string | undefined,
): void {
  // Kill any existing login process
  stopWhatsAppLogin();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('status', { status: 'starting' });

  // Configure channel, delete session to force re-pair, restart daemon, stream log file
  try {
    const sessionPath = `${ZEROCLAW_DIR}/whatsapp-session.db`;
    const whatsappConfig = { session_path: sessionPath, allowed_numbers: ['*'] };
    saveZeroclawChannel('whatsapp', whatsappConfig, project);
    // Delete existing session to force QR re-pair
    try { fs.unlinkSync(sessionPath); } catch {}
    try { fs.unlinkSync(sessionPath + '-wal'); } catch {}
    try { fs.unlinkSync(sessionPath + '-shm'); } catch {}
    // Restart daemon via agent-bridge to pick up channel changes
    if (project) {
      try {
        execFileSync('curl', [
          '-sf', '-X', 'POST',
          '-H', 'Content-Type: application/json',
          '-d', JSON.stringify({ project }),
          'http://127.0.0.1:7700/api/internal/daemon-restart',
        ], { timeout: 5000, stdio: 'pipe' });
      } catch {}
    }
  } catch {}

  let proc: ChildProcess;
  try {
    // Stream per-project daemon log (agent-bridge tees output to per-project files)
    const logFile = project
      ? `/var/log/ellul/zeroclaw-${project}.log`
      : '/var/log/ellul/zeroclaw.log';
    if (!fs.existsSync(logFile)) {
      try { fs.writeFileSync(logFile, '', { mode: 0o644 }); } catch {}
    }
    proc = spawn('tail', ['-f', '-n', '0', logFile], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    send('status', { status: 'error', error: (err as Error).message });
    res.end();
    return;
  }

  whatsappLoginProc = proc;

  const qrDataPattern = /^\d+@[\w+/=]+,[\w+/=]+,[\w+/=]+/;
  const asciiQrPattern = /[▄▀█░▌▐▓▒]{3,}/;
  let asciiQrLines: string[] = [];
  let qrFlushTimer: NodeJS.Timeout | null = null;

  const flushQr = () => {
    if (qrFlushTimer) { clearTimeout(qrFlushTimer); qrFlushTimer = null; }
    if (asciiQrLines.length >= 20) {
      send('qr', { asciiQr: asciiQrLines.join('\n') });
    }
    asciiQrLines = [];
  };

  // ZeroClaw-specific patterns
  const connectedPattern = /WhatsApp Web connected successfully/;
  const qrPayloadPattern = /WhatsApp Web QR payload:\s*(.+)/;

  proc.stdout?.on('data', (chunk: Buffer) => {
    const text = stripAnsi(chunk.toString());
    for (const line of text.split('\n')) {
      const trimmed = line.replace(/\r/g, '').trimEnd();
      if (!trimmed) continue;

      // Detect successful connection
      if (connectedPattern.test(trimmed)) {
        send('status', { status: 'connected' });
        stopWhatsAppLogin();
        res.end();
        return;
      }

      if (qrDataPattern.test(trimmed)) {
        asciiQrLines = [];
        send('qr', { rawQr: trimmed });
      } else if (qrPayloadPattern.test(trimmed)) {
        const match = trimmed.match(qrPayloadPattern);
        if (match?.[1]) {
          send('qr', { rawQr: match[1].trim() });
        }
      } else if (asciiQrPattern.test(trimmed)) {
        asciiQrLines.push(trimmed);
        if (qrFlushTimer) clearTimeout(qrFlushTimer);
        qrFlushTimer = setTimeout(flushQr, 500);
      }
    }
  });

  proc.on('close', (code) => {
    if (qrFlushTimer) { clearTimeout(qrFlushTimer); qrFlushTimer = null; }
    if (whatsappLoginTimeout) { clearTimeout(whatsappLoginTimeout); whatsappLoginTimeout = null; }
    whatsappLoginProc = null;
    if (asciiQrLines.length >= 20) {
      send('qr', { asciiQr: asciiQrLines.join('\n') });
    }
    send('status', { status: code === 0 ? 'connected' : 'error', error: code !== 0 ? `Exit code ${code}` : undefined });
    res.end();
  });

  proc.on('error', (err) => {
    whatsappLoginProc = null;
    send('status', { status: 'error', error: err.message });
    res.end();
  });

  whatsappLoginTimeout = setTimeout(() => {
    if (whatsappLoginProc) {
      whatsappLoginProc.kill();
      whatsappLoginProc = null;
      send('status', { status: 'error', error: 'Login timed out (2 minutes)' });
      res.end();
    }
    whatsappLoginTimeout = null;
  }, 120_000);

  // If client disconnects, kill the process
  res.on('close', () => {
    stopWhatsAppLogin();
  });
}

// Returns self-contained HTML for WhatsApp QR pairing page.
export function getWhatsAppQrPageHtml(project: string | undefined): string {
  const qs = project ? `?project=${encodeURIComponent(project)}` : '';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#e0e0e0;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
.container{text-align:center;max-width:400px;width:100%}
.spinner{display:inline-block;width:32px;height:32px;border:3px solid #333;border-top-color:#f97316;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.status{margin-top:12px;font-size:14px;color:#888}
pre.qr{font-family:monospace;font-size:5.5px;line-height:6.5px;background:#fff;color:#000;padding:8px;border-radius:8px;display:inline-block;white-space:pre;user-select:all;margin:12px 0}
.connected{color:#22c55e;font-size:16px;font-weight:600}
.error{color:#ef4444;font-size:14px}
.retry-btn{margin-top:12px;padding:8px 20px;border-radius:6px;border:1px solid #333;background:#1a1a1a;color:#e0e0e0;cursor:pointer;font-size:13px}
.retry-btn:hover{background:#252525;border-color:#555}
</style></head><body>
<div class="container">
  <div id="content">
    <div class="spinner"></div>
    <p class="status">Connecting to WhatsApp...<br><span style="font-size:12px;color:#555">This can take up to 60 seconds</span></p>
  </div>
</div>
<script>
(function(){
  var el = document.getElementById('content');
  var es = new EventSource('/api/zeroclaw/channels/whatsapp/qr-stream${qs}');
  es.addEventListener('qr', function(e){
    var d = JSON.parse(e.data);
    if(d.asciiQr){
      el.innerHTML = '<p style="font-size:13px;color:#888;margin-bottom:8px">Scan with WhatsApp &rarr; Linked Devices</p><pre class="qr">' + d.asciiQr.replace(/</g,'&lt;') + '</pre><p style="font-size:11px;color:#555">QR refreshes automatically</p>';
    }
  });
  es.addEventListener('status', function(e){
    var d = JSON.parse(e.data);
    if(d.status==='connected'){
      el.innerHTML='<p class="connected">&#10003; WhatsApp Connected</p>';
      es.close();
      if(window.parent!==window){window.parent.postMessage({type:'whatsapp-connected'},'*');}
    } else if(d.status==='error'){
      el.innerHTML='<p class="error">' + (d.error||'Connection failed') + '</p><button class="retry-btn" onclick="location.reload()">Retry</button>';
      es.close();
    }
  });
  es.onerror = function(){
    el.innerHTML='<p class="error">Connection lost</p><button class="retry-btn" onclick="location.reload()">Retry</button>';
    es.close();
  };
})();
</script></body></html>`;
}

// ── BYOK LLM Key Management ──

const CLI_ENV_FILE = HOME + '/.ellul-cli-env';

// CLI env var names (different from ZeroClaw's for Google)
const CLI_PROVIDER_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

// Default model IDs per provider (used when no custom model is specified)
const BYOK_MODEL_IDS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  google: 'gemini-2.5-flash',
  openrouter: 'nvidia/nemotron-nano-9b-v2:free',
};

// ZeroClaw provider names (built-in support)
const BYOK_PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  openrouter: 'openrouter',
};

// ENV_VAR_MAP: provider → env var name ZeroClaw expects for built-in providers.
const BYOK_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  google: 'GOOGLE_API_KEY',
};

// Modify ZeroClaw's config.toml to switch the active provider and model.
function updateTomlProvider(provider: string, model: string): void {
  if (!fs.existsSync(TOML_CONFIG_FILE)) return;
  try {
    let toml = fs.readFileSync(TOML_CONFIG_FILE, 'utf8');
    // Replace default_provider line
    toml = toml.replace(
      /^default_provider\s*=\s*"[^"]*"/m,
      `default_provider = "${provider}"`,
    );
    // Replace default_model line
    toml = toml.replace(
      /^default_model\s*=\s*"[^"]*"/m,
      `default_model = "${model}"`,
    );
    fs.writeFileSync(TOML_CONFIG_FILE, toml);
  } catch (err) {
    console.warn(`[ZeroClaw] Failed to update config.toml provider: ${(err as Error).message}`);
  }
}

interface LlmKeyInfo {
  configured: boolean;
  source?: 'api-key' | 'cli-env';
}

export function getZeroclawLlmKeys(): { keys: Record<string, LlmKeyInfo>; hasKey: boolean; provider: string | null; modelId: string | null } {
  const keys: Record<string, LlmKeyInfo> = {};
  for (const id of Object.keys(BYOK_ENV_VARS)) {
    keys[id] = { configured: false };
  }

  let zcEnv: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const config = JSON.parse(raw);
    zcEnv = (config.env as Record<string, unknown>) ?? {};
  } catch {}

  let cliEnv: Record<string, string> = {};
  try {
    if (fs.existsSync(CLI_ENV_FILE)) {
      for (const line of fs.readFileSync(CLI_ENV_FILE, 'utf8').split('\n')) {
        const m = line.match(/^(?:export\s+)?(\w+)=["']?([^\n"']+)["']?$/);
        if (m?.[1] && m[2]) cliEnv[m[1]] = m[2];
      }
    }
  } catch {}

  let firstProvider: string | null = null;
  for (const [provider, varName] of Object.entries(BYOK_ENV_VARS)) {
    const cliVarName = CLI_PROVIDER_VARS[provider];
    if (zcEnv[varName]) {
      keys[provider] = { configured: true, source: 'api-key' };
      if (!firstProvider) firstProvider = provider;
    } else if (cliVarName && cliEnv[cliVarName]) {
      keys[provider] = { configured: true, source: 'cli-env' };
      if (!firstProvider) firstProvider = provider;
    }
  }

  let modelId: string | null = null;
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const config = JSON.parse(raw);
    const defaults = (config.agents as Record<string, unknown>)?.defaults as Record<string, unknown>;
    const model = defaults?.model as Record<string, unknown> | undefined;
    modelId = (model?.primary as string) || null;
  } catch {}

  return { keys, hasKey: !!firstProvider, provider: firstProvider, modelId };
}

// Backward-compatible wrapper
export function getZeroclawLlmKey(): { hasKey: boolean; provider: string | null; modelId: string | null } {
  const { hasKey, provider, modelId } = getZeroclawLlmKeys();
  return { hasKey, provider, modelId };
}

// Save a BYOK LLM key for the given provider.
export function saveZeroclawLlmKey(
  provider: string,
  apiKey: string,
  modelId?: string,
): { success: boolean; error?: string } {
  const validProviders = Object.keys(BYOK_MODEL_IDS);
  if (!validProviders.includes(provider)) {
    return { success: false, error: `Invalid provider. Must be one of: ${validProviders.join(', ')}` };
  }

  let config: Record<string, unknown> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {}
  }

  if (!config.agents || typeof config.agents !== 'object') config.agents = {};
  const agents = config.agents as Record<string, unknown>;
  if (!agents.defaults || typeof agents.defaults !== 'object') agents.defaults = {};
  const defaults = agents.defaults as Record<string, unknown>;
  if (!config.env || typeof config.env !== 'object') config.env = {};
  const env = config.env as Record<string, unknown>;

  env[BYOK_ENV_VARS[provider]!] = apiKey;

  let resolvedModelId = BYOK_MODEL_IDS[provider]!;
  if (provider === 'openrouter' && modelId?.trim()) {
    const cleaned = modelId.trim();
    resolvedModelId = cleaned.startsWith('openrouter/') ? cleaned : `openrouter/${cleaned}`;
  }

  defaults.model = {
    primary: resolvedModelId,
    fallbacks: ['ellul/default'],
  };

  fs.mkdirSync(ZEROCLAW_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  syncByokEnvFile(env as Record<string, string>);

  const zcProvider = BYOK_PROVIDER_NAMES[provider] || 'compatible';
  updateTomlProvider(zcProvider, resolvedModelId);

  syncCliEnvKey(provider, apiKey);

  return { success: true };
}

// Sync BYOK env vars to ~/.zeroclaw/.env for ZeroClaw daemon consumption.
function syncByokEnvFile(env: Record<string, unknown>): void {
  const envFile = `${ZEROCLAW_DIR}/.env`;
  const lines: string[] = [];

  // Preserve non-BYOK lines from existing .env
  if (fs.existsSync(envFile)) {
    const existing = fs.readFileSync(envFile, 'utf8');
    const byokVarSet = new Set(Object.values(BYOK_ENV_VARS));
    for (const line of existing.split('\n')) {
      const varName = line.split('=')[0]?.trim();
      if (varName && !byokVarSet.has(varName)) {
        lines.push(line);
      }
    }
  }

  // Add current BYOK vars
  for (const [, varName] of Object.entries(BYOK_ENV_VARS)) {
    const val = env[varName];
    if (val && typeof val === 'string') {
      lines.push(`${varName}=${val}`);
    }
  }

  fs.writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });
}

function syncCliEnvKey(provider: string, apiKey: string): void {
  const varName = CLI_PROVIDER_VARS[provider];
  if (!varName) return;
  try {
    let lines: string[] = [];
    if (fs.existsSync(CLI_ENV_FILE)) {
      lines = fs.readFileSync(CLI_ENV_FILE, 'utf8').split('\n');
    }
    const exportLine = `export ${varName}='${apiKey.replace(/'/g, "'\\''")}'`;
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if ((lines[i] as string).match(new RegExp(`^export\\s+${varName}=`))) {
        lines[i] = exportLine;
        found = true;
        break;
      }
    }
    if (!found) lines.push(exportLine);
    while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === '') lines.pop();
    fs.writeFileSync(CLI_ENV_FILE, lines.join('\n') + '\n', { mode: 0o600 });
  } catch {}
}

function removeCliEnvKey(provider: string): void {
  const varName = CLI_PROVIDER_VARS[provider];
  if (!varName) return;
  try {
    if (!fs.existsSync(CLI_ENV_FILE)) return;
    let lines = fs.readFileSync(CLI_ENV_FILE, 'utf8').split('\n');
    lines = lines.filter((l) => !l.match(new RegExp(`^export\\s+${varName}=`)));
    while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === '') lines.pop();
    fs.writeFileSync(CLI_ENV_FILE, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
  } catch {}
}

// Remove a specific provider's key (or all if no provider specified).
export function removeZeroclawLlmKey(provider?: string): { success: boolean } {
  let config: Record<string, unknown> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
  }

  if (config.env && typeof config.env === 'object') {
    const env = config.env as Record<string, unknown>;
    if (provider && BYOK_ENV_VARS[provider]) {
      delete env[BYOK_ENV_VARS[provider]];
    } else {
      for (const varName of Object.values(BYOK_ENV_VARS)) delete env[varName];
    }
    if (Object.keys(env).length === 0) delete config.env;
  }

  const remainingEnv = (config.env ?? {}) as Record<string, unknown>;
  const hasAnyKey = Object.values(BYOK_ENV_VARS).some((v) => !!remainingEnv[v]);

  if (!hasAnyKey) {
    if (!config.agents || typeof config.agents !== 'object') config.agents = {};
    const agents = config.agents as Record<string, unknown>;
    if (!agents.defaults || typeof agents.defaults !== 'object') agents.defaults = {};
    (agents.defaults as Record<string, unknown>).model = { primary: 'ellul/default' };
    const platformProvider = getPlatformAiProxyUrl();
    updateTomlProvider(platformProvider || 'compatible', 'default');
  }

  syncByokEnvFile(remainingEnv as Record<string, string>);

  if (provider) {
    removeCliEnvKey(provider);
  } else {
    for (const id of Object.keys(CLI_PROVIDER_VARS)) removeCliEnvKey(id);
  }

  fs.mkdirSync(ZEROCLAW_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  return { success: true };
}

// Save a channel for a specific project.
function saveProjectChannel(
  channel: string,
  channelConfig: Record<string, unknown>,
  project: string,
): { success: boolean; error?: string } {
  // WhatsApp uses QR pairing — no token needed
  const isWhatsApp = channel === 'whatsapp';

  // Determine the token value from the config
  const tokenKey = channel === 'slack' ? 'botToken' : (channel === 'telegram' ? 'botToken' : 'token');
  const token = channelConfig[tokenKey] as string | undefined;

  if (!isWhatsApp && !token) {
    return { success: false, error: `Missing token field (${tokenKey})` };
  }

  try {
    // 1. Write channel account config directly to config.toml
    let config: Record<string, unknown> = {};
    if (fs.existsSync(CONFIG_FILE)) {
      try {
        config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      } catch { /* start fresh */ }
    }

    if (!config.channels || typeof config.channels !== 'object') config.channels = {};
    const channels = config.channels as Record<string, unknown>;
    if (!channels[channel] || typeof channels[channel] !== 'object') channels[channel] = {};
    const ch = channels[channel] as Record<string, unknown>;
    if (!ch.accounts || typeof ch.accounts !== 'object') ch.accounts = {};
    const accounts = ch.accounts as Record<string, unknown>;

    // Build the account config
    const acct: Record<string, unknown> = {
      dmPolicy: 'open',
      allowFrom: ['*'],
    };

    if (token) {
      acct[tokenKey] = token;
    }

    // For Slack, also save appToken if provided
    if (channel === 'slack' && channelConfig.appToken) {
      acct.appToken = channelConfig.appToken;
    }

    accounts[project] = acct;

    // 2. Add routing binding so this channel account routes to the project agent
    const agentId = `dev-${project}`;
    if (!Array.isArray(config.bindings)) config.bindings = [];
    const bindings = config.bindings as Array<{ agentId: string; match: { channel: string; accountId: string } }>;
    const existingIdx = bindings.findIndex(
      (b) => b.match?.channel === channel && b.match?.accountId === project,
    );
    const binding = { agentId, match: { channel, accountId: project } };
    if (existingIdx >= 0) {
      bindings[existingIdx] = binding;
    } else {
      bindings.push(binding);
    }

    fs.mkdirSync(ZEROCLAW_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));

    // Per-project daemons regenerate config from sidecar on each spawn

    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}
