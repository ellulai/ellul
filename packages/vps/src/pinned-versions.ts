// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Pinned Versions — Single Source of Truth
 *
 * Production-grade version pinning + SHA-256 integrity. Every binary, package,
 * and runtime installed on VPS instances MUST have its version defined here.
 * No `latest`, no floating tags.
 *
 * SHA-256 hashes are hardcoded in Git — the supply-chain trust boundary.
 * Even if GitHub/CDN is compromised, the VPS refuses a tampered download
 * because the hash lives in a different trust domain (Git + CI deploy).
 *
 * To upgrade:
 *   1. Update version + hashes here
 *   2. Re-bake the golden image
 *   3. Deploy
 */

// ══════════════════════════════════════════════════════════════════════
// NPM GLOBAL PACKAGES
// ══════════════════════════════════════════════════════════════════════

export const NPM_VERSIONS = {
  ws: "8.20.0",
  "better-sqlite3": "12.8.0",
  "isolated-vm": "6.1.2",
  "@solana/web3.js": "1.98.4",
  pm2: "6.0.14",
  vercel: "50.37.3",
  wrangler: "4.78.0",
  "@anthropic-ai/claude-code": "2.1.116",
  "@openai/codex": "0.117.0",
} as const;

/** Pin a package name to its version from NPM_VERSIONS */
export function pin(pkg: keyof typeof NPM_VERSIONS): string {
  return `${pkg}@${NPM_VERSIONS[pkg]}`;
}

/** AI CLI tool packages (pinned). Cursor ships as a native binary tarball,
 *  not an npm package — handled separately via BINARY_HASHES.cursorAgent. */
export const NPM_AI_TOOLS = [
  pin("@anthropic-ai/claude-code"),
  pin("@openai/codex"),
] as const;

// ══════════════════════════════════════════════════════════════════════
// AI CLI — R2-mirrored tarballs (enterprise supply chain)
// ══════════════════════════════════════════════════════════════════════
//
// Why this exists: claude-code ships ~240 MB linux-arm64 native binaries
// via npm optionalDependencies. A single 240 MB fetch from registry.npmjs.org
// during cache bake routinely tail-latencies past npm's retry window and
// silently fails. We mirror every platform tarball we care about to R2 under
// the `ai-cli/` prefix of the `ellul-cache` bucket, SHA-256 the bytes at
// mirror time, pin the hash here, and make the bake fetch + verify from R2.
//
// Mirror script:   apps/api/scripts/mirror-ai-cli-binaries.ts
// Consumer:        apps/api/scripts/generate-build-script.ts (cache bake)
// CDN base URL:    process.env.PROVISION_CACHE_URL (same CDN as ellul-cache-*.tar.gz)

/** Linux platforms we install AI CLIs on. Ubuntu 24.04 → glibc only, no musl.
 *  If we ever add an Alpine-based runtime, extend this and re-run the mirror. */
export const AI_CLI_PLATFORMS = ["linux-x64", "linux-arm64"] as const;

export type AiCliPlatform = (typeof AI_CLI_PLATFORMS)[number];

export interface AiCliSpec {
  /** npm wrapper package (the one that ships in PATH). */
  wrapper: keyof typeof NPM_VERSIONS;
  /** Binary name on PATH. */
  binName: string;
  /**
   * Per-platform native-binary resolver. Required — every AI CLI we ship
   * through this pipeline has a native-binary optional-dep layout (claude,
   * codex). Returns BOTH identifiers explicitly (don't try to infer one
   * from the other — upstream conventions differ):
   *
   *   packSpec   — argument to `npm pack`. Resolves the native-binary tarball
   *                on npm. The wrapper's advertised package name can repeat
   *                between wrapper and platform (codex reuses `@openai/codex`
   *                for both), so NEVER derive the install path from this.
   *
   *   installDir — exact `node_modules/<installDir>/` path where the wrapper's
   *                runtime resolver expects to find the binary. For claude this
   *                matches the tarball's package name; for codex this is the
   *                *alias* name the wrapper's optionalDependencies uses
   *                (`@openai/codex-linux-x64`, not `@openai/codex`).
   */
  platformSpec: (
    wrapperVersion: string,
    platform: AiCliPlatform,
  ) => { packSpec: string; installDir: string };
  /**
   * Path inside the extracted wrapper package to the sibling-dep install
   * script (run after placing the platform tarball). `node <script>` must
   * succeed after both tarballs are on disk. `undefined` = no postinstall.
   */
  postinstallScript?: string;
}

export const AI_CLI_SPECS: readonly AiCliSpec[] = [
  {
    wrapper: "@anthropic-ai/claude-code",
    binName: "claude",
    platformSpec: (v, p) => ({
      packSpec: `@anthropic-ai/claude-code-${p}@${v}`,
      // Wrapper's install.cjs uses `require.resolve('@anthropic-ai/claude-code-<platform>')`.
      installDir: `@anthropic-ai/claude-code-${p}`,
    }),
    postinstallScript: "install.cjs",
  },
  {
    wrapper: "@openai/codex",
    binName: "codex",
    platformSpec: (v, p) => ({
      packSpec: `@openai/codex@${v}-${p}`,
      // Wrapper's bin/codex.js calls `require.resolve('@openai/codex-<platform>')` — the
      // alias name from optionalDependencies — NOT `@openai/codex` (the wrapper itself).
      // Collision would rm-rf the wrapper during extract. This must be the alias name.
      installDir: `@openai/codex-${p}`,
    }),
  },
] as const;

/**
 * SHA-256 hashes of AI CLI tarballs mirrored to R2.
 *
 * Key format:
 *   `<wrapperPkg>@<version>/wrapper`  → top-level wrapper tarball
 *   `<wrapperPkg>@<version>/<platform>` → per-platform native binary tarball
 *
 * Populated automatically by `mirror-ai-cli-binaries.ts`. An empty record
 * means no bake has been run yet — the bake will refuse to start.
 */
export const AI_CLI_HASHES: Record<string, string> = {
  "@anthropic-ai/claude-code@2.1.116/linux-arm64": "4a40207946fc0e1a97ec3cddbb8b3d74b3474b6302d8e6efda1ff1084dba4abc",
  "@anthropic-ai/claude-code@2.1.116/linux-x64": "0dde548c698cee7174751a92426123e90a95f56bf09271423681dd883d8bf0ea",
  "@anthropic-ai/claude-code@2.1.116/wrapper": "c86bbeaf44babf744bb1e1f004a268ac31eb164ff37afa93114b766e5667f7f1",
  "@openai/codex@0.117.0/linux-arm64": "6307b4c8831d04f87a4c3d57a76f9e1423efcffcc98f40249a28a3f4fa8bd7e3",
  "@openai/codex@0.117.0/linux-x64": "eb16fd4db24d4173c37b35d415d17a6741eaadd46e1a71f34f92c86b77635606",
  "@openai/codex@0.117.0/wrapper": "afdb82f73d55c3dc5c0ec4de3729273b289b367c6611bc90ba0bdeeca679e189",
};

// ══════════════════════════════════════════════════════════════════════
// SYSTEM BINARIES — GitHub releases / direct downloads
// ══════════════════════════════════════════════════════════════════════

export const BINARY_VERSIONS = {
  /** code-server release tag */
  codeServer: "4.96.4",
  /** ttyd release tag */
  ttyd: "1.7.7",
  /** NVM install script version */
  nvm: "0.40.1",
  /** OpenCode binary release tag — must match @opencode-ai/sdk version
   *  in packages/vps/package.json. Drift causes session.create to return
   *  no payload (server response shape diverges from SDK expectations). */
  opencode: "1.14.29",
  /** lazygit binary release tag */
  lazygit: "0.60.0",
  /** ZeroClaw agent binary release tag — update from `zeroclaw --version` on a live VPS */
  zeroclaw: "0.6.8",
  /** Caddy web server (apt package version) */
  caddy: "2.11.2",
  /** Cursor Agent CLI release tag (see https://cursor.com/install for the
   *  version embedded in the installer script). Distributed as a direct
   *  binary tarball from downloads.cursor.com, not npm. */
  cursorAgent: "2026.04.17-787b533",
  /** Grok CLI (x.ai/cli). Standalone binary via curl installer from
   *  storage.googleapis.com/grok-build-public-artifacts/. Installs to
   *  ~/.grok/bin/grok. Not an npm package. */
  grok: "0.1.210",
} as const;

/**
 * SHA-256 hashes of binary downloads, keyed by name → arch.
 * Hardcoded in Git — the supply-chain trust boundary.
 * Empty string = hash not yet computed (skip verification with warning).
 *
 * Compute with: curl -fsSL <url> | sha256sum
 * Update when changing BINARY_VERSIONS above.
 */
export const BINARY_HASHES: Record<string, Record<string, string>> = {
  lazygit: {
    amd64: "6252ca6cf98bc4fd3e0d927b54225910cfa57b065d0ad88263f14592f7f9ab15",
    arm64: "2c699579165416eede4d2cfaf7d76ccd8f3b20f20f2e8b4abff6b5a6350fcdd7",
  },
  opencode: {
    amd64: "2edfc17bad3ecba54ae1d9753cef9eca686fdd8a0b0f4b785f9209ee0fc8a6d2",
    arm64: "304108f05063bd17ad6df62541b48e19980d8e36d5d507ae2ebf80920990c9a2",
  },
  zeroclaw: {
    amd64: "aa06d409e8f4e5bdc1816dfa451f23bd01f25029b743177532c166e3f6204382",
    arm64: "bbaf89e09d323f12833ecdb5d7b957b67e763d34f7c91b1b16eb4db996f08d98",
  },
  cursorAgent: {
    // Fetched from https://downloads.cursor.com/lab/<version>/linux/<arch>/agent-cli-package.tar.gz
    amd64: "942b2b583239497715f2390336eb8e2df3673703bd167bd59f7be33a27e15c5a",
    arm64: "985191ffc606da1317e1399f99306481f58643f345ed2252033b011504c780ce",
  },
};

// ══════════════════════════════════════════════════════════════════════
// WORKSPACE NPM DEPENDENCIES — version-locked across package.json files
// ══════════════════════════════════════════════════════════════════════
//
// This map is the single source of truth for any npm dependency that
// either pairs with a binary (must match BINARY_VERSIONS), or that we
// want to lock fleet-wide for reproducibility/security reasons.
//
// To bump: edit `version` here, then run `pnpm versions:sync` to write
// the new value into every package.json under `consumers`. CI fails
// the build if package.json drifts from this map (see
// `assertWorkspaceNpmVersionsLockedToPinned` in build-agent-bundles.mjs)
// or if `pairedWith` doesn't match the matched BINARY_VERSIONS entry.

export interface WorkspaceNpmPin {
  /** Exact semver (no caret/tilde — add via `range`). */
  readonly version: string;
  /** Range prefix written into package.json. Default: "exact". */
  readonly range?: "exact" | "^" | "~";
  /** Optional pairing with BINARY_VERSIONS. When set, version MUST match. */
  readonly pairedWith?: keyof typeof BINARY_VERSIONS;
  /** Workspace package paths (relative to repo root) that depend on this. */
  readonly consumers: readonly string[];
}

export const WORKSPACE_NPM_VERSIONS: Record<string, WorkspaceNpmPin> = {
  "@opencode-ai/sdk": {
    version: BINARY_VERSIONS.opencode,
    range: "^",
    pairedWith: "opencode",
    consumers: ["packages/vps"],
  },
  "@anthropic-ai/claude-agent-sdk": {
    version: "0.2.117",
    range: "exact",
    consumers: ["packages/vps"],
  },
};

// ══════════════════════════════════════════════════════════════════════
// RUNTIMES — on-demand installs via ellul-install-runtime
// ══════════════════════════════════════════════════════════════════════

export const RUNTIME_VERSIONS = {
  /** Node.js major version (nodesource + NVM) */
  node: "22",
  /** Go toolchain */
  go: "go1.26.1",
  /** Rust toolchain channel (rustup) */
  rust: "1.87.0",
  /** .NET SDK channel */
  dotnet: "8.0",
  /** Eclipse Temurin JDK major */
  java: "21",
  /** Flutter git tag */
  flutter: "3.32.4",
  /** Bun runtime */
  bun: "1.2.21",
  /** Ruby (apt meta-package, pin major) */
  ruby: "3.2",
  /** Composer (PHP package manager) */
  composer: "2.8.9",
} as const;

// ══════════════════════════════════════════════════════════════════════
// APT PACKAGES — pinned to Ubuntu 24.04 LTS package versions
// ══════════════════════════════════════════════════════════════════════

/**
 * Core apt packages. On Ubuntu 24.04 LTS, apt repos only carry one version
 * at a time — `apt-get install curl` always yields the same version on a
 * given point release. True version lock comes from the golden image snapshot.
 * These names are the install-time manifest; the snapshot bakes exact versions.
 */
export const APT_BASE_PACKAGES = [
  "curl", "git", "ufw", "tmux", "unzip", "wget", "jq",
  "fail2ban", "unattended-upgrades",
  "python3-pip", "python3-venv", "python-is-python3", "pipx",
  "build-essential", "sqlite3", "cryptsetup", "acl", "rsync", "minisign",
  "dnsmasq-base", "ipset",
] as const;

/** PostgreSQL packages (pinned to major 16 — Ubuntu 24.04 default) */
export const APT_PG_PACKAGES = ["postgresql-16", "postgresql-client-16"] as const;

/** Caddy prerequisite packages */
export const APT_CADDY_PREREQS = ["debian-keyring", "debian-archive-keyring", "apt-transport-https"] as const;

/** Firewall packages */
export const APT_FIREWALL_PACKAGES = ["iptables-persistent", "ufw"] as const;

/** On-demand service packages (user-triggered via ellul-install) */
export const APT_SERVICE_PACKAGES = {
  postgresql: ["postgresql-16", "postgresql-contrib-16"],
  redis: ["redis-server"],
  mariadb: ["mariadb-server"],
} as const;

/** On-demand runtime packages (user-triggered via ellul-install-runtime) */
export const APT_RUNTIME_PACKAGES = {
  ruby: ["ruby-full", "libyaml-dev"],
  elixir: ["elixir", "erlang-dev", "erlang-xmerl"],
  php: ["php-cli", "php-mbstring", "php-xml", "php-curl"],
  dart: ["dart"],
  java_prereqs: ["apt-transport-https", "gnupg"],
  java: ["temurin-21-jdk"],
} as const;

// ══════════════════════════════════════════════════════════════════════
// DOCKER BASE IMAGES
// ══════════════════════════════════════════════════════════════════════

/** Pinned Docker base image tag */
export const DOCKER_NODE_TAG = "20.19.2-slim" as const;
