// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Shared Context — consolidates ProjectJson interface and common guards
 * that were duplicated across 6+ command files.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { EXIT, fail } from './output';

export interface ProjectJson {
  projectId: string;
  projectSlug: string;
  projectName: string;
  mode?: 'cloud' | 'local' | 'byos';
  path?: string;
}

/**
 * Read .ellul/project.json from the given directory (defaults to cwd).
 * Returns null if not found or invalid.
 */
export function readProjectJson(cwd?: string): ProjectJson | null {
  const dir = cwd ?? process.cwd();
  const file = path.join(dir, '.ellul', 'project.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw) as ProjectJson;
    if (!data.projectSlug || !data.projectName) return null;
    // Cloud mode requires server-assigned projectId
    if (data.mode === 'cloud' && !data.projectId) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Read .ellul/project.json or exit with a usage error.
 */
export function requireProjectJson(tag: string, cwd?: string): ProjectJson {
  const project = readProjectJson(cwd);
  if (!project) {
    fail(
      EXIT.USAGE,
      tag,
      'No .ellul/project.json found in current directory.',
      'Run `ellul init` first to bind this workspace to a project.',
    );
  }
  return project;
}

/** Port file location — must match proxy-daemon.ts PORT_FILE */
const PORT_FILE = `${process.env.HOME}/.ellul/proxy.port`;

/**
 * Read the proxy port from the port file with PID liveness check.
 * Returns null if proxy is not running.
 *
 * This is the SINGLE source of truth for port file reading.
 * proxy-daemon.ts has getProxyUrl()/readProxyPort() that do the same
 * thing, but those import the full daemon module. Commands that only
 * need the port should use this instead.
 */
export function readProxyInfo(): { port: number; url: string } | null {
  try {
    const content = fs.readFileSync(PORT_FILE, 'utf8').trim();
    const [portStr, pidStr] = content.split(':');
    const port = parseInt(portStr!, 10);
    const pid = parseInt(pidStr!, 10);

    if (!port || isNaN(port) || !pid || isNaN(pid)) return null;

    // PID liveness check
    try {
      process.kill(pid, 0);
    } catch {
      // Stale PID — clean up
      try { fs.unlinkSync(PORT_FILE); } catch {}
      return null;
    }

    return { port, url: `http://127.0.0.1:${port}` };
  } catch {
    return null;
  }
}

/**
 * Get the running proxy URL or exit with a network error.
 */
export function requireProxy(tag: string): string {
  const info = readProxyInfo();
  if (!info) {
    fail(EXIT.NETWORK, tag, 'Auth proxy not running.', 'Start with: ellul');
  }
  return info.url;
}

/**
 * Get the running proxy port or exit with a network error.
 */
export function requireProxyPort(tag: string): number {
  const info = readProxyInfo();
  if (!info) {
    fail(EXIT.NETWORK, tag, 'Auth proxy not running.', 'Start with: ellul');
  }
  return info.port;
}

/**
 * Shared readline prompt helper. Output goes to stderr to preserve stdout for data.
 */
export function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
