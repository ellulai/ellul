// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Exec Pipeline — SSE streaming and buffered command execution
 *
 * Creates per-request redaction engine instances (concurrency-safe).
 * Pipes child process stdout/stderr through Aho-Corasick DFA.
 * Injects secrets as environment variables.
 */

import * as http from 'http';
import { spawn, type ChildProcess } from 'child_process';

import type { LocalRegisteredProject } from '../infra/project-registry';
import { type LocalDaemonState, getSecretStore, createRedactionEngine } from './state';

/**
 * Execute a command with SSE streaming output.
 * Per-request redaction engine — no shared mutable state.
 */
export function executeCommandSSE(
  res: http.ServerResponse,
  command: string,
  project: LocalRegisteredProject,
  state: LocalDaemonState,
): void {
  const redactor = createRedactionEngine(state);
  const store = getSecretStore(state, project.projectSlug);
  const secretEnv = store ? store.getAllForExecEnv() : {};

  const parts = command.trim().split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const meta: Record<string, unknown> = { command, project: project.projectSlug };
  if (state.execMode === 'unrestricted') {
    meta.mode = 'unrestricted';
    meta.warning = 'Command ran outside capability allowlist';
  }
  res.write(`event: meta\ndata: ${JSON.stringify(meta)}\n\n`);

  const child: ChildProcess = spawn(cmd, args, {
    cwd: project.directory,
    shell: false,
    env: { ...process.env, ...secretEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
  });

  const cleanup = () => { try { child.kill('SIGTERM'); } catch {} };
  res.on('close', cleanup);

  child.stdout?.on('data', (chunk: Buffer) => {
    const redacted = redactor.process(chunk);
    if (redacted.length > 0) {
      res.write(`event: stdout\ndata: ${redacted.toString('utf8')}\n\n`);
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    const redacted = redactor.process(chunk);
    if (redacted.length > 0) {
      res.write(`event: stderr\ndata: ${redacted.toString('utf8')}\n\n`);
    }
  });

  child.on('close', (code) => {
    const flushed = redactor.flush();
    if (flushed.length > 0) {
      res.write(`event: stdout\ndata: ${flushed.toString('utf8')}\n\n`);
    }
    res.write(`event: exit\ndata: ${JSON.stringify({ code: code ?? 1 })}\n\n`);
    res.end();
    res.removeListener('close', cleanup);
  });

  child.on('error', (err) => {
    res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
    res.end();
    res.removeListener('close', cleanup);
  });
}

/**
 * Execute and collect output (non-streaming JSON fallback).
 */
export async function executeCommandBuffered(
  command: string,
  project: LocalRegisteredProject,
  state: LocalDaemonState,
): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string; mode?: string; warning?: string }> {
  const redactor = createRedactionEngine(state);
  const store = getSecretStore(state, project.projectSlug);
  const secretEnv = store ? store.getAllForExecEnv() : {};
  const parts = command.trim().split(/\s+/);

  return new Promise((resolve) => {
    const child = spawn(parts[0], parts.slice(1), {
      cwd: project.directory,
      shell: false,
      env: { ...process.env, ...secretEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdout += redactor.process(chunk).toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += redactor.process(chunk).toString(); });

    child.on('close', (code) => {
      const flushed = redactor.flush();
      if (flushed.length > 0) stdout += flushed.toString();

      const result: Record<string, unknown> = { ok: code === 0, exitCode: code ?? 1, stdout, stderr };
      if (state.execMode === 'unrestricted') {
        result.mode = 'unrestricted';
        result.warning = 'Command ran outside capability allowlist';
      }
      resolve(result as ReturnType<typeof executeCommandBuffered> extends Promise<infer T> ? T : never);
    });

    child.on('error', (err) => {
      resolve({ ok: false, exitCode: 1, stdout: '', stderr: `Failed to spawn: ${err.message}` });
    });
  });
}
