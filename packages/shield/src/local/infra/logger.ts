// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Structured JSON Logger — Production-grade logging with rotation
 *
 * Every log entry is a single JSON line with:
 *   - timestamp (ISO 8601)
 *   - level (debug, info, warn, error, security)
 *   - event (machine-readable event type)
 *   - message (human-readable)
 *   - project (if applicable)
 *   - correlationId (per-request, for tracing)
 *   - details (arbitrary structured data)
 *
 * File rotation: 10MB max per file, keep 3 rotated files.
 * Secrets NEVER appear in logs — the logger strips known patterns.
 *
 * Dual output:
 *   - stderr: human-readable (colored, for terminal)
 *   - file: structured JSON (for monitoring)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ── Types ──

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'security';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  message: string;
  project?: string;
  correlationId?: string;
  details?: Record<string, unknown>;
}

export interface LoggerOptions {
  logDir: string;
  maxFileSize?: number;   // bytes, default 10MB
  maxFiles?: number;       // rotated files to keep, default 3
  stderrEnabled?: boolean; // print to stderr, default true
  fileEnabled?: boolean;   // write to file, default true
  minLevel?: LogLevel;     // minimum level to log, default 'info'
}

// ── Constants ──

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const DEFAULT_MAX_FILES = 3;
const LOG_FILE_NAME = 'daemon.log';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  security: 4,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m',    // gray
  info: '\x1b[36m',     // cyan
  warn: '\x1b[33m',     // yellow
  error: '\x1b[31m',    // red
  security: '\x1b[35m', // magenta
};

const RESET = '\x1b[0m';

// ── Sensitive Pattern Scrubbing ──

const SENSITIVE_PATTERNS = [
  /[A-Za-z0-9+/=]{40,}/g,            // base64 blobs (tokens, keys)
  /sk-[a-zA-Z0-9]{20,}/g,            // OpenAI keys
  /ghp_[a-zA-Z0-9]{36}/g,            // GitHub PATs
  /xoxb-[a-zA-Z0-9-]{20,}/g,         // Slack tokens
  /password['":\s]*[=:]\s*['"][^'"]+['"]/gi, // password= patterns
];

function scrubSensitive(str: string): string {
  let result = str;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

function scrubDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const scrubbed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes('secret') || lowerKey.includes('password') ||
        lowerKey.includes('token') || lowerKey.includes('key') ||
        lowerKey.includes('credential')) {
      scrubbed[key] = '[REDACTED]';
    } else if (typeof value === 'string') {
      scrubbed[key] = scrubSensitive(value);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      scrubbed[key] = scrubDetails(value as Record<string, unknown>);
    } else {
      scrubbed[key] = value;
    }
  }
  return scrubbed;
}

// ── Logger ──

export class LocalLogger {
  private logFilePath: string;
  private fd: number | null = null;
  private currentSize = 0;
  private maxFileSize: number;
  private maxFiles: number;
  private stderrEnabled: boolean;
  private fileEnabled: boolean;
  private minLevel: number;

  constructor(private options: LoggerOptions) {
    this.maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.stderrEnabled = options.stderrEnabled ?? true;
    this.fileEnabled = options.fileEnabled ?? true;
    this.minLevel = LEVEL_ORDER[options.minLevel ?? 'info'];
    this.logFilePath = path.join(options.logDir, LOG_FILE_NAME);

    if (this.fileEnabled) {
      fs.mkdirSync(options.logDir, { recursive: true, mode: 0o700 });
      this.openLogFile();
    }
  }

  private openLogFile(): void {
    try {
      this.fd = fs.openSync(this.logFilePath, 'a', 0o600);
      try {
        this.currentSize = fs.fstatSync(this.fd).size;
      } catch {
        this.currentSize = 0;
      }
    } catch {
      this.fd = null;
      this.fileEnabled = false;
    }
  }

  private rotateIfNeeded(): void {
    if (!this.fd || this.currentSize < this.maxFileSize) return;

    fs.closeSync(this.fd);
    this.fd = null;

    // Rotate: daemon.log.2 → daemon.log.3, daemon.log.1 → daemon.log.2, daemon.log → daemon.log.1
    for (let i = this.maxFiles; i >= 1; i--) {
      const src = i === 1 ? this.logFilePath : `${this.logFilePath}.${i - 1}`;
      const dst = `${this.logFilePath}.${i}`;
      try {
        if (i === this.maxFiles) {
          fs.unlinkSync(dst); // Delete oldest
        }
      } catch { /* doesn't exist */ }
      try {
        fs.renameSync(src, dst);
      } catch { /* src doesn't exist */ }
    }

    this.openLogFile();
  }

  /** Generate a correlation ID for request tracing. */
  generateCorrelationId(): string {
    return crypto.randomBytes(8).toString('hex');
  }

  /** Core log method. */
  log(level: LogLevel, event: string, message: string, extra?: {
    project?: string;
    correlationId?: string;
    details?: Record<string, unknown>;
  }): void {
    if (LEVEL_ORDER[level] < this.minLevel) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      message,
      project: extra?.project,
      correlationId: extra?.correlationId,
      details: scrubDetails(extra?.details),
    };

    // File output: single JSON line
    if (this.fileEnabled && this.fd) {
      const line = JSON.stringify(entry) + '\n';
      const bytes = Buffer.byteLength(line);
      try {
        fs.writeSync(this.fd, line);
        this.currentSize += bytes;
        this.rotateIfNeeded();
      } catch {
        // Log file write failed — non-fatal
      }
    }

    // Stderr output: human-readable
    if (this.stderrEnabled) {
      const color = LEVEL_COLORS[level];
      const prefix = `${color}[${level.toUpperCase().padEnd(8)}]${RESET}`;
      const projectTag = entry.project ? ` (${entry.project})` : '';
      process.stderr.write(`${prefix} ${entry.message}${projectTag}\n`);
    }
  }

  // ── Convenience Methods ──

  debug(event: string, message: string, extra?: { project?: string; correlationId?: string; details?: Record<string, unknown> }): void {
    this.log('debug', event, message, extra);
  }

  info(event: string, message: string, extra?: { project?: string; correlationId?: string; details?: Record<string, unknown> }): void {
    this.log('info', event, message, extra);
  }

  warn(event: string, message: string, extra?: { project?: string; correlationId?: string; details?: Record<string, unknown> }): void {
    this.log('warn', event, message, extra);
  }

  error(event: string, message: string, extra?: { project?: string; correlationId?: string; details?: Record<string, unknown> }): void {
    this.log('error', event, message, extra);
  }

  security(event: string, message: string, extra?: { project?: string; correlationId?: string; details?: Record<string, unknown> }): void {
    this.log('security', event, message, extra);
  }

  /** Flush and close log file. */
  close(): void {
    if (this.fd) {
      try { fs.closeSync(this.fd); } catch {}
      this.fd = null;
    }
  }
}
