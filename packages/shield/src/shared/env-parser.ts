// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// .env parser. Opaque strings only — no shell expansion, no $VAR, no $(cmd) (injection guard).

/** A single parsed environment variable. */
export interface EnvEntry {
  /** Variable name (validated POSIX: [A-Z_][A-Z0-9_]*). */
  key: string;
  /** Raw value after unquoting and unescape. */
  value: string;
  /** Original line number (1-based) for error reporting. */
  line: number;
}

/** Result of parsing a .env file. */
export interface EnvParseResult {
  /** Successfully parsed entries (deduplicated — last wins). */
  entries: EnvEntry[];
  /** Warnings for skipped lines (not fatal). */
  warnings: string[];
  /** Lines that look like they contain sensitive patterns. */
  detectedSensitiveKeys: string[];
}

/** POSIX-compliant variable name. */
const KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Patterns that suggest a key holds sensitive data. */
const SENSITIVE_PATTERNS = [
  /SECRET/i, /TOKEN/i, /KEY/i, /PASSWORD/i, /PASS/i,
  /CREDENTIAL/i, /AUTH/i, /PRIVATE/i, /SIGNING/i,
  /ENCRYPTION/i, /CERT/i, /DSN/i, /CONNECTION.*STRING/i,
  /DATABASE_URL/i, /REDIS_URL/i, /MONGO_URL/i, /AMQP_URL/i,
];

// dotenv semantics + export prefix, multiline quotes, escapes, BOM.
// Rejects $VAR / $(cmd) / backtick (security + ambiguity).
export function parseEnvContent(content: string): EnvParseResult {
  const entries: EnvEntry[] = [];
  const warnings: string[] = [];
  const detectedSensitiveKeys: string[] = [];
  const seen = new Map<string, number>(); // key → index in entries[]

  // Strip BOM (UTF-8 byte order mark from Windows editors)
  let input = content;
  if (input.charCodeAt(0) === 0xFEFF) {
    input = input.slice(1);
  }

  // Normalize line endings
  const lines = input.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const lineNum = i + 1;
    let line = lines[i]!;
    i++;

    // Skip empty lines and comments
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Strip optional `export` prefix
    let working = trimmed;
    if (working.startsWith('export ')) {
      working = working.slice(7).trim();
    } else if (working.startsWith('export\t')) {
      working = working.slice(7).trim();
    }

    // Find the = delimiter
    const eqIdx = working.indexOf('=');
    if (eqIdx === -1) {
      warnings.push(`Line ${lineNum}: Skipped — no '=' delimiter found: "${truncate(trimmed, 40)}"`);
      continue;
    }

    const key = working.slice(0, eqIdx).trim();

    // Validate key
    if (!KEY_REGEX.test(key)) {
      warnings.push(`Line ${lineNum}: Skipped — invalid key "${truncate(key, 30)}". Keys must match [A-Z_][A-Z0-9_]*.`);
      continue;
    }

    // Parse value
    let rawValue = working.slice(eqIdx + 1);

    // Leading whitespace after = is significant only for unquoted values
    // For quoted values, we trim to find the opening quote
    const valueStart = rawValue.trimStart();

    let value: string;

    if (valueStart.startsWith('"')) {
      // Double-quoted value — supports escape sequences and multiline
      const result = parseDoubleQuoted(valueStart.slice(1), lines, i);
      if (result.error) {
        warnings.push(`Line ${lineNum}: ${result.error}`);
        i = result.nextLine;
        continue;
      }
      value = result.value;
      i = result.nextLine;
    } else if (valueStart.startsWith("'")) {
      // Single-quoted value — literal (no escapes), supports multiline
      const result = parseSingleQuoted(valueStart.slice(1), lines, i);
      if (result.error) {
        warnings.push(`Line ${lineNum}: ${result.error}`);
        i = result.nextLine;
        continue;
      }
      value = result.value;
      i = result.nextLine;
    } else {
      // Unquoted value — strip inline comments, trim trailing whitespace
      value = parseUnquoted(rawValue);
    }

    // Detect sensitive keys
    if (SENSITIVE_PATTERNS.some(p => p.test(key))) {
      detectedSensitiveKeys.push(key);
    }

    // Dedup: last occurrence wins (same as dotenv)
    const existingIdx = seen.get(key);
    if (existingIdx !== undefined) {
      entries[existingIdx] = { key, value, line: lineNum };
    } else {
      seen.set(key, entries.length);
      entries.push({ key, value, line: lineNum });
    }
  }

  return { entries, warnings, detectedSensitiveKeys };
}

// ── Quoted value parsers ──

interface QuoteParseResult {
  value: string;
  nextLine: number;
  error?: string;
}

function parseDoubleQuoted(
  afterQuote: string,
  allLines: string[],
  currentLineIdx: number,
): QuoteParseResult {
  // Scan for closing unescaped "
  let result = '';
  let remaining = afterQuote;
  let lineIdx = currentLineIdx;

  for (;;) {
    let j = 0;
    while (j < remaining.length) {
      const ch = remaining[j]!;
      if (ch === '\\' && j + 1 < remaining.length) {
        // Escape sequence
        const next = remaining[j + 1]!;
        switch (next) {
          case 'n': result += '\n'; break;
          case 'r': result += '\r'; break;
          case 't': result += '\t'; break;
          case '"': result += '"'; break;
          case '\\': result += '\\'; break;
          case '$': result += '$'; break;
          default: result += '\\' + next; break; // preserve unknown escapes
        }
        j += 2;
      } else if (ch === '"') {
        // Closing quote found
        return { value: result, nextLine: lineIdx };
      } else {
        result += ch;
        j++;
      }
    }

    // No closing quote on this line — continue to next (multiline)
    if (lineIdx >= allLines.length) {
      return {
        value: '',
        nextLine: lineIdx,
        error: 'Unterminated double-quoted value (reached end of file)',
      };
    }

    result += '\n';
    remaining = allLines[lineIdx]!;
    lineIdx++;
  }
}

function parseSingleQuoted(
  afterQuote: string,
  allLines: string[],
  currentLineIdx: number,
): QuoteParseResult {
  // Single quotes: no escape processing, literal until closing '
  let result = '';
  let remaining = afterQuote;
  let lineIdx = currentLineIdx;

  for (;;) {
    const closeIdx = remaining.indexOf("'");
    if (closeIdx !== -1) {
      result += remaining.slice(0, closeIdx);
      return { value: result, nextLine: lineIdx };
    }

    // No closing quote — multiline
    result += remaining;

    if (lineIdx >= allLines.length) {
      return {
        value: '',
        nextLine: lineIdx,
        error: 'Unterminated single-quoted value (reached end of file)',
      };
    }

    result += '\n';
    remaining = allLines[lineIdx]!;
    lineIdx++;
  }
}

function parseUnquoted(raw: string): string {
  // Strip inline comments: find first # not inside quotes
  // For unquoted values, # always starts a comment
  const hashIdx = raw.indexOf('#');
  let value: string;
  if (hashIdx !== -1) {
    // Only treat as comment if preceded by whitespace (or at start)
    // This handles cases like DATABASE_URL=postgres://host#fragment
    const beforeHash = raw.slice(0, hashIdx);
    if (beforeHash.endsWith(' ') || beforeHash.endsWith('\t') || hashIdx === 0) {
      value = beforeHash.trimEnd();
    } else {
      value = raw;
    }
  } else {
    value = raw;
  }

  // Trim whitespace (unquoted values have trailing whitespace stripped)
  return value.trim();
}

// ── Utility ──

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + '...';
}

/**
 * Detect the target environment from the filename.
 *
 * Supported patterns:
 *   .env                → production (default)
 *   .env.local          → development
 *   .env.development    → development
 *   .env.dev            → development
 *   .env.staging        → production (staging is prod-like)
 *   .env.production     → production
 *   .env.prod           → production
 *   .env.test           → development
 *   .env.example        → null (skip — template file)
 *   .env.sample         → null (skip — template file)
 *   .env.template       → null (skip — template file)
 *
 * @returns 'production' | 'development' | null (null = skip this file)
 */
export function detectEnvironmentFromFilename(filename: string): 'production' | 'development' | null {
  const basename = filename.split('/').pop()?.split('\\').pop() ?? filename;
  const lower = basename.toLowerCase();

  // Template files — never import
  if (lower.endsWith('.example') || lower.endsWith('.sample') || lower.endsWith('.template')) {
    return null;
  }

  // Development patterns
  if (
    lower === '.env.local' ||
    lower === '.env.development' ||
    lower === '.env.development.local' ||
    lower === '.env.dev' ||
    lower === '.env.test' ||
    lower === '.env.test.local'
  ) {
    return 'development';
  }

  // Everything else is production (including .env, .env.production, .env.staging, .env.prod)
  return 'production';
}

/**
 * Check if a filename looks like a .env file.
 */
export function isEnvFile(filename: string): boolean {
  const basename = (filename.split('/').pop()?.split('\\').pop() ?? filename).toLowerCase();
  return basename === '.env' || basename.startsWith('.env.');
}
