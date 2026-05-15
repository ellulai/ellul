import * as fs from 'fs';
import * as path from 'path';

const CONFIG_DIR = path.join(process.env.HOME || '~', '.ellul');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

export interface ByosVmConfig {
  platform: string;
  cpus: number;
  memory: string;
  disk: string;
}

export interface ByosAuthConfig {
  token: string;
  email: string;
  expiresAt: string;
}

export interface ByosTunnelConfig {
  subdomain: string;
  autoExpose: boolean;
}

export interface ByosAiConfig {
  anthropic_key?: string;
  openai_key?: string;
}

export interface ByosUpdateConfig {
  channel: string;
  autoUpdate: boolean;
}

export interface ByosConfig {
  vm?: ByosVmConfig;
  auth?: ByosAuthConfig;
  tunnel?: ByosTunnelConfig;
  ai?: ByosAiConfig;
  update?: ByosUpdateConfig;
}

export function readConfig(): ByosConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(config: ByosConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export function getConfigValue(key: string): string | undefined {
  const config = readConfig();
  const parts = key.split('.');
  let obj: Record<string, unknown> = config as Record<string, unknown>;
  for (const part of parts) {
    if (obj == null || typeof obj !== 'object') return undefined;
    obj = obj[part] as Record<string, unknown>;
  }
  return obj != null ? String(obj) : undefined;
}

export function setConfigValue(key: string, value: string): void {
  const config = readConfig() as Record<string, unknown>;
  const parts = key.split('.');
  let obj = config;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (obj[part] == null || typeof obj[part] !== 'object') {
      obj[part] = {};
    }
    obj = obj[part] as Record<string, unknown>;
  }
  obj[parts[parts.length - 1]!] = value;
  writeConfig(config as ByosConfig);
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}

export function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

export interface MigrationFileEntry {
  name: string;
  iv: string;
  authTag: string;
  sha256: string;
  size: number;
}

export interface MigrationState {
  migrationId: string;
  direction: 'to_cloud' | 'to_local';
  phase: number;
  startedAt: string;
  lastPhaseAt: string;
  serverId?: string;
  domain?: string;
  mlkemCt?: string;
  r2Prefix?: string;
  encryptedFiles?: MigrationFileEntry[];
}

const MIGRATION_STATE_PATH = path.join(CONFIG_DIR, 'migration-state.json');

export function readMigrationState(): MigrationState | null {
  try {
    return JSON.parse(fs.readFileSync(MIGRATION_STATE_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export function writeMigrationState(state: MigrationState): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(MIGRATION_STATE_PATH, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function clearMigrationState(): void {
  try { fs.unlinkSync(MIGRATION_STATE_PATH); } catch {}
}
