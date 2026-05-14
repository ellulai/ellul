// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Config Validator — Strict schema validation for daemon configuration
 *
 * Validates config.json files against a known schema. Rejects unknown fields.
 * Fails startup on invalid config with clear error messages.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ExecMode } from '../gates/capability-allowlist';

// ── Schema ──

export interface DaemonConfig {
  version?: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  execMode?: ExecMode;
}

const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const VALID_EXEC_MODES = new Set(['capability', 'unrestricted']);
const KNOWN_FIELDS = new Set(['version', 'logLevel', 'execMode']);

export interface ConfigValidationResult {
  valid: boolean;
  config: DaemonConfig;
  errors: string[];
  warnings: string[];
}

/**
 * Load and validate a config file. Returns structured result.
 * Missing file is NOT an error — returns defaults.
 */
export function loadConfig(configPath: string): ConfigValidationResult {
  const result: ConfigValidationResult = {
    valid: true,
    config: {},
    errors: [],
    warnings: [],
  };

  if (!fs.existsSync(configPath)) {
    return result; // Missing config = defaults, not an error
  }

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    result.valid = false;
    result.errors.push(`Cannot read ${configPath}: ${(err as Error).message}`);
    return result;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    result.valid = false;
    result.errors.push(`${configPath} is not valid JSON`);
    return result;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    result.valid = false;
    result.errors.push(`${configPath} must be a JSON object`);
    return result;
  }

  // Reject unknown fields
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_FIELDS.has(key)) {
      result.valid = false;
      result.errors.push(`Unknown config field "${key}" in ${configPath}. Known fields: ${[...KNOWN_FIELDS].join(', ')}`);
    }
  }

  // Validate version
  if (parsed.version !== undefined) {
    if (typeof parsed.version !== 'string') {
      result.valid = false;
      result.errors.push(`"version" must be a string`);
    } else {
      result.config.version = parsed.version;
    }
  }

  // Validate logLevel
  if (parsed.logLevel !== undefined) {
    if (typeof parsed.logLevel !== 'string' || !VALID_LOG_LEVELS.has(parsed.logLevel)) {
      result.valid = false;
      result.errors.push(`"logLevel" must be one of: ${[...VALID_LOG_LEVELS].join(', ')}`);
    } else {
      result.config.logLevel = parsed.logLevel as DaemonConfig['logLevel'];
    }
  }

  // Validate execMode
  if (parsed.execMode !== undefined) {
    if (typeof parsed.execMode !== 'string' || !VALID_EXEC_MODES.has(parsed.execMode)) {
      result.valid = false;
      result.errors.push(`"execMode" must be one of: ${[...VALID_EXEC_MODES].join(', ')}`);
    } else {
      result.config.execMode = parsed.execMode as ExecMode;
    }
  }

  return result;
}

/**
 * Load merged config from global + per-project config files.
 * Per-project overrides global. Both are validated.
 * Returns null if either config has errors (fails startup).
 */
export function loadMergedConfig(
  globalConfigDir: string,
  projectDir?: string,
): { config: DaemonConfig; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let merged: DaemonConfig = {};

  // Global config
  const globalPath = path.join(globalConfigDir, 'config.json');
  const globalResult = loadConfig(globalPath);
  if (!globalResult.valid) {
    errors.push(...globalResult.errors);
  } else {
    merged = { ...merged, ...globalResult.config };
    warnings.push(...globalResult.warnings);
  }

  // Per-project config (overrides global)
  if (projectDir) {
    const projectPath = path.join(projectDir, '.ellul', 'config.json');
    const projectResult = loadConfig(projectPath);
    if (!projectResult.valid) {
      errors.push(...projectResult.errors);
    } else {
      merged = { ...merged, ...projectResult.config };
      warnings.push(...projectResult.warnings);
    }
  }

  return { config: merged, errors, warnings };
}
