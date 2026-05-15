// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// VPS-local feature toggle endpoints for gbrain and gstack.
// State lives at /etc/ellul/features.json — no central DB round-trip.
// Console reads/writes via bridge internal HTTP; enforcer restores
// state at boot from the same file.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import type { IncomingMessage, ServerResponse } from 'http';

import { gateLocalhostOnly, readJsonBody } from './acl';
import { mcpProviderRegistry, GBRAIN_CONNECTION_ID } from '../application/mcp-providers';
import { mcpGateway } from '../application/mcp-tool/governance/McpGateway';
import { getClaudeOatBridgeModule } from '../credentials/claude-oat/public';
import { getPlatformAiProxyUrl } from '../adapters/zeroclaw/runtime';

function triggerProviderRefresh(): void {
  fetch('http://127.0.0.1:7700/api/internal/providers/refresh', { method: 'POST' }).catch(() => {});
}

const FEATURES_PATH = '/etc/ellul/agent-bridge/features.json';
const GBRAIN_ENV_PATH = '/etc/ellul/gbrain/env';
const CLI_ENV_FILE = os.homedir() + '/.ellul-cli-env';
const GSTACK_DIR = '/opt/ellul/gstack';
const GBRAIN_DIR = '/opt/ellul/gbrain';
const SVC_HOME = os.homedir();
const ZEROCLAW_DIR = SVC_HOME + '/.zeroclaw';
const ZEROCLAW_CONFIG = ZEROCLAW_DIR + '/ellul.json';
const ZEROCLAW_TOML = ZEROCLAW_DIR + '/config.toml';

const VALID_FEATURES = new Set(['gbrain', 'gstack']);
const PLAN_FILE = '/etc/ellul/plan';
const GBRAIN_ELIGIBLE_PLANS = new Set(['pro']);

const VALID_PROVIDERS = ['anthropic', 'openai', 'google', 'openrouter', 'xai'] as const;
type ProviderId = typeof VALID_PROVIDERS[number];

const PROVIDER_ENV_KEYS: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'GROK_CODE_XAI_API_KEY',
};

const ZEROCLAW_ENV_KEYS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
};

interface FeaturesState {
  gbrain: { enabled: boolean; provider?: string };
  gstack: { enabled: boolean };
  zeroclaw?: { provider?: string };
}

function readFeatures(): FeaturesState {
  const defaults: FeaturesState = {
    gbrain: { enabled: false },
    gstack: { enabled: false },
  };
  try {
    const raw = fs.readFileSync(FEATURES_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<FeaturesState>;
    return {
      gbrain: { enabled: parsed.gbrain?.enabled ?? false, provider: parsed.gbrain?.provider },
      gstack: { enabled: parsed.gstack?.enabled ?? false },
      zeroclaw: parsed.zeroclaw,
    };
  } catch {
    return defaults;
  }
}

function writeFeatures(state: FeaturesState): void {
  const data = JSON.stringify(state, null, 2) + '\n';
  fs.writeFileSync(FEATURES_PATH, data, { mode: 0o644 });
}

function readEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    if (!fs.existsSync(path)) return env;
    for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^(?:export\s+)?(\w+)=["']?([^\n"']+)["']?$/);
      if (m?.[1] && m[2]) env[m[1]] = m[2];
    }
  } catch {}
  return env;
}

function getConnectedProviders(): Record<ProviderId, { connected: boolean }> {
  const cliEnv = readEnvFile(CLI_ENV_FILE);

  let zcEnv: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(ZEROCLAW_CONFIG, 'utf8');
    zcEnv = (JSON.parse(raw) as { env?: Record<string, unknown> }).env ?? {};
  } catch {}

  const result = {} as Record<ProviderId, { connected: boolean }>;
  for (const id of VALID_PROVIDERS) {
    const cliKey = PROVIDER_ENV_KEYS[id];
    const zcKey = ZEROCLAW_ENV_KEYS[id];
    result[id] = {
      connected: !!(cliEnv[cliKey] || (zcKey && zcEnv[zcKey])),
    };
  }
  return result;
}

interface ConnectorInfo {
  connected: boolean;
  hasApiKey: boolean;
  hasSignIn: boolean;
}

function getConnectorStatus(): Record<string, ConnectorInfo> {
  const cliEnv = readEnvFile(CLI_ENV_FILE);
  const home = os.homedir();

  let claudeSignedIn = false;
  try {
    claudeSignedIn = getClaudeOatBridgeModule().authStateCache.isAuthed();
  } catch {}

  const codexSignedIn = fs.existsSync(path.join(home, '.codex', 'auth.json'));
  const cursorSignedIn = fs.existsSync(path.join(home, '.config', 'cursor', 'auth.json'));
  const grokSignedIn = fs.existsSync(path.join(home, '.grok', 'auth.json'));

  return {
    claude: {
      connected: !!(cliEnv['ANTHROPIC_API_KEY'] || claudeSignedIn),
      hasApiKey: !!cliEnv['ANTHROPIC_API_KEY'],
      hasSignIn: claudeSignedIn,
    },
    codex: {
      connected: !!(cliEnv['OPENAI_API_KEY'] || codexSignedIn),
      hasApiKey: !!cliEnv['OPENAI_API_KEY'],
      hasSignIn: codexSignedIn,
    },
    cursor: {
      connected: cursorSignedIn,
      hasApiKey: false,
      hasSignIn: cursorSignedIn,
    },
    grok: {
      connected: !!(cliEnv['GROK_CODE_XAI_API_KEY'] || grokSignedIn),
      hasApiKey: !!cliEnv['GROK_CODE_XAI_API_KEY'],
      hasSignIn: grokSignedIn,
    },
  };
}

const API_KEY_RE = /^[A-Za-z0-9_\-+/=.]+$/;
const API_KEY_MAX_LEN = 512;

function shellSingleQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function saveConnectorKey(provider: ProviderId, apiKey: string): void {
  const cliVar = PROVIDER_ENV_KEYS[provider];
  if (cliVar) {
    let lines: string[] = [];
    try {
      if (fs.existsSync(CLI_ENV_FILE)) {
        lines = fs.readFileSync(CLI_ENV_FILE, 'utf8').split('\n');
      }
    } catch {}
    const exportLine = `export ${cliVar}=${shellSingleQuote(apiKey)}`;
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.match(new RegExp(`^export\\s+${cliVar}=`))) {
        lines[i] = exportLine;
        found = true;
        break;
      }
    }
    if (!found) lines.push(exportLine);
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    fs.writeFileSync(CLI_ENV_FILE, lines.join('\n') + '\n', { mode: 0o600 });
  }

  const zcVar = ZEROCLAW_ENV_KEYS[provider];
  if (zcVar) {
    try {
      let config: Record<string, unknown> = {};
      if (fs.existsSync(ZEROCLAW_CONFIG)) {
        config = JSON.parse(fs.readFileSync(ZEROCLAW_CONFIG, 'utf8'));
      }
      if (!config.env || typeof config.env !== 'object') config.env = {};
      (config.env as Record<string, string>)[zcVar] = apiKey;
      fs.mkdirSync(ZEROCLAW_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(ZEROCLAW_CONFIG, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    } catch {}
  }
}

function removeConnectorKey(provider: ProviderId): void {
  const cliVar = PROVIDER_ENV_KEYS[provider];
  if (cliVar) {
    try {
      if (fs.existsSync(CLI_ENV_FILE)) {
        let lines = fs.readFileSync(CLI_ENV_FILE, 'utf8').split('\n');
        lines = lines.filter(l => !l.match(new RegExp(`^export\\s+${cliVar}=`)));
        while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
        fs.writeFileSync(CLI_ENV_FILE, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
      }
    } catch {}
  }

  const zcVar = ZEROCLAW_ENV_KEYS[provider];
  if (zcVar) {
    try {
      if (fs.existsSync(ZEROCLAW_CONFIG)) {
        const config = JSON.parse(fs.readFileSync(ZEROCLAW_CONFIG, 'utf8'));
        if (config.env && typeof config.env === 'object') {
          delete (config.env as Record<string, string>)[zcVar];
          fs.writeFileSync(ZEROCLAW_CONFIG, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
        }
      }
    } catch {}
  }
}

function getServerPlan(): string {
  try {
    return fs.readFileSync(PLAN_FILE, 'utf8').trim();
  } catch {
    return 'free';
  }
}

function getTotalRamMb(): number {
  try {
    const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
    const match = meminfo.match(/MemTotal:\s+(\d+)/);
    return match ? Math.floor(parseInt(match[1]!, 10) / 1024) : 0;
  } catch {
    return 0;
  }
}

function isPreInstalled(feature: string): boolean {
  if (feature === 'gbrain') return fs.existsSync(GBRAIN_DIR + '/src/cli.ts');
  if (feature === 'gstack') return fs.existsSync(GSTACK_DIR + '/setup');
  return false;
}

function runQuiet(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: 'pipe', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

const GBRAIN_PROVIDER_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'VOYAGE_API_KEY',
] as const;

function syncGbrainProviderKeys(pinnedProvider?: string): void {
  try {
    if (!fs.existsSync(CLI_ENV_FILE) || !fs.existsSync(GBRAIN_ENV_PATH)) return;
    const cliEnv = fs.readFileSync(CLI_ENV_FILE, 'utf8');
    let gbrainEnv = fs.readFileSync(GBRAIN_ENV_PATH, 'utf8');

    const pinnedEnvKey = pinnedProvider
      ? PROVIDER_ENV_KEYS[pinnedProvider as ProviderId]
      : undefined;

    for (const key of GBRAIN_PROVIDER_KEYS) {
      const match = cliEnv.match(new RegExp(`^(?:export\\s+)?${key}=["']?([^\\n"']+)["']?$`, 'm'));

      if (pinnedEnvKey && key !== pinnedEnvKey) {
        gbrainEnv = gbrainEnv.replace(new RegExp(`^${key}=.*\n?`, 'm'), '');
        continue;
      }

      if (!match?.[1]) continue;

      if (gbrainEnv.includes(`${key}=`)) {
        gbrainEnv = gbrainEnv.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${match[1]}`);
      } else {
        gbrainEnv += `${key}=${match[1]}\n`;
      }
    }

    fs.writeFileSync(GBRAIN_ENV_PATH, gbrainEnv);
  } catch { /* best-effort */ }
}

function enableGbrain(): string | null {
  if (!isPreInstalled('gbrain')) return 'gbrain is not pre-installed on this VPS';
  if (!GBRAIN_ELIGIBLE_PLANS.has(getServerPlan())) return 'gbrain requires a Pro plan';
  if (!runQuiet('sudo /usr/local/bin/ellul-gbrain-init')) {
    return 'gbrain initialization failed (database/credentials setup)';
  }
  const state = readFeatures();
  const pinned = state.gbrain.provider;
  syncGbrainProviderKeys(pinned && pinned !== 'auto' ? pinned : undefined);
  if (!runQuiet('sudo systemctl enable --now ellul-gbrain.service')) {
    return 'failed to start ellul-gbrain service';
  }
  return null;
}

function disableGbrain(): string | null {
  runQuiet('sudo systemctl disable --now ellul-gbrain.service');
  return null;
}

function enableGstack(): string | null {
  if (!isPreInstalled('gstack')) return 'gstack is not pre-installed on this VPS';
  const setupBin = GSTACK_DIR + '/setup';
  if (!runQuiet(`${setupBin} --host auto --no-prefix`)) {
    return 'gstack setup failed';
  }
  return null;
}

function disableGstack(): string | null {
  const skillDirs = [
    SVC_HOME + '/.claude/skills/gstack',
    SVC_HOME + '/.codex/skills/gstack',
  ];
  for (const dir of skillDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* skip */ }
  }
  return null;
}

function wipeGbrain(): string | null {
  if (!isPreInstalled('gbrain')) return 'gbrain is not pre-installed on this VPS';

  runQuiet('sudo systemctl stop ellul-gbrain.service');

  if (!runQuiet('sudo /usr/local/bin/ellul-gbrain-init --wipe')) {
    runQuiet('sudo systemctl start ellul-gbrain.service');
    return 'failed to wipe and recreate gbrain database';
  }

  const state = readFeatures();
  if (state.gbrain.enabled) {
    if (!runQuiet('sudo systemctl start ellul-gbrain.service')) {
      return 'database wiped but gbrain failed to restart';
    }
  }

  return null;
}

// GET /api/internal/features
export async function handleFeaturesGet(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gateLocalhostOnly(req, res)) return;

  const state = readFeatures();
  const plan = getServerPlan();

  let gbrainServiceActive = false;
  try {
    execSync('systemctl is-active --quiet ellul-gbrain.service', { stdio: 'pipe', timeout: 5_000 });
    gbrainServiceActive = true;
  } catch { /* not active */ }

  const gbrainMcpStatus = mcpGateway.getConnectionStatus(GBRAIN_CONNECTION_ID);
  const gbrainApprovedTools = mcpGateway.getApprovedTools(GBRAIN_CONNECTION_ID);

  const result = {
    gbrain: {
      enabled: state.gbrain.enabled,
      available: GBRAIN_ELIGIBLE_PLANS.has(plan) && isPreInstalled('gbrain'),
      ramMb: getTotalRamMb(),
      provider: state.gbrain.provider ?? 'auto',
      serviceActive: gbrainServiceActive,
      mcpStatus: gbrainMcpStatus,
      mcpToolCount: gbrainApprovedTools.length,
    },
    gstack: {
      enabled: state.gstack.enabled,
      available: isPreInstalled('gstack'),
    },
    zeroclaw: {
      provider: state.zeroclaw?.provider ?? 'auto',
    },
    providers: getConnectedProviders(),
    connectors: getConnectorStatus(),
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
}

// POST /api/internal/features/toggle
export async function handleFeaturesToggle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gateLocalhostOnly(req, res)) return;

  const body = await readJsonBody<{ feature?: string; enabled?: boolean }>(req, res);
  if (!body) return;

  const { feature, enabled } = body;
  if (!feature || !VALID_FEATURES.has(feature) || typeof enabled !== 'boolean') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'Invalid feature or enabled flag' }));
    return;
  }

  const state = readFeatures();
  let error: string | null = null;

  if (feature === 'gbrain') {
    error = enabled ? enableGbrain() : disableGbrain();
    if (!error) state.gbrain.enabled = enabled;
  } else if (feature === 'gstack') {
    error = enabled ? enableGstack() : disableGstack();
    if (!error) state.gstack.enabled = enabled;
  }

  if (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: error }));
    return;
  }

  writeFeatures(state);

  if (feature === 'gbrain') {
    const gbrain = mcpProviderRegistry.get(GBRAIN_CONNECTION_ID);
    if (gbrain) {
      if (enabled) {
        gbrain.connect().catch(() => {});
      } else {
        gbrain.disconnect();
      }
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, state: state[feature as keyof FeaturesState] }));
}

// POST /api/internal/features/tool-provider
export async function handleToolProviderSet(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gateLocalhostOnly(req, res)) return;

  const body = await readJsonBody<{ tool?: string; provider?: string }>(req, res);
  if (!body) return;

  const { tool, provider } = body;
  if (!tool || !provider) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'Missing tool or provider' }));
    return;
  }

  if (provider !== 'auto' && !(VALID_PROVIDERS as readonly string[]).includes(provider)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'Invalid provider' }));
    return;
  }

  const state = readFeatures();

  if (tool === 'gbrain') {
    state.gbrain.provider = provider;
    if (state.gbrain.enabled) {
      syncGbrainProviderKeys(provider === 'auto' ? undefined : provider);
      runQuiet('sudo systemctl restart ellul-gbrain.service');
    }
  } else if (tool === 'zeroclaw') {
    if (!state.zeroclaw) state.zeroclaw = {};
    state.zeroclaw.provider = provider;
    applyZeroclawProvider(provider);
  } else {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'Unknown tool' }));
    return;
  }

  writeFeatures(state);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

function applyZeroclawProvider(provider: string): void {
  if (!fs.existsSync(ZEROCLAW_TOML)) return;
  try {
    let toml = fs.readFileSync(ZEROCLAW_TOML, 'utf8');
    let zcProvider: string;
    let model: string | undefined;

    if (provider === 'auto') {
      zcProvider = getPlatformAiProxyUrl() || 'compatible';
      model = 'default';
    } else {
      zcProvider = provider === 'openrouter' ? 'openrouter' : provider;
    }

    toml = toml.replace(
      /^default_provider\s*=\s*"[^"]*"/m,
      `default_provider = "${zcProvider}"`,
    );
    if (model) {
      toml = toml.replace(
        /^default_model\s*=\s*"[^"]*"/m,
        `default_model = "${model}"`,
      );
    }
    fs.writeFileSync(ZEROCLAW_TOML, toml);
  } catch {}
}

// POST /api/internal/features/gbrain-wipe
export async function handleGbrainWipe(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gateLocalhostOnly(req, res)) return;

  const error = wipeGbrain();
  if (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: error }));
    return;
  }

  const gbrain = mcpProviderRegistry.get(GBRAIN_CONNECTION_ID);
  if (gbrain) gbrain.connect().catch(() => {});

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// POST /api/internal/features/connector-key — save API key (dual-write)
export async function handleConnectorSaveKey(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gateLocalhostOnly(req, res)) return;

  const body = await readJsonBody<{ provider?: string; apiKey?: string }>(req, res);
  if (!body) return;

  const { provider, apiKey } = body;
  if (!provider || !apiKey || !(VALID_PROVIDERS as readonly string[]).includes(provider)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'Invalid provider or missing apiKey' }));
    return;
  }
  if (typeof apiKey !== 'string' || apiKey.length > API_KEY_MAX_LEN || !API_KEY_RE.test(apiKey)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'Invalid API key format' }));
    return;
  }

  saveConnectorKey(provider as ProviderId, apiKey);
  triggerProviderRefresh();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

// POST /api/internal/features/connector-key-remove — remove API key
export async function handleConnectorRemoveKey(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!gateLocalhostOnly(req, res)) return;

  const body = await readJsonBody<{ provider?: string }>(req, res);
  if (!body) return;

  const { provider } = body;
  if (!provider || !(VALID_PROVIDERS as readonly string[]).includes(provider)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'Invalid provider' }));
    return;
  }

  removeConnectorKey(provider as ProviderId);
  triggerProviderRefresh();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}
