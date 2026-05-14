// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Single source of truth for the cross-project rsync allowlist.
 *
 * SECURITY: Allowlist approach — only source code and safe config files.
 * A denylist of secrets can never be complete (custom filenames, *.pem,
 * database.yml, etc.). An allowlist is provably complete: if a file extension
 * is not listed, it is not copied. Period.
 *
 * Used by namespace-spawn.service.ts (deferred mount TypeScript path).
 * ns-mount.c does NOT rsync — it defers to the TypeScript layer.
 */

export const RSYNC_ALLOWLIST_ARGS: readonly string[] = [
  // ── Deny rules FIRST (rsync applies first-match-wins) ──
  // Defence-in-depth: even if an allowlisted extension would otherwise match,
  // these patterns refuse names that smell like secrets. Source sandbox
  // cannot evade by giving a secret-shaped file a code extension (e.g.
  // `aws-creds.ts`) because these deny patterns don't override the .ts
  // extension — they catch the file-name patterns that are almost never
  // legitimate source code.
  '--exclude=.env',
  '--exclude=.env.*',
  '--exclude=*.pem',
  '--exclude=*.key',
  '--exclude=*.p12',
  '--exclude=*.pfx',
  '--exclude=*.jks',
  '--exclude=*.keystore',
  '--exclude=*_rsa',
  '--exclude=*_rsa.pub',
  '--exclude=*_ed25519',
  '--exclude=*_ed25519.pub',
  '--exclude=.pgpass',
  '--exclude=.npmrc',
  '--exclude=.netrc',
  '--exclude=.htpasswd',
  '--exclude=credentials',
  '--exclude=credentials.*',
  '--exclude=service-account*',
  '--exclude=terraform.tfstate',
  '--exclude=terraform.tfstate.*',
  '--exclude=*.dump',
  '--exclude=*.bak',
  '--exclude=*.backup',
  '--exclude=.DS_Store',
  // Directories that should never cross — agent config + VCS internals.
  '--exclude=.git/',
  '--exclude=.aws/',
  '--exclude=.gcp/',
  '--exclude=.kube/',
  '--exclude=.ssh/',
  '--exclude=.gnupg/',
  '--exclude=.claude/',
  '--exclude=.codex/',
  '--exclude=.cursor/',
  '--exclude=.zeroclaw/',
  '--exclude=.docker/',
  '--exclude=.vscode/',
  '--exclude=.idea/',
  '--exclude=node_modules/',
  '--exclude=.next/',
  '--exclude=.turbo/',
  '--exclude=dist/',
  '--exclude=build/',

  '--include=*/',
  // Languages
  '--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.jsx', '--include=*.mjs', '--include=*.cjs',
  '--include=*.py', '--include=*.pyi', '--include=*.pyx',
  '--include=*.go', '--include=*.rs', '--include=*.rb', '--include=*.java', '--include=*.kt', '--include=*.scala',
  '--include=*.c', '--include=*.cpp', '--include=*.cc', '--include=*.h', '--include=*.hpp',
  '--include=*.cs', '--include=*.fs', '--include=*.vb',
  '--include=*.swift', '--include=*.m', '--include=*.mm',
  '--include=*.php', '--include=*.lua', '--include=*.ex', '--include=*.exs', '--include=*.erl',
  '--include=*.dart', '--include=*.r', '--include=*.R', '--include=*.jl', '--include=*.zig', '--include=*.nim',
  // Shell
  '--include=*.sh', '--include=*.bash', '--include=*.zsh', '--include=*.fish',
  // Web
  '--include=*.html', '--include=*.htm', '--include=*.css', '--include=*.scss', '--include=*.sass', '--include=*.less',
  '--include=*.svg', '--include=*.vue', '--include=*.svelte', '--include=*.astro',
  // Docs
  '--include=*.md', '--include=*.mdx', '--include=*.txt', '--include=*.rst', '--include=*.adoc',
  // Data/config
  '--include=*.json', '--include=*.yaml', '--include=*.yml', '--include=*.toml', '--include=*.xml',
  '--include=*.graphql', '--include=*.gql', '--include=*.proto', '--include=*.sql',
  // Build/package
  '--include=*.lock', '--include=Makefile', '--include=Dockerfile', '--include=Procfile',
  '--include=.gitignore', '--include=.editorconfig', '--include=.prettierrc', '--include=.eslintrc*',
  '--include=package.json', '--include=tsconfig*.json', '--include=pyproject.toml',
  '--include=Cargo.toml', '--include=Cargo.lock', '--include=go.mod', '--include=go.sum',
  '--include=Gemfile', '--include=Gemfile.lock', '--include=mix.exs', '--include=mix.lock',
  '--include=requirements*.txt', '--include=setup.py', '--include=setup.cfg',
  '--include=pom.xml', '--include=build.gradle*', '--include=*.sln', '--include=*.csproj',
  // Exclude everything else
  '--exclude=*',
] as const;

/**
 * Generate the rsync allowlist as shell script fragment (for embedding in bash).
 * Each arg on its own line with trailing backslash for readability.
 */
export function rsyncAllowlistShell(): string {
  return RSYNC_ALLOWLIST_ARGS.map(a => `          ${a} \\`).join('\n');
}

/**
 * Generate the rsync allowlist for embedding inside an OUTER single-quoted
 * bash string (the spawn.sh template is itself a single-quoted heredoc that's
 * passed to `unshare bash -c '...'`). Each arg is wrapped as `'"'"'<arg>'"'"'`
 * so the *inner* shell sees `'<arg>'` — single-quoted, glob-safe.
 *
 * Args here do not contain literal `'` characters; if that ever changes, this
 * helper must escape them as `'"'"'` *within* the arg as well.
 */
export function rsyncAllowlistNestedShell(): string {
  for (const arg of RSYNC_ALLOWLIST_ARGS) {
    if (arg.includes("'")) {
      throw new Error(
        `rsync allowlist arg contains a single quote which the nested-shell encoder does not handle: ${arg}`,
      );
    }
  }
  return RSYNC_ALLOWLIST_ARGS.map(a => `          '"'"'${a}'"'"' \\`).join('\n');
}
