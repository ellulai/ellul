// SPDX-License-Identifier: BUSL-1.1 AND MIT
// Portions Copyright (c) 2026 T3 Tools Inc. (MIT) — ported verbatim from
// pingdotgg/t3code@b0b7b38 packages/shared/src/cliArgs.ts

export interface ParsedCliArgs {
  readonly flags: Record<string, string | null>;
  readonly positionals: string[];
}

export interface ParseCliArgsOptions {
  readonly booleanFlags?: readonly string[];
}

export function parseCliArgs(
  args: string | readonly string[],
  options?: ParseCliArgsOptions,
): ParsedCliArgs {
  const tokens =
    typeof args === "string" ? args.trim().split(/\s+/).filter(Boolean) : Array.from(args);
  const booleanSet = options?.booleanFlags ? new Set(options.booleanFlags) : undefined;

  const flags: Record<string, string | null> = {};
  const positionals: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (token.startsWith("--")) {
      const rest = token.slice(2);
      if (!rest) continue;

      const eqIndex = rest.indexOf("=");
      if (eqIndex !== -1) {
        flags[rest.slice(0, eqIndex)] = rest.slice(eqIndex + 1);
        continue;
      }

      if (booleanSet?.has(rest)) {
        flags[rest] = null;
        continue;
      }

      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[rest] = next;
        i++;
      } else {
        flags[rest] = null;
      }
      continue;
    }

    positionals.push(token);
  }

  return { flags, positionals };
}
