// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Capability Allowlist — Command → gate mapping for the free tier
 *
 * In capability mode (default), only allowlisted commands are accepted.
 * Each command pattern maps to a specific gate type (test, build, lint, dev).
 *
 * In unrestricted mode (explicit opt-in), all commands are accepted and
 * require the generic "exec" gate.
 *
 * The allowlist is intentionally conservative. It covers:
 *   - Node.js ecosystem (npm, npx, yarn, pnpm, jest, vitest, eslint, prettier)
 *   - Go (go test, go build, go vet, golangci-lint)
 *   - Python (pytest, python -m pytest, ruff, mypy, black, flake8)
 *   - Rust (cargo test, cargo build, cargo clippy, cargo fmt)
 *   - General (make test, make build, make lint)
 */

export type GateType = 'test' | 'build' | 'lint' | 'dev' | 'exec';

export type ExecMode = 'capability' | 'unrestricted';

export interface Capability {
  /** Human-readable capability name. */
  name: string;
  /** Which gate this requires. */
  gate: GateType;
  /** Command prefixes that match this capability. */
  patterns: string[];
}

const CAPABILITIES: Capability[] = [
  // ── Test ──
  {
    name: 'test',
    gate: 'test',
    patterns: [
      'npm test', 'npm run test', 'npm run test:',
      'npx jest', 'npx vitest', 'npx mocha',
      'yarn test', 'yarn run test',
      'pnpm test', 'pnpm run test',
      'jest', 'vitest', 'mocha',
      'go test', 'go test ',
      'pytest', 'python -m pytest', 'python3 -m pytest',
      'cargo test',
      'make test',
    ],
  },
  // ── Build ──
  {
    name: 'build',
    gate: 'build',
    patterns: [
      'npm run build', 'npm run build:',
      'npx tsc', 'npx tsup', 'npx esbuild', 'npx vite build', 'npx next build',
      'yarn build', 'yarn run build',
      'pnpm build', 'pnpm run build',
      'tsc', 'tsup', 'esbuild',
      'go build',
      'cargo build',
      'make build', 'make all',
    ],
  },
  // ── Lint ──
  {
    name: 'lint',
    gate: 'lint',
    patterns: [
      'npm run lint', 'npm run lint:',
      'npx eslint', 'npx prettier', 'npx biome',
      'yarn lint', 'yarn run lint',
      'pnpm lint', 'pnpm run lint',
      'eslint', 'prettier', 'biome',
      'go vet', 'golangci-lint',
      'ruff', 'mypy', 'black', 'flake8', 'pylint',
      'python -m ruff', 'python -m mypy', 'python -m black',
      'cargo clippy', 'cargo fmt',
      'make lint',
    ],
  },
  // ── Dev ──
  {
    name: 'dev',
    gate: 'dev',
    patterns: [
      'npm run dev', 'npm start', 'npm run start',
      'npx vite', 'npx next dev', 'npx next start',
      'yarn dev', 'yarn start',
      'pnpm dev', 'pnpm start',
      'go run',
      'cargo run',
      'python manage.py runserver', 'python3 manage.py runserver',
      'make dev', 'make run',
    ],
  },
];

/**
 * Match a command string against the capability allowlist.
 *
 * Returns the matched capability, or null if no match.
 * Matching is prefix-based: "npm test --coverage" matches "npm test".
 */
export function matchCapability(command: string): Capability | null {
  const trimmed = command.trim();
  for (const cap of CAPABILITIES) {
    for (const pattern of cap.patterns) {
      if (trimmed === pattern || trimmed.startsWith(pattern + ' ') || trimmed.startsWith(pattern + ':')) {
        return cap;
      }
    }
  }
  return null;
}

/**
 * Check if a command is allowed under the given exec mode.
 *
 * - capability mode: command must match allowlist
 * - unrestricted mode: all commands allowed
 */
export function isAllowlisted(command: string, execMode: ExecMode): boolean {
  if (execMode === 'unrestricted') return true;
  return matchCapability(command) !== null;
}

/**
 * Get the gate type required for a command.
 *
 * - capability mode: returns the specific gate (test, build, lint, dev)
 * - unrestricted mode: returns 'exec' (generic gate)
 * - unknown command in capability mode: returns null (command not allowed)
 */
export function getRequiredGate(command: string, execMode: ExecMode): GateType | null {
  if (execMode === 'unrestricted') return 'exec';
  const cap = matchCapability(command);
  return cap ? cap.gate : null;
}

/** Get all registered capabilities (for display/help). */
export function getAllCapabilities(): Capability[] {
  return [...CAPABILITIES];
}
