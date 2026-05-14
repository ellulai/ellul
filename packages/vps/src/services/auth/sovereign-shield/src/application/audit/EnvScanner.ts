// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Environment Scanner Service
 *
 * Pre-deploy static code scanner (advisory, not blocking).
 * Detects common patterns that might leak secrets via process.env
 * enumeration. Logs warnings to help users catch accidental leaks.
 *
 * Patterns detected:
 *   - console.log(process.env) without property access
 *   - JSON.stringify(process.env)
 *   - Object.keys/entries/values(process.env)
 *   - {...process.env} spread
 *   - res.json(process.env) / res.send(process.env)
 */

import fs from 'fs';
import path from 'path';

interface ScanWarning {
  file: string;
  line: number;
  pattern: string;
  snippet: string;
}

const PATTERNS: Array<{ regex: RegExp; description: string }> = [
  {
    regex: /console\.(log|warn|error|info|debug)\s*\(\s*process\.env\s*\)/,
    description: 'console.log(process.env) — logs all environment variables',
  },
  {
    regex: /JSON\.stringify\s*\(\s*process\.env/,
    description: 'JSON.stringify(process.env) — serializes all env vars',
  },
  {
    regex: /Object\.(keys|entries|values)\s*\(\s*process\.env\s*\)/,
    description: 'Object.keys(process.env) — enumerates env var names',
  },
  {
    regex: /\{\s*\.\.\.process\.env\s*[,}]/,
    description: '{...process.env} — spreads all env vars into object',
  },
  {
    regex: /res\.(json|send|write)\s*\(\s*process\.env\s*\)/,
    description: 'res.json(process.env) — sends all env vars in HTTP response',
  },
  {
    regex: /Response\.(json)\s*\(\s*process\.env\s*\)/,
    description: 'Response.json(process.env) — sends all env vars in HTTP response',
  },
  {
    regex: /c\.(json|text)\s*\(\s*process\.env\s*\)/,
    description: 'c.json(process.env) — sends all env vars in Hono response',
  },
];

const SCAN_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.php',
]);

const IGNORE_DIRS = new Set([
  'node_modules', '.next', '.nuxt', 'dist', 'build', '.git',
  '__pycache__', '.venv', 'vendor',
]);

/**
 * Recursively scan a directory for env leak patterns.
 * Advisory only — returns warnings, does not block deployment.
 */
export function scanForEnvLeaks(projectDir: string): ScanWarning[] {
  const warnings: ScanWarning[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!SCAN_EXTENSIONS.has(ext)) continue;
        scanFile(path.join(dir, entry.name), warnings);
      }
    }
  }

  function scanFile(filePath: string, out: ScanWarning[]): void {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      return;
    }

    const lines = content.split('\n');
    const relativePath = path.relative(projectDir, filePath);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Skip comments
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

      for (const pattern of PATTERNS) {
        if (pattern.regex.test(line)) {
          out.push({
            file: relativePath,
            line: i + 1,
            pattern: pattern.description,
            snippet: trimmed.slice(0, 120),
          });
        }
      }
    }
  }

  walk(projectDir);
  return warnings;
}
