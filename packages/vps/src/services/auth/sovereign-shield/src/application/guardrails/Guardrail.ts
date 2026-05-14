// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Guardrail Scan Service — Empty Vessel Model
 *
 * Invokes the guardrail binary (Go + tree-sitter) to perform deterministic
 * AST analysis of workspace source code before execution.
 *
 * The binary is an Empty Vessel — it contains ZERO hardcoded policy. All rules
 * come from the sync cache (central DB) and user-local .scm files. Engine
 * analyzers (geometric computations like depth limits) are activated via a
 * synced JSON config.
 *
 * Rule loading order (passed as multiple --rules flags):
 *   1. Synced global rules   → /var/lib/ellul-shielded/guardrail-rules/global/
 *   2. Synced workspace rules → /var/lib/ellul-shielded/guardrail-rules/workspace/
 *   3. Workspace policies     → <workspace>/.ellul/policies/ (read-only mirror)
 *
 * Engine analyzers config:
 *   --analyzers /var/lib/ellul-shielded/guardrail-rules/analyzers.json
 *
 * Fail-closed: ANY error (timeout, crash, bad JSON, missing binary, no rules
 * loaded) returns blocked=true. Safe by Silence.
 */

import { spawnSync } from 'child_process';

const GUARDRAIL_BIN = '/usr/local/bin/guardrail';
const GUARDRAIL_TIMEOUT = 10_000; // 10s — generous; typical scan <10ms

/** Sync cache directory — written by guardrail-sync.service.ts, read-only to agent. */
const SYNC_CACHE_DIR = '/var/lib/ellul-shielded/guardrail-rules';

export interface GuardrailFinding {
  rule: string;
  message: string;
  file: string;
  line: number;
  column: number;
  severity: number;
}

export interface GuardrailResult {
  blocked: boolean;
  findings: GuardrailFinding[];
  files_scanned: number;
  error?: string;
}

/**
 * Scan a workspace directory for guardrail violations.
 *
 * Invokes the guardrail binary with three rule sources and an analyzer config.
 * If the sync cache is empty (no global rules synced yet), the binary returns
 * NO_POLICIES_LOADED and this function returns blocked=true.
 *
 * Exit 0 = clean. Exit 1 = blocked. Exit 2 = usage error. Any other = fail-closed.
 */
export function scanWorkspace(workspaceDir: string): GuardrailResult {
  try {
    const args = [
      'scan',
      '--dir', workspaceDir,
      // Rule loading order: global synced → workspace synced → user-local
      '--rules', `${SYNC_CACHE_DIR}/global`,
      '--rules', `${SYNC_CACHE_DIR}/workspace`,
      '--rules', `${workspaceDir}/.ellul/policies`,
      // Engine analyzers (depth limits, etc.) — activated via synced JSON config
      '--analyzers', `${SYNC_CACHE_DIR}/analyzers.json`,
    ];

    const result = spawnSync(GUARDRAIL_BIN, args, {
      encoding: 'utf8',
      timeout: GUARDRAIL_TIMEOUT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Fail-closed: spawn error (missing binary, ENOENT, timeout, etc.)
    // When the process is killed by timeout, spawnSync sets error.code = 'ETIMEDOUT'.
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      const isTimeout = code === 'ETIMEDOUT';
      return {
        blocked: true,
        findings: [],
        files_scanned: 0,
        error: isTimeout
          ? 'Guardrail binary timed out (killed after 10s)'
          : `Guardrail binary error: ${result.error.message}`,
      };
    }

    // Fail-closed: usage error (bad CLI args)
    if (result.status === 2) {
      return {
        blocked: true,
        findings: [],
        files_scanned: 0,
        error: result.stderr || 'Guardrail usage error',
      };
    }

    // Exit 0 = clean (blocked: false), Exit 1 = blocked (blocked: true).
    // Both produce valid JSON on stdout. Parse and return directly.
    const parsed: GuardrailResult = JSON.parse(result.stdout);
    return parsed;
  } catch (err) {
    // Fail-closed: JSON parse error, unexpected exception, etc.
    return {
      blocked: true,
      findings: [],
      files_scanned: 0,
      error: `Guardrail scan failed: ${(err as Error).message}`,
    };
  }
}
