// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Flag Parser — shared argument parsing for all CLI commands.
 *
 * Supports:
 *   --flag=value    (existing format, backward-compatible)
 *   --flag value    (new: consumes next arg)
 *   --flag          (boolean, returns true)
 *   --              (terminates flag parsing, POSIX standard)
 *
 * No short flags (-j), no value coercion. Commands validate their own values.
 */

export interface ParsedArgs {
  /** Non-flag arguments in order */
  positional: string[];
  /** All flags: --key=val → {key: "val"}, --bool → {bool: true} */
  flags: Record<string, string | true>;
  /** Check if a flag exists */
  has(flag: string): boolean;
  /** Get a string flag value (returns undefined for booleans or missing flags) */
  get(flag: string): string | undefined;
}

/** Known boolean flags that never consume the next argument */
const BOOLEAN_FLAGS = new Set([
  'help', 'json', 'version', 'force', 'yes', 'dry-run', 'auto', 'stdin', 'detach',
  'follow', 'purge', 'cli', 'services', 'vm', 'trust-cert',
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  let terminated = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (terminated || !arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }

    // -- terminates flag parsing
    if (arg === '--') {
      terminated = true;
      continue;
    }

    const raw = arg.slice(2); // strip --
    const eqIdx = raw.indexOf('=');

    if (eqIdx !== -1) {
      // --flag=value
      const key = raw.slice(0, eqIdx);
      const val = raw.slice(eqIdx + 1);
      flags[key] = val;
    } else if (BOOLEAN_FLAGS.has(raw)) {
      // Known boolean — never consume next arg
      flags[raw] = true;
    } else {
      // Check if next arg looks like a value (not another flag)
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[raw] = next;
        i++; // consume next arg
      } else {
        // No value available — treat as boolean
        flags[raw] = true;
      }
    }
  }

  return {
    positional,
    flags,
    has(flag: string): boolean {
      return flag in this.flags;
    },
    get(flag: string): string | undefined {
      const v = this.flags[flag];
      return typeof v === 'string' ? v : undefined;
    },
  };
}
