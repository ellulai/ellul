// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Platform Tools — builtin MCP gateway ops: scaffold_project, restart_preview,
// install_deps. Framework knowledge lives in @vps/shared/framework.

import { createHash, createHmac, randomBytes } from 'crypto';
import { execFile as execFileCb, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { isSandboxId } from '@ellul.ai/types';

import type { McpGateway, ToolCallContext } from '../mcp-tool/governance/McpGateway';
import type { ToolCallResult, GovernedToolDefinition } from '../mcp-tool/governance/Types';
import { TAXONOMY_VERSION } from '../mcp-tool/governance/Types';

import { BUILTIN_CONNECTION_ID } from './BuiltinToolRegistry';
import { SCAFFOLDABLE_FRAMEWORK_IDS, getFrameworkById } from '@vps/shared/framework';
import { hydrateTemplate } from '@vps/templates/scaffold';
import { getAgentContextFiles } from '@ellul.ai/i18n-messages/agent-context';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@ellul.ai/i18n-consts';
import { defaultSpecForFramework, writeSpec } from '@vps/shared/preview-spec';
import { getJwtSecret } from '@vps/shared/credentials';
import { PREVIEW_PORT_MIN } from '@vps/shared/constants';
import {
  writeZeroClawWorkspace,
  ensureAppGitignore,
  resolveWorkspaceLayout,
  WorkspaceConfigError,
  type WorkspaceLayout,
} from '@vps/shared/app-workspace';
import { FILE_API_PORT } from '../../config';
import { ensureProject } from '../reconciliation/ZeroclawAgent';
import { callShieldInternal } from '@vps/shared/shield-client';

// ── Constants ──

const PROJECTS_DIR = process.env.PROJECTS_DIR || `${process.env.HOME}/projects`;
const LOG_PREFIX = '[PlatformTools]';

// Browser-facing UI frameworks (single source of truth for ellul.json `type`).
const FRONTEND_FRAMEWORK_IDS = new Set([
  'next', 'nuxt', 'vite', 'cra', 'svelte', 'astro', 'gatsby', 'remix',
  'vue-cli', 'flutter', 'streamlit', 'gradio', 'static',
]);

function deriveScaffoldKind(fw: { id: string; scaffoldKind?: string }): 'frontend' | 'backend' {
  return FRONTEND_FRAMEWORK_IDS.has(fw.id) ? 'frontend' : 'backend';
}

// Aliases → canonical framework IDs (agent may send "nextjs" instead of "next").
const FRAMEWORK_ALIASES: Record<string, string> = {
  'nextjs': 'next',
  'next.js': 'next',
  'next-js': 'next',
  'sveltekit': 'svelte',
  'svelte-kit': 'svelte',
  'vue': 'vue-cli',
  'vuejs': 'vue-cli',
  'vue.js': 'vue-cli',
  'vite-react': 'vite',
  'vite-vue': 'vite',
  'vite-svelte': 'vite',
  'react': 'vite',
  'react-ts': 'vite',
  'go': 'golang',
  'spring': 'spring-boot',
  'springboot': 'spring-boot',
  'net': 'dotnet',
  '.net': 'dotnet',
  'asp.net': 'dotnet',
  'aspnet': 'dotnet',
  'nest': 'nestjs',
  'create-react-app': 'cra',
};

// ── Shared exec helper ──

// Exit-code-based error detection; stderr is merged into output (git/npm write
// progress to stderr even on success).
function execTool(
  command: string,
  args: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<{ success: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    const child = execFileCb(
      command,
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        timeout: opts.timeoutMs || 60_000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const output = [stdout, stderr].filter(Boolean).join('\n').trim();

        if (err) {
          const killed = (err as any).killed as boolean | undefined;
          const code = (err as NodeJS.ErrnoException).code;
          if (killed || code === 'ETIMEDOUT') {
            resolve({ success: false, output, error: 'Command timed out' });
          } else {
            resolve({ success: false, output, error: output || err.message });
          }
          return;
        }

        resolve({ success: true, output });
      },
    );

    // Close stdin to prevent TTY hang for interactive CLIs.
    child.stdin?.end();
  });
}

// ── file-api client ──
// install_deps is a thin client of file-api's Install Manager. No local install
// subprocess / fallback — Manager is the single authoritative owner across every
// caller (scaffold hook, preview, MCP, UI). Bypass would revive the 2026-04-21 race.

async function callFileApiInstall(
  routePath: string,
  init: { method: 'POST' | 'GET' | 'DELETE'; body?: Record<string, unknown> } = { method: 'POST' },
): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const jwt = createInternalJwt();
  if (!jwt) throw new Error('internal JWT secret unavailable');
  const url = `http://localhost:${FILE_API_PORT}${routePath}`;
  const headers: Record<string, string> = { 'Authorization': `Bearer ${jwt}` };
  let bodyStr: string | undefined;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyStr = JSON.stringify(init.body);
  }
  const resp = await fetch(url, {
    method: init.method,
    headers,
    body: bodyStr,
    signal: AbortSignal.timeout(10_000),
  });
  let body: Record<string, unknown> = {};
  try { body = await resp.json() as Record<string, unknown>; } catch {}
  return { ok: resp.ok, status: resp.status, body };
}

// Short-lived internal JWT for file-api; inlined (not from main.ts) to avoid import cycle.
function createInternalJwt(): string | null {
  const secret = getJwtSecret();
  if (!secret) return null;
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    purpose: 'internal',
    svc: 'agent-bridge',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 30,
  })).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

// ── Result builders ──

function buildToolDef(
  name: string,
  description: string,
  capability: string,
  inputSchema: Record<string, unknown>,
): GovernedToolDefinition {
  return {
    name,
    description,
    inputSchema,
    outputSchema: null,
    provider: {
      providerId: BUILTIN_CONNECTION_ID,
      providerType: 'builtin' as 'mcp',
      endpoint: '',
      transport: 'stdio' as const,
      tlsFingerprint: null,
      manifestFingerprint: null,
      toolListHash: '',
    },
    capability: capability as GovernedToolDefinition['capability'],
    lifecycleStatus: 'approved',
    exposureStatus: 'agent_visible',
    definitionHash: createHash('sha256').update(`${name}:platform-tool`).digest('hex'),
    discoveredAt: new Date().toISOString(),
    classifiedAt: new Date().toISOString(),
    taxonomyVersion: TAXONOMY_VERSION,
  };
}

function successResult(output: unknown, durationMs: number): ToolCallResult {
  return {
    status: 'success',
    output,
    durationMs,
    artifactId: createHash('sha256').update(`platform:${Date.now()}`).digest('hex'),
    providerId: BUILTIN_CONNECTION_ID,
  };
}

function errorResult(code: string, message: string, retryable = false): ToolCallResult {
  return {
    status: 'error',
    errorCode: code,
    message,
    retryable,
    providerId: BUILTIN_CONNECTION_ID,
  };
}

// ── scaffold_project ──
//
// ALWAYS nested: the scaffold lands in `sandbox/<project>/` — one app in one
// subfolder, same shape you'd get from `git clone <url>` inside the sandbox.
// Default behavior = single project per sandbox = one subfolder, matching the
// user's "default to a single project, don't make a monorepo" rule.
//
// If the sandbox already contains an app (target subfolder OR any other app
// subfolder), the tool returns ALREADY_SCAFFOLDED with a clear message so the
// agent does NOT retry with a different name. Retrying creates stray
// my-app-1 / my-app-2 dirs that look like an accidental monorepo — which is
// exactly what the user complained about.

/** Shape check for an app subfolder name. */
const APP_SUBDIR_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Markers that signal "a project lives here" (any framework). */
const PROJECT_MARKERS = [
  'package.json', 'requirements.txt', 'pyproject.toml', 'Cargo.toml',
  'go.mod', 'Gemfile', 'composer.json', 'mix.exs', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'Package.swift',
] as const;

function sanitizeProjectName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 63);
}

/** Return the names of any direct-child subfolders that look like an app. */
/**
 * Read the user's preferred locale from /etc/ellul/user-locale (the
 * system-wide source of truth maintained by the enforcer's locale
 * reconciler — see Phase 7a-NATIVE Layer 3). Falls back to
 * DEFAULT_LOCALE on missing/corrupt file or unsupported value.
 *
 * Used by the scaffolder to decide which agent context variant to
 * land and to record createdLocale in .ellul/project.json.
 */
function readUserLocale(): Locale {
  for (const p of ['/etc/ellul/shield-data/user-locale', '/etc/ellul/user-locale']) {
    try {
      const raw = fs.readFileSync(p, 'utf8').trim();
      if (isLocale(raw)) return raw;
    } catch {}
  }
  return DEFAULT_LOCALE;
}

function listExistingAppSubdirs(sandboxDir: string): string[] {
  try {
    return fs.readdirSync(sandboxDir).filter((name) => {
      if (name.startsWith('.')) return false;
      try {
        const sub = path.join(sandboxDir, name);
        if (!fs.statSync(sub).isDirectory()) return false;
        return PROJECT_MARKERS.some((m) => fs.existsSync(path.join(sub, m)));
      } catch { return false; }
    });
  } catch { return []; }
}

interface PackageScaffoldOutcome {
  project: string;
  framework: string;
  success: boolean;
  directory?: string;
  error?: string;
}

// All-or-report batch: one leaf fails but others still commit. Each leaf is
// atomic (scratch dir + rename) via scaffoldPackageIntoMonorepo.
async function batchScaffoldPackagesIntoMonorepo(args: {
  sandboxId: string;
  sandboxDir: string;
  monorepoAppRoot: string;
  monorepoAppSubdir: string;
  layout: WorkspaceLayout;
  packages: Array<{ framework: string; project: string }>;
}): Promise<PackageScaffoldOutcome[]> {
  const results: PackageScaffoldOutcome[] = [];
  for (const pkg of args.packages) {
    const pkgFwId = FRAMEWORK_ALIASES[pkg.framework.toLowerCase()] || pkg.framework;
    const pkgFw = getFrameworkById(pkgFwId);
    if (!pkgFw || !pkgFw.scaffold) {
      results.push({
        project: pkg.project,
        framework: pkg.framework,
        success: false,
        error: `Unknown framework "${pkg.framework}". Available: ${SCAFFOLDABLE_FRAMEWORK_IDS.join(', ')}`,
      });
      continue;
    }
    if (pkgFw.scaffoldKind === 'monorepo') {
      results.push({
        project: pkg.project,
        framework: pkg.framework,
        success: false,
        error: `Cannot nest monorepo framework "${pkg.framework}" inside a monorepo. Use a leaf framework (next, hono, vite, express, etc).`,
      });
      continue;
    }
    const pkgSlug = sanitizeProjectName(pkg.project) || pkg.project;
    if (!APP_SUBDIR_RE.test(pkgSlug)) {
      results.push({
        project: pkg.project,
        framework: pkg.framework,
        success: false,
        error: `Cannot derive a safe package name from "${pkg.project}".`,
      });
      continue;
    }
    const result = await scaffoldPackageIntoMonorepo({
      sandboxId: args.sandboxId,
      sandboxDir: args.sandboxDir,
      monorepoAppRoot: args.monorepoAppRoot,
      monorepoAppSubdir: args.monorepoAppSubdir,
      layout: args.layout,
      fw: pkgFw,
      projectNameSlug: pkgSlug,
    });
    if (result.status === 'success') {
      const out = result.output as Record<string, unknown>;
      results.push({
        project: pkgSlug,
        framework: pkgFw.id,
        success: true,
        directory: out.directory as string | undefined,
      });
    } else if (result.status === 'error') {
      results.push({
        project: pkgSlug,
        framework: pkgFw.id,
        success: false,
        error: result.message,
      });
    }
  }
  return results;
}

async function handleScaffoldProject(
  args: Record<string, unknown>,
  context: ToolCallContext,
): Promise<ToolCallResult> {
  const start = Date.now();

  // Framework resolution — default to Next.js.
  const frameworkId = (args.framework as string | undefined) || 'next';
  const resolvedId = FRAMEWORK_ALIASES[frameworkId.toLowerCase()] || frameworkId;
  const fw = getFrameworkById(resolvedId);
  if (!fw || !fw.scaffold) {
    return errorResult(
      'UNKNOWN_FRAMEWORK',
      `Unknown framework "${frameworkId}". Use one of: ${SCAFFOLDABLE_FRAMEWORK_IDS.join(', ')}`,
    );
  }

  if (!context.sandboxId) {
    return errorResult(
      'INVALID_CONTEXT',
      'scaffold_project requires an active sandbox — no sandboxId in tool call context',
    );
  }
  if (!isSandboxId(context.sandboxId)) {
    return errorResult('INVALID_CONTEXT', `Malformed sandboxId: ${context.sandboxId}`);
  }
  const sandboxDir = path.join(PROJECTS_DIR, context.sandboxId);
  if (!fs.existsSync(sandboxDir)) {
    return errorResult(
      'SANDBOX_NOT_FOUND',
      `Sandbox directory not found: ${sandboxDir}. This is a provisioning bug — the sandbox should exist before tool calls are dispatched.`,
    );
  }

  // Resolve the project subfolder name. Defaults to "my-app" if the caller
  // didn't supply one. We always scaffold into a subfolder — never into the
  // sandbox root — so the layout matches `git clone <url>`.
  const rawProjectName = (args.project as string | undefined) ?? 'my-app';
  const projectNameSlug = sanitizeProjectName(rawProjectName) || 'my-app';
  if (!APP_SUBDIR_RE.test(projectNameSlug)) {
    return errorResult('INVALID_PROJECT_NAME', `Cannot derive a safe app folder name from "${rawProjectName}".`);
  }
  const target = path.join(sandboxDir, projectNameSlug);

  // Three-case branch on sandbox state:
  //
  //   1. Empty sandbox — scaffold creates the sandbox's first and only app.
  //      Falls through to the existing atomic scaffold flow below.
  //
  //   2. Sandbox has one existing app AND that app is a monorepo — scaffold
  //      adds a new PACKAGE inside the monorepo's workspaces glob (e.g.
  //      `sbx-xyz/my-turbo/apps/marketing-dashboard/`). Shared git repo,
  //      install runs at monorepo root, concurrent scaffolds serialised
  //      via flock.
  //
  //   3. Sandbox has one standalone app (non-monorepo) — refuse with
  //      ALREADY_SCAFFOLDED. Tell the user to modify the existing app or
  //      create a new sandbox. Retrying with a different name would
  //      create an accidental monorepo which is exactly what the one-app
  //      rule is meant to prevent.
  const existingAppSubdirs = listExistingAppSubdirs(sandboxDir);
  if (existingAppSubdirs.length > 0) {
    // Pick the first (and usually only) app subfolder as the candidate
    // monorepo root. Multi-app sandboxes are out-of-contract anyway.
    const appSubdir = existingAppSubdirs[0]!;
    const appRoot = path.join(sandboxDir, appSubdir);

    // Is the existing app a monorepo? Detect via the shared workspace-layout
    // resolver — parses package.json.workspaces / pnpm-workspace.yaml /
    // lerna.json strictly. Throws WorkspaceConfigError when a config file
    // exists but is malformed; we surface that as a distinct error kind so
    // the agent can tell the user to fix their config instead of hitting a
    // misleading ALREADY_SCAFFOLDED.
    let layout: WorkspaceLayout | null;
    try {
      layout = resolveWorkspaceLayout(appRoot);
    } catch (err) {
      if (err instanceof WorkspaceConfigError) {
        return errorResult(
          'WORKSPACE_CONFIG_INVALID',
          `Workspace config in ${appSubdir}/${err.configFile} is invalid: ${err.reason}. ` +
          `Tell the user their ${err.configFile} needs to be fixed before scaffolding can proceed.`,
        );
      }
      throw err;
    }
    if (layout) {
      // ── EXISTING MONOREPO + PACKAGES[] — batch-add leaves ─────────
      // Same atomic batch shape as the "new turbo + packages" path
      // below. Lets the caller request multiple leaves in one tool
      // call rather than chaining N calls. Used by the bridge's
      // batch helper to resolve "add a next frontend and a
      // hono backend" in a single pass against an already-scaffolded
      // monorepo.
      const packagesForExisting = args.packages as Array<{ framework: string; project: string }> | undefined;
      if (packagesForExisting && packagesForExisting.length > 0) {
        const batchResults = await batchScaffoldPackagesIntoMonorepo({
          sandboxId: context.sandboxId,
          sandboxDir,
          monorepoAppRoot: appRoot,
          monorepoAppSubdir: appSubdir,
          layout,
          packages: packagesForExisting,
        });
        const succeeded = batchResults.filter((r) => r.success);
        const failed = batchResults.filter((r) => !r.success);
        return successResult(
          {
            success: failed.length === 0,
            mode: 'monorepo-add-packages' as const,
            directory: `${context.sandboxId}/${appSubdir}`,
            sandboxId: context.sandboxId,
            appSubdir,
            packages: batchResults,
            nextSteps: [
              `Added ${succeeded.length}/${packagesForExisting.length} package(s) to ${appSubdir}/.`,
              ...succeeded.map((r) => `  ✓ ${r.framework} → ${r.directory}`),
              ...failed.map((r) => `  ✗ ${r.framework}/${r.project}: ${r.error}`),
              `Call install_deps at the monorepo root to hoist all dependencies in one pass.`,
            ],
          },
          Date.now() - start,
        );
      }

      // Refuse to nest a monorepo framework inside another monorepo. A turbo
      // (or other workspace) scaffold inside an existing turbo monorepo
      // produces broken nested-workspace state — two competing root
      // package.json files, ambiguous workspaces globs, recursive
      // node_modules hoisting. Almost always means the agent re-issued
      // the workspace-creation step instead of moving on to packages.
      if (fw.scaffoldKind === 'monorepo') {
        return errorResult(
          'MONOREPO_ALREADY_EXISTS',
          `Sandbox "${context.sandboxId}" already has a monorepo at "${appSubdir}". ` +
          `Do NOT scaffold another workspace framework (${fw.id}) inside it — call ` +
          `scaffold_project with a leaf framework like "next", "hono", or "vite" ` +
          `and a domain name like "web" or "api" to add a package instead.`,
        );
      }
      return scaffoldPackageIntoMonorepo({
        sandboxId: context.sandboxId,
        sandboxDir,
        monorepoAppRoot: appRoot,
        monorepoAppSubdir: appSubdir,
        layout,
        fw,
        projectNameSlug,
      });
    }

    // Non-monorepo standalone app — refuse.
    return errorResult(
      'ALREADY_SCAFFOLDED',
      `Sandbox "${context.sandboxId}" already has a standalone app at "${appSubdir}"` +
        (existingAppSubdirs.length > 1 ? ` (plus ${existingAppSubdirs.length - 1} more)` : '') +
        `. Scaffolding a second project would create an accidental monorepo. Tell the user the sandbox is in use and ask whether they want to modify the existing app or create a new sandbox for the new project. Do NOT retry with a different project name.`,
    );
  }
  if (fs.existsSync(target)) {
    return errorResult(
      'ALREADY_SCAFFOLDED',
      `Sandbox "${context.sandboxId}" already has an app at "${projectNameSlug}". Tell the user the sandbox is in use — do NOT retry with a different name.`,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // ATOMIC SCAFFOLD — the contract is strict:
  //
  //   • All build work happens inside a hidden scratch CONTAINER
  //     (`.scaffold-tmp-<hex>/<projectSlug>/`) at the sandbox root.
  //     The container name is a dotfile so the in-flight scaffold is
  //     invisible to the UI and to `detectApps`. The inner dir's
  //     basename is `projectSlug` — a valid npm package name — so
  //     `create-next-app` can use `basename(cwd)` without tripping
  //     npm's "name cannot start with a period" check. This two-level
  //     layout is the fix for `SCAFFOLD_FAILED: Could not create a
  //     project called ".scaffold-tmp-..."` that burned us on v61.
  //
  //   • Every failure path cleans up the container before returning
  //     an error. We never ship "kind of scaffolded" and let the user
  //     debug why `next dev` fails — if we don't come back with a
  //     working app we come back with nothing.
  //
  //   • `npm install` is retried with a clean slate if the first
  //     attempt succeeds on exit code but produces an incomplete
  //     `node_modules/` (missing the framework's `.bin/*` symlink).
  //     That's the real-world failure mode we saw on ARM: scaffold
  //     CLI says OK, `node_modules` exists, but `.bin/next` doesn't.
  //
  //   • Only after every gate passes do we rename the inner dir into
  //     the final `target` path (single `rename(2)`, atomic on the
  //     same filesystem — guaranteed because both live inside the
  //     sandbox root).
  // ────────────────────────────────────────────────────────────────────
  const scratchContainerName = `.scaffold-tmp-${randomBytes(4).toString('hex')}`;
  const scratchContainer = path.join(sandboxDir, scratchContainerName);
  // The inner dir is the one the scaffold CLI actually runs in. Named
  // after the final project slug so `path.basename(cwd)` is a legal
  // npm package name. npm explicitly rejects names starting with `.`
  // or `_`, so we cannot scaffold directly inside the dotfile container.
  const scratchWork = path.join(scratchContainer, projectNameSlug);
  try {
    fs.mkdirSync(scratchContainer, { recursive: false });
    fs.mkdirSync(scratchWork, { recursive: false });
  } catch (err) {
    try { fs.rmSync(scratchContainer, { recursive: true, force: true }); } catch { /* best effort */ }
    return errorResult('SCRATCH_MKDIR_FAILED', `Could not create scaffold scratch dir: ${(err as Error).message}`);
  }

  const cleanupScratch = () => {
    try { fs.rmSync(scratchContainer, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  console.log(`${LOG_PREFIX} Scaffolding ${fw.id} (${fw.stackLabel}) → ${target} (scratch=${scratchContainerName}/${projectNameSlug})`);

  // Runtime install happens at preview time (startPreview), not here.
  // Scaffold is file-only and fast. Non-Node frameworks that need a
  // runtime binary (dotnet, go, cargo) skip the CLI scaffold if the
  // binary is absent — the scaffold writes a minimal file set instead,
  // and the runtime installs when the user clicks preview.

  try {
    // ── 1. Hydrate the template tree into the scratch work dir. ──────
    //       Trees are shipped embedded in the bundle (see
    //       templates/scaffold/tree-manifest.generated.ts). No CLI
    //       invocations, no `npm install` during scaffold, no network:
    //       hydration is a deterministic file walk with
    //       `{{PROJECT_NAME}}` substitution.
    //
    //       Runtime installs (Tailwind for Node frameworks, gems for
    //       Ruby, crates for Rust, …) happen at preview-start time via
    //       preview.service, where they can be reported through the
    //       "Installing dependencies…" banner.
    try {
      hydrateTemplate({
        templateId: fw.scaffold.template,
        targetDir: scratchWork,
        projectName: projectNameSlug,
      });
    } catch (err) {
      throw new ScaffoldAbort(
        'SCAFFOLD_FAILED',
        `${fw.stackLabel} template hydration failed: ${(err as Error).message}`,
      );
    }

    // ── 2. Manifest sanity — every Node scaffold must leave a package.json.
    if (fw.runtime === 'node' && !fs.existsSync(path.join(scratchWork, 'package.json'))) {
      throw new ScaffoldAbort(
        'SCAFFOLD_FAILED',
        `${fw.stackLabel} template hydrated but produced no package.json — template "${fw.scaffold.template}" is incomplete. This is a registry bug.`,
      );
    }

    // ── 3. Final sanity check — every scaffolded app needs a readable
    //       package.json (or equivalent manifest). If JSON.parse fails
    //       we refuse to commit the scaffold.
    const manifestPath = path.join(scratchWork, 'package.json');
    if (fs.existsSync(manifestPath)) {
      try {
        JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (e) {
        throw new ScaffoldAbort('INVALID_MANIFEST', `package.json is not valid JSON: ${(e as Error).message}`);
      }
    }

    // ── 5. Write per-app ellul.json INSIDE the scratch work dir so
    //       the rename below commits the metadata atomically alongside
    //       the scaffolded files.
    try {
      const metaPath = path.join(scratchWork, 'ellul.json');
      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
      // Honor the framework's declared scaffold shape — monorepo roots
      // are non-previewable, frontend/backend frameworks are.
      const kind = fw.scaffoldKind ?? deriveScaffoldKind(fw);
      const previewable = fw.scaffoldPreviewable ?? true;
      const merged = {
        ...existing,
        displayName: projectNameSlug,
        type: kind,
        previewable,
        origin: 'scaffold' as const,
        framework: fw.id,
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(metaPath, JSON.stringify(merged, null, 2));
    } catch (err) {
      throw new ScaffoldAbort('METADATA_WRITE_FAILED', `Failed to write app ellul.json: ${(err as Error).message}`);
    }

    // ── 5b. Write .ellul/preview.json with the canonical preview spec.
    //       The agent owns this file; the platform reads it deterministically
    //       (no framework detection at preview-start). Port is a placeholder —
    //       file-api reconciles it to the allocated port on first startPreview.
    //       Monorepo roots aren't previewable so skip them.
    if ((fw.scaffoldPreviewable ?? true) && fw.scaffoldKind !== 'monorepo') {
      try {
        const spec = defaultSpecForFramework(fw, PREVIEW_PORT_MIN, scratchWork);
        writeSpec(scratchWork, spec);
      } catch (err) {
        throw new ScaffoldAbort('METADATA_WRITE_FAILED', `Failed to write preview.json: ${(err as Error).message}`);
      }
    }

    // ── 5c. Write per-locale agent context files + .ellul/project.json
    //       (Phase 7a-NATIVE Layer 2). Reads /etc/ellul/user-locale —
    //       the system source of truth maintained by the enforcer's
    //       locale reconciler. Records createdLocale on the project so
    //       Layer 6's mismatch banner can detect later toggles without
    //       re-parsing context files.
    //
    //       These files are user-owned post-scaffold; locale toggles do
    //       NOT auto-rewrite them. The mismatch banner (Layer 4/6) is
    //       the explicit surface that nudges the user to rewrite them
    //       at their own pace.
    try {
      const createdLocale = readUserLocale();
      const ctxFiles = getAgentContextFiles(createdLocale);
      for (const [relPath, contents] of Object.entries(ctxFiles)) {
        const full = path.join(scratchWork, relPath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        // Don't overwrite a file the framework template already shipped
        // (some frameworks come with their own AGENTS.md / CLAUDE.md).
        if (fs.existsSync(full)) continue;
        fs.writeFileSync(full, contents);
      }
      const projectMetaDir = path.join(scratchWork, '.ellul');
      fs.mkdirSync(projectMetaDir, { recursive: true });
      const projectMetaPath = path.join(projectMetaDir, 'project.json');
      const projectMeta = {
        createdLocale,
        welcomeShownAt: null as string | null,
      };
      fs.writeFileSync(projectMetaPath, JSON.stringify(projectMeta, null, 2));
    } catch (err) {
      throw new ScaffoldAbort(
        'METADATA_WRITE_FAILED',
        `Failed to write agent context / .ellul/project.json: ${(err as Error).message}`,
      );
    }

    // ── 6. Initialise git inside the scratch work dir so the rename
    //       brings a ready-to-commit repo across with it. Skip if the
    //       scaffold CLI already created a `.git/` (create-next-app does).
    if (!fs.existsSync(path.join(scratchWork, '.git'))) {
      const gitResult = await execTool('bash', [
        '-c',
        `git init -b main && ` +
        `git config --local user.name sandbox && ` +
        `git config --local user.email sandbox@ellul.ai && ` +
        `git add -A && ` +
        `git commit -m 'Initial scaffold' || true`,
      ], { cwd: scratchWork, timeoutMs: 30_000 });
      if (!gitResult.success) {
        // git init failure is non-fatal — the app still works, the user
        // can init later. Log and carry on rather than trashing the scaffold.
        console.warn(`${LOG_PREFIX} git init failed (non-fatal):`, gitResult.error);
      }
    }

    // ── 7. Final race check, then ATOMIC COMMIT via rename(2) ─────────
    // Another in-flight scaffold (or a racing file write) could have
    // created `target` while we were building. If so, abort rather
    // than clobber. Same sandbox → same filesystem → rename is atomic.
    // We rename the INNER work dir to `target`, leaving the outer
    // `.scaffold-tmp-*` container empty, then rmdir it below.
    if (fs.existsSync(target)) {
      throw new ScaffoldAbort('ALREADY_SCAFFOLDED',
        `Target ${target} appeared during scaffold — another scaffold completed in parallel.`);
    }
    try {
      fs.renameSync(scratchWork, target);
    } catch (err) {
      throw new ScaffoldAbort('COMMIT_FAILED', `Atomic rename failed: ${(err as Error).message}`);
    }

    // Cleanup the (now-empty) scratch container. If rmdir fails — e.g.
    // a file watcher is holding a handle — fall through to the outer
    // `cleanupScratch` via the finally path below on the next reconcile.
    try { fs.rmdirSync(scratchContainer); } catch { /* orphan swept on reconcile */ }
  } catch (err) {
    cleanupScratch();
    if (err instanceof ScaffoldAbort) {
      return errorResult(err.code, err.message);
    }
    return errorResult('SCAFFOLD_FAILED', (err as Error).message || 'unknown scaffold failure');
  }

  // ── Post-commit side effects on the SANDBOX itself (not rollback-safe
  // but the scaffold is already live so partial failures here are
  // cosmetic — log and proceed). ──
  try {
    const sandboxMetaPath = path.join(sandboxDir, 'ellul.json');
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(fs.readFileSync(sandboxMetaPath, 'utf8')); } catch {}
    meta.activeApp = projectNameSlug;
    fs.writeFileSync(sandboxMetaPath, JSON.stringify(meta, null, 2));
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to update sandbox activeApp:`, (err as Error).message);
  }

  // Drop `.zeroclaw/` inside the newly-scaffolded app folder and add it to
  // `.gitignore` so the agent workspace doesn't pollute the user's commits.
  // Scaffolds always have their own `.gitignore` (written by the CLI or by
  // our bootstrap); `ensureAppGitignore` appends to it rather than creating
  // a `.git/info/exclude` entry.
  try {
    writeZeroClawWorkspace(target, projectNameSlug);
    ensureAppGitignore(target);
  } catch (err) {
    console.warn(`${LOG_PREFIX} Failed to seed .zeroclaw/ or update .gitignore:`, (err as Error).message);
  }

  // Relabel any pre-scaffold threads from the sandbox slug to the new
  // Threads are scoped to the sandbox, not to any app inside it — scaffolding
  // a new app in the sandbox does not change where its chat history lives.
  // `createThread` and `listThreads` both canonicalize to the sandbox slug,
  // so the pre-scaffold thread list and the post-scaffold thread list
  // resolve to the same SQL row set. No relabel and no UI re-target needed.

  // MCP configs + namespace + CLI context files. Fire-and-forget — scaffold
  // must not block on namespace setup.
  ensureProject(context.sandboxId).catch((err) => {
    console.warn(`${LOG_PREFIX} ensureProject failed post-scaffold:`, (err as Error).message);
  });

  // Scaffold writes files — nothing else. No preview activation, no
  // install. The agent sequences: scaffold all packages → install_deps
  // → the UI activates the preview when the user clicks it. Triggering
  // preview here caused install to run before monorepo packages existed,
  // resulting in partial installs (only root deps, not workspace packages).

  // ── MONOREPO ATOMIC PACKAGE SCAFFOLD ──────────────────────────────
  // When the caller passes `packages` with a monorepo root scaffold, we
  // scaffold every leaf package here — same tool call, same response.
  // The agent gets one result with every package's outcome. No multi-call
  // sequencing, no chance to stop halfway.
  const isMonorepoRoot = fw.scaffoldKind === 'monorepo';
  const packagesArg = args.packages as Array<{ framework: string; project: string }> | undefined;

  if (isMonorepoRoot && packagesArg && packagesArg.length > 0) {
    // Resolve the monorepo's workspace layout from the just-committed root.
    let layout: WorkspaceLayout | null;
    try {
      layout = resolveWorkspaceLayout(target);
    } catch (err) {
      if (err instanceof WorkspaceConfigError) {
        return errorResult(
          'WORKSPACE_CONFIG_INVALID',
          `Just-scaffolded monorepo at ${projectNameSlug} has invalid workspace config: ${err.reason}`,
        );
      }
      throw err;
    }
    if (!layout) {
      return errorResult(
        'WORKSPACE_CONFIG_INVALID',
        `Scaffolded monorepo at ${projectNameSlug} has no detectable workspace layout — turbo scaffold may have failed silently.`,
      );
    }

    const packageResults = await batchScaffoldPackagesIntoMonorepo({
      sandboxId: context.sandboxId,
      sandboxDir,
      monorepoAppRoot: target,
      monorepoAppSubdir: projectNameSlug,
      layout,
      packages: packagesArg,
    });

    const succeeded = packageResults.filter((r) => r.success);
    const failed = packageResults.filter((r) => !r.success);

    const nextSteps = [
      `Monorepo scaffolded at ${context.sandboxId}/${projectNameSlug}/ with ${succeeded.length}/${packagesArg.length} packages.`,
      ...succeeded.map((r) => `  ✓ ${r.framework} → ${r.directory}`),
      ...failed.map((r) => `  ✗ ${r.framework}/${r.project}: ${r.error}`),
      `Call install_deps to install all dependencies at the monorepo root before previewing.`,
    ];

    return successResult(
      {
        success: failed.length === 0,
        framework: fw.id,
        stackLabel: fw.stackLabel,
        mode: 'monorepo-root' as const,
        directory: `${context.sandboxId}/${projectNameSlug}`,
        sandboxId: context.sandboxId,
        appSubdir: projectNameSlug,
        packages: packageResults,
        nextSteps,
      },
      Date.now() - start,
    );
  }

  const nextSteps = isMonorepoRoot
    ? [
        `MONOREPO ready at ${context.sandboxId}/${projectNameSlug}/. apps/ and packages/ are intentionally empty.`,
        `For each leaf: try \`scaffold_project\` first — if the framework is in the catalog, it lands a working template at ${projectNameSlug}/apps/<slug>/. Hand-roll with shell only when the framework isn't catalogued, and even then land the new project inside apps/ or packages/ — never as a sibling of apps/ at the monorepo root.`,
        `Example for "monorepo with a Next frontend and a Hono API":`,
        `  scaffold_project({framework:"next", project:"web"})`,
        `  scaffold_project({framework:"hono", project:"api"})`,
        `Stop after the user's requested packages exist — do not invent extras.`,
        `DO NOT call scaffold_project with framework="${fw.id}" again — that would nest monorepos and is blocked with MONOREPO_ALREADY_EXISTS.`,
        `TIP: You can also pass all packages in one call: scaffold_project({framework:"turbo", project:"monorepo", packages:[{framework:"next",project:"web"},{framework:"hono",project:"api"}]})`,
      ]
    : fw.runtimeCheck
    ? [
        `App scaffolded at ${context.sandboxId}/${projectNameSlug}/.`,
        `${fw.stackLabel} runtime will install automatically the first time you click Preview (one-time setup, requires internet).`,
        `Tell the user: "${fw.stackLabel} project created. The ${fw.runtimeCheck} runtime will install automatically when you open the preview — this is a one-time setup."`,
      ]
    : [
        `App scaffolded at ${context.sandboxId}/${projectNameSlug}/.`,
      ];

  return successResult(
    {
      success: true,
      framework: fw.id,
      stackLabel: fw.stackLabel,
      mode: isMonorepoRoot ? 'monorepo-root' as const : 'standalone' as const,
      directory: `${context.sandboxId}/${projectNameSlug}`,
      sandboxId: context.sandboxId,
      appSubdir: projectNameSlug,
      nextSteps,
    },
    Date.now() - start,
  );
}

// triggerPreviewActivation removed — scaffold no longer triggers preview.
// Preview starts when the user clicks it in the UI. Install runs on demand.

// Marker for expected scaffold failures (known codes) vs unexpected exceptions.
class ScaffoldAbort extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'ScaffoldAbort';
  }
}

// Atomic (scratch container + rename) FS-only scaffold into a monorepo package dir.
// No flock, no install here — install runs at preview time at the monorepo root
// to avoid lockfile races and double-install across concurrent scaffold_project calls.
async function scaffoldPackageIntoMonorepo(params: {
  sandboxId: string;
  sandboxDir: string;
  monorepoAppRoot: string;
  monorepoAppSubdir: string;
  layout: WorkspaceLayout;
  fw: NonNullable<ReturnType<typeof getFrameworkById>>;
  projectNameSlug: string;
}): Promise<ToolCallResult> {
  const monorepoScaffoldStart = Date.now();
  const { sandboxId, monorepoAppRoot, monorepoAppSubdir, layout, fw, projectNameSlug } = params;

  const nodeConfigFiles = new Set(['package.json', 'pnpm-workspace.yaml', 'lerna.json', 'nx.json']);
  if (!nodeConfigFiles.has(layout.configFile)) {
    return errorResult('UNSUPPORTED_WORKSPACE',
      `Adding packages to a ${layout.configFile} workspace is not supported via scaffold. ` +
      `Create the package manually in your ${layout.configFile.replace(/\.[^.]+$/, '')} workspace.`);
  }

  const packagesDir = layout.defaultPackagesDir;
  const packagesDirAbs = path.join(monorepoAppRoot, packagesDir);
  const target = path.join(packagesDirAbs, projectNameSlug);

  // Ensure the packages dir exists. Throws on failure — no silent fallback.
  try {
    fs.mkdirSync(packagesDirAbs, { recursive: true });
  } catch (err) {
    return errorResult('PACKAGES_DIR_MKDIR_FAILED',
      `Could not create packages dir ${packagesDir}/: ${(err as Error).message}`);
  }

  // Pre-flight: slug already taken? Distinct error kind from ALREADY_SCAFFOLDED
  // so the agent knows retrying with a different slug is OK inside a monorepo.
  if (fs.existsSync(target)) {
    return errorResult('PACKAGE_EXISTS',
      `Monorepo "${monorepoAppSubdir}" already has a package at "${packagesDir}/${projectNameSlug}". ` +
      `Pick a different package name and retry.`);
  }

  // Scratch container inside packagesDir so rename(2) stays same-filesystem.
  // Name is a dotfile so in-flight scaffolds don't clutter the package list.
  const scratchContainerName = `.scaffold-tmp-${randomBytes(4).toString('hex')}`;
  const scratchContainer = path.join(packagesDirAbs, scratchContainerName);
  const scratchWork = path.join(scratchContainer, projectNameSlug);

  const cleanupScratch = () => {
    try { fs.rmSync(scratchContainer, { recursive: true, force: true }); } catch {}
  };

  try {
    fs.mkdirSync(scratchContainer, { recursive: false });
    fs.mkdirSync(scratchWork, { recursive: false });
  } catch (err) {
    cleanupScratch();
    return errorResult('SCRATCH_MKDIR_FAILED',
      `Could not create package scaffold scratch dir: ${(err as Error).message}`);
  }

  console.log(`${LOG_PREFIX} Scaffolding ${fw.id} package → ${target} (monorepo ${monorepoAppSubdir})`);

  // Runtime install happens at preview time, not here. Scaffold is fast.

  try {
    // ── 1. Hydrate the template tree into scratch. ───────────────────
    //       Same hydrator as the top-level scaffold path — templates
    //       are just files, adding a leaf to a monorepo is a plain
    //       copy into `apps/<name>/` or `packages/<name>/`.
    try {
      hydrateTemplate({
        templateId: fw.scaffold!.template,
        targetDir: scratchWork,
        projectName: projectNameSlug,
      });
    } catch (err) {
      throw new ScaffoldAbort(
        'SCAFFOLD_FAILED',
        `${fw.stackLabel} template hydration failed: ${(err as Error).message}`,
      );
    }

    // ── 2. Strip any package-local `node_modules/` or nested `.git/`
    //       that could have slipped in (defensive — trees don't ship
    //       either, but the check guards against future tree edits).
    //       The monorepo shares ONE git repo at the workspace root,
    //       and dependencies hoist to the root node_modules via the
    //       workspace install at preview time.
    try { fs.rmSync(path.join(scratchWork, '.git'), { recursive: true, force: true }); } catch {}
    try { fs.rmSync(path.join(scratchWork, 'node_modules'), { recursive: true, force: true }); } catch {}
    try { fs.rmSync(path.join(scratchWork, 'package-lock.json'), { force: true }); } catch {}

    // ── 3. Manifest validity check. The template must supply a
    //       package.json for Node runtimes — template-authoring bug
    //       if missing.
    const manifestPath = path.join(scratchWork, 'package.json');
    if (fw.runtime === 'node' && !fs.existsSync(manifestPath)) {
      throw new ScaffoldAbort(
        'SCAFFOLD_FAILED',
        `${fw.stackLabel} template hydrated but produced no package.json — template "${fw.scaffold!.template}" is incomplete. This is a registry bug.`,
      );
    }
    if (fs.existsSync(manifestPath)) {
      try {
        JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (e) {
        throw new ScaffoldAbort('INVALID_MANIFEST', `package.json is not valid JSON: ${(e as Error).message}`);
      }
    }

    // ── 6. Write per-package ellul.json inside scratch ─────────────
    try {
      const metaPath = path.join(scratchWork, 'ellul.json');
      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
      // Packages inside a monorepo inherit the framework's declared shape.
      // Scaffolding `turbo` inside another monorepo doesn't make sense so
      // we just trust fw.scaffoldKind / fw.scaffoldPreviewable.
      const kind = fw.scaffoldKind ?? deriveScaffoldKind(fw);
      const previewable = fw.scaffoldPreviewable ?? true;
      const merged = {
        ...existing,
        displayName: projectNameSlug,
        type: kind,
        previewable,
        origin: 'scaffold' as const,
        framework: fw.id,
        createdAt: new Date().toISOString(),
      };
      fs.writeFileSync(metaPath, JSON.stringify(merged, null, 2));
    } catch (err) {
      throw new ScaffoldAbort('METADATA_WRITE_FAILED', `Failed to write package ellul.json: ${(err as Error).message}`);
    }

    // ── 6b. Write .ellul/preview.json for the package. file-api reconciles
    //        the port field on first startPreview — this is a placeholder.
    if ((fw.scaffoldPreviewable ?? true) && fw.scaffoldKind !== 'monorepo') {
      try {
        const spec = defaultSpecForFramework(fw, PREVIEW_PORT_MIN, scratchWork);
        writeSpec(scratchWork, spec);
      } catch (err) {
        throw new ScaffoldAbort('METADATA_WRITE_FAILED', `Failed to write package preview.json: ${(err as Error).message}`);
      }
    }

    // ── 7. Final race check, then atomic rename ─────────────────────
    if (fs.existsSync(target)) {
      throw new ScaffoldAbort('PACKAGE_EXISTS',
        `Target ${target} appeared during scaffold — another scaffold completed in parallel.`);
    }
    try {
      fs.renameSync(scratchWork, target);
    } catch (err) {
      throw new ScaffoldAbort('COMMIT_FAILED', `Atomic rename failed: ${(err as Error).message}`);
    }
    try { fs.rmdirSync(scratchContainer); } catch {}

    // ── 8. Sweep zero-byte lockfiles from the monorepo root ──────────
    // Some scaffold CLIs (notably create-next-app v15+) `touch` an empty
    // lockfile at the workspace root when probing for the workspace's
    // package manager. Empty files are not real lockfiles — they're
    // probe artifacts — but downstream package-manager detection will
    // pick the wrong PM if it trusts the file's mere existence (e.g.
    // an empty pnpm-lock.yaml on a system without pnpm). Remove any
    // zero-byte lockfile we find here so subsequent installs land on
    // the right tool.
    const ROOT_LOCKFILES = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'package-lock.json'];
    for (const lf of ROOT_LOCKFILES) {
      const lfPath = path.join(monorepoAppRoot, lf);
      try {
        if (fs.statSync(lfPath).size === 0) {
          fs.unlinkSync(lfPath);
          console.log(`${LOG_PREFIX} Removed zero-byte ${lf} at monorepo root (probe artifact)`);
        }
      } catch { /* missing file or unstattable — fine */ }
    }
  } catch (err) {
    cleanupScratch();
    if (err instanceof ScaffoldAbort) {
      return errorResult(err.code, err.message);
    }
    return errorResult('SCAFFOLD_FAILED', (err as Error).message || 'unknown scaffold failure');
  }

  // Scaffold writes files — nothing else. The agent calls install_deps
  // after all packages are scaffolded. Preview starts when the user
  // clicks it in the UI.

  // PM may be null if the monorepo lacks a packageManager field AND a
  // lockfile. The scaffold itself doesn't need PM info — the install
  // happens later in the preview lifecycle, where detectPackageManager
  // throws explicitly if the signal is still missing. Report what we
  // know; a null here surfaces as "to be detected at install time" and
  // the next install attempt fails clearly with an actionable message.
  const pmLabel = layout.packageManager ?? 'detected at install time';
  return successResult({
    success: true,
    framework: fw.id,
    stackLabel: fw.stackLabel,
    mode: 'monorepo-package' as const,
    directory: `${sandboxId}/${monorepoAppSubdir}/${packagesDir}/${projectNameSlug}`,
    sandboxId,
    monorepoAppSubdir,
    packagesDir,
    packageSlug: projectNameSlug,
    packageManager: layout.packageManager,
    nextSteps: [
      `Package committed at ${monorepoAppSubdir}/${packagesDir}/${projectNameSlug}`,
      `Preview lifecycle will run ${pmLabel} install at the monorepo root before starting the dev server.`,
    ],
  }, Date.now() - monorepoScaffoldStart);
}

// ── shared app-path resolution ──
//
// Under the nested-app model, the `project` argument to these tools can be:
//   - a sandbox slug         (sbx-xyz)         — resolves to the sandbox's single app
//   - an app directory       (sbx-xyz/my-app)  — targets that app directly
//   - a monorepo package     (sbx-xyz/my-turbo/packages/web) — targets that package
//
// Bare sandbox slugs auto-resolve only when the sandbox has exactly one installed
// app. Multi-app sandboxes require the caller to disambiguate.

interface ResolvedTarget {
  absolutePath: string;
  appDirectory: string;  // Relative to PROJECTS_DIR, e.g. "sbx-xyz/my-app"
}

function resolveProjectTarget(raw: string): { target: ResolvedTarget | null; error?: string } {
  if (!raw || typeof raw !== 'string') {
    return { target: null, error: 'project is required' };
  }

  // Traversal guard: resolve then require prefix under PROJECTS_DIR.
  const absolutePath = path.resolve(PROJECTS_DIR, raw);
  if (!absolutePath.startsWith(PROJECTS_DIR + path.sep) && absolutePath !== PROJECTS_DIR) {
    return { target: null, error: `Path traversal rejected: ${raw}` };
  }

  if (!fs.existsSync(absolutePath)) {
    return { target: null, error: `Project directory not found: ${raw}` };
  }

  const parts = raw.split('/').filter(Boolean);
  if (parts.length === 0) return { target: null, error: `Invalid project: ${raw}` };

  // Bare sandbox slug — auto-resolve if there's exactly one app subfolder.
  if (parts.length === 1 && isSandboxId(parts[0]!)) {
    const sandboxChildren = fs.readdirSync(absolutePath).filter((name) => {
      try {
        const stat = fs.statSync(path.join(absolutePath, name));
        if (!stat.isDirectory() || name.startsWith('.')) return false;
        // An "app" child is any subdir with a recognized manifest
        return fs.existsSync(path.join(absolutePath, name, 'package.json'))
          || fs.existsSync(path.join(absolutePath, name, 'requirements.txt'))
          || fs.existsSync(path.join(absolutePath, name, 'pyproject.toml'))
          || fs.existsSync(path.join(absolutePath, name, 'Cargo.toml'))
          || fs.existsSync(path.join(absolutePath, name, 'go.mod'))
          || fs.existsSync(path.join(absolutePath, name, 'Gemfile'))
          || fs.existsSync(path.join(absolutePath, name, 'composer.json'))
          || fs.existsSync(path.join(absolutePath, name, 'mix.exs'));
      } catch { return false; }
    });

    if (sandboxChildren.length === 0) {
      return { target: null, error: `Sandbox "${raw}" has no apps yet — scaffold or clone one first.` };
    }
    if (sandboxChildren.length > 1) {
      return { target: null, error: `Sandbox "${raw}" has ${sandboxChildren.length} apps — specify one like "${raw}/${sandboxChildren[0]}".` };
    }
    const onlyApp = sandboxChildren[0]!;
    return {
      target: {
        absolutePath: path.join(absolutePath, onlyApp),
        appDirectory: `${raw}/${onlyApp}`,
      },
    };
  }

  // Nested path — trust it as-is (the existence + traversal checks above cover safety).
  return { target: { absolutePath, appDirectory: raw } };
}

// ── install_deps ──
//
// Thin HTTP client for file-api's Install Manager. All language detection,
// lock acquisition, subprocess lifecycle, failure classification, and
// fingerprint-drift recovery live in install-manager.service.ts — this
// tool just hands the project directory to the Manager and returns its
// status snapshot. Fire-and-forget is preserved: the Manager spawns a
// detached subprocess and returns immediately, so the agent's turn ends
// in milliseconds regardless of how long the install actually takes.

async function handleInstallDeps(
  args: Record<string, unknown>,
  _context: ToolCallContext,
): Promise<ToolCallResult> {
  const start = Date.now();
  const { target, error } = resolveProjectTarget(args.project as string);
  if (!target) return errorResult('INVALID_INPUT', error || 'project is required');

  // Runtime binary install (dotnet/go/rust/ruby/…) is separate from
  // dependency install — the binary has to exist on PATH before any
  // language-level install can succeed. Fire it in the background; the
  // preview service will re-check on first preview click.
  const specPath = path.join(target.absolutePath, '.ellul', 'preview.json');
  if (fs.existsSync(specPath)) {
    try {
      const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
      const RUNTIME_BINS: Record<string, string> = {
        dotnet: 'dotnet', go: 'go', rust: 'cargo', ruby: 'ruby',
        php: 'php', elixir: 'elixir', java: 'java', bun: 'bun',
      };
      const bin = RUNTIME_BINS[spec.runtime];
      if (bin && spec.runtime !== 'node' && spec.runtime !== 'static') {
        try {
          execFileSync('which', [bin], { stdio: 'ignore', timeout: 3000 });
        } catch {
          console.log(`${LOG_PREFIX} Kicking off ${spec.runtime} runtime install (background)`);
          execTool('sudo', ['-n', '/usr/local/bin/ellul-install-runtime', spec.runtime], { timeoutMs: 300_000 })
            .then(r => console.log(`${LOG_PREFIX} ${spec.runtime} runtime install ${r.success ? 'succeeded' : 'failed'}`))
            .catch(() => {});
        }
      }
    } catch { /* no spec or bad JSON — skip runtime check */ }
  }

  // Hand off to the Install Manager via file-api HTTP. This is a fast
  // control-plane call (the Manager spawns the install subprocess
  // detached and returns immediately); we do NOT block on completion.
  let resp: { ok: boolean; status: number; body: Record<string, unknown> };
  try {
    resp = await callFileApiInstall('/api/internal/install', {
      method: 'POST',
      body: { project: target.appDirectory },
    });
  } catch (err) {
    return errorResult('INSTALL_REQUEST_FAILED', `Failed to reach install manager: ${(err as Error).message}`);
  }

  if (!resp.ok) {
    const bodyErr = (resp.body?.error as string) || `HTTP ${resp.status}`;
    return errorResult('INSTALL_REQUEST_FAILED', `Install manager rejected request: ${bodyErr}`);
  }

  const status = resp.body as {
    phase?: string;
    packageManager?: string | null;
    lang?: string | null;
    error?: string | null;
    errorClass?: string | null;
    logPath?: string;
  };

  // errorClass === 'no_manifest' means the project has nothing to
  // install (static site, Rust binary with no Cargo.toml at root, etc.).
  // That's not a failure from the agent's perspective.
  if (status.phase === 'failed' && status.errorClass !== 'no_manifest') {
    return errorResult('INSTALL_FAILED', status.error || 'Dependency install failed');
  }

  console.log(
    `${LOG_PREFIX} install_deps requested: phase=${status.phase} pm=${status.packageManager ?? 'none'} ` +
    `at ${target.appDirectory} (${Date.now() - start}ms)`,
  );

  return successResult(
    {
      started: status.phase === 'running' || status.phase === 'queued',
      alreadyReady: status.phase === 'ready',
      packageManager: status.packageManager ?? null,
      language: status.lang ?? null,
      note:
        status.phase === 'ready'
          ? 'Dependencies already installed.'
          : status.phase === 'failed' && status.errorClass === 'no_manifest'
            ? 'No package manifest to install at project root.'
            : 'Install running in background; preview click will wait for completion.',
    },
    Date.now() - start,
  );
}

// ── Secrets + DB tool helpers ──
//
// All four secrets tools and three DB tools go through sovereign-shield's
// internal-token-authenticated routes (added in internal.routes.ts). The
// MCP gateway runs the gate check BEFORE any handler here fires — when the
// user hasn't approved the matching gate, the handler is never reached
// and the gateway returns approval_required (firing the chat popup). So
// every successful call implies explicit user approval of the capability.
//
// Error mapping contract:
//   INVALID_INPUT   — caller-side validation failure (bad args)
//   SHIELD_AUTH     — shield rejected our internal token; indicates
//                     setShieldServiceName was never called at startup, or
//                     /run/shield/internal-agent-bridge.token is missing
//   SHIELD_ERROR    — shield returned 5xx or network failure
//   NOT_FOUND       — shield returned 404 (secret or app doesn't exist)
//   FORBIDDEN       — shield returned 403 (mode escalation, admin SQL, ...)
//
// None of the handlers log secret values. Audit happens inside shield.

const SECRET_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const DB_NAME_RE = /^[a-zA-Z0-9_-]{1,63}$/;
const MAX_SECRET_VALUE_BYTES = 64 * 1024;
const MAX_SQL_BYTES = 1 * 1024 * 1024;
const VALID_SECRET_ENVS = new Set(['production', 'development']);

type SecretEnv = 'production' | 'development';

function resolveSandboxId(context: ToolCallContext): string | null {
  const s = context.sandboxId?.trim();
  if (!s) return null;
  // Matches gate-request regex.
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(s)) return null;
  return s;
}

function resolveSecretEnv(raw: unknown): SecretEnv {
  if (typeof raw === 'string' && VALID_SECRET_ENVS.has(raw)) return raw as SecretEnv;
  return 'production';
}

// Map shield HTTP response → ToolCallResult. Never leaks raw response to model.
async function mapShieldResponse(
  res: Response,
  operation: string,
): Promise<{ ok: true; data: unknown } | { ok: false; result: ToolCallResult }> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {}

  if (res.ok) {
    return { ok: true, data: body };
  }

  const msg = (body && typeof body.error === 'string') ? body.error : `HTTP ${res.status}`;

  if (res.status === 401) {
    return {
      ok: false,
      result: errorResult(
        'SHIELD_AUTH',
        `Shield rejected internal-token auth while ${operation}. This is a platform configuration bug — contact support.`,
      ),
    };
  }
  if (res.status === 404) {
    return { ok: false, result: errorResult('NOT_FOUND', msg) };
  }
  if (res.status === 403) {
    // IPC_NOT_AUTHORIZED = platform misconfig; plain 403 = user-actionable gate denial.
    if (body && body.code === 'IPC_NOT_AUTHORIZED') {
      return {
        ok: false,
        result: errorResult(
          'PLATFORM_MISCONFIG',
          `${msg} (operation: ${operation})`,
        ),
      };
    }
    return { ok: false, result: errorResult('FORBIDDEN', msg) };
  }
  if (body && body.error === 'NO_CREDENTIALS') {
    return {
      ok: false,
      result: errorResult(
        'NO_CREDENTIALS',
        body.message || `No git credentials configured. The user must link a repository in the console Integrations tab.`,
      ),
    };
  }
  if (body && body.error === 'AUTH_FAILED') {
    return {
      ok: false,
      result: errorResult(
        'AUTH_FAILED',
        body.message || `Git authentication failed. The stored token may be expired. Ask the user to re-link the repository.`,
      ),
    };
  }
  if (res.status >= 400 && res.status < 500) {
    return { ok: false, result: errorResult('INVALID_INPUT', msg) };
  }
  return { ok: false, result: errorResult('SHIELD_ERROR', msg, /* retryable */ res.status >= 500) };
}

// ── Secret handlers ──

async function handleListSecrets(
  args: Record<string, unknown>,
  context: ToolCallContext,
): Promise<ToolCallResult> {
  const start = Date.now();
  const sandboxId = resolveSandboxId(context);
  if (!sandboxId) {
    return errorResult('INVALID_INPUT', 'No sandbox context — list_secrets requires an active sandbox.');
  }
  const env = resolveSecretEnv(args.env);

  let res: Response;
  try {
    res = await callShieldInternal(
      `/api/internal/secrets/${encodeURIComponent(sandboxId)}?env=${env}&threadId=${encodeURIComponent(context.threadId)}`,
      { timeout: 10_000 },
    );
  } catch (err) {
    return errorResult('SHIELD_ERROR', `Shield unreachable: ${(err as Error).message}`, true);
  }

  const mapped = await mapShieldResponse(res, 'listing secrets');
  if (!mapped.ok) return mapped.result;

  const data = mapped.data as { project: string; env: string; names: string[] };
  return successResult({ env: data.env, names: data.names, count: data.names.length }, Date.now() - start);
}

async function handleReadSecret(
  args: Record<string, unknown>,
  context: ToolCallContext,
): Promise<ToolCallResult> {
  const start = Date.now();
  const sandboxId = resolveSandboxId(context);
  if (!sandboxId) {
    return errorResult('INVALID_INPUT', 'No sandbox context — read_secret requires an active sandbox.');
  }
  const name = args.name;
  if (typeof name !== 'string' || !SECRET_NAME_RE.test(name)) {
    return errorResult('INVALID_INPUT', 'name must match POSIX env var syntax ([a-zA-Z_][a-zA-Z0-9_]*).');
  }
  const env = resolveSecretEnv(args.env);

  let res: Response;
  try {
    res = await callShieldInternal(
      `/api/internal/secrets/${encodeURIComponent(sandboxId)}/${encodeURIComponent(name)}?env=${env}&threadId=${encodeURIComponent(context.threadId)}`,
      { timeout: 10_000 },
    );
  } catch (err) {
    return errorResult('SHIELD_ERROR', `Shield unreachable: ${(err as Error).message}`, true);
  }

  const mapped = await mapShieldResponse(res, 'reading secret');
  if (!mapped.ok) return mapped.result;

  const data = mapped.data as { project: string; env: string; name: string; value: string };
  // The secret value is returned to the agent — that's the whole point of
  // the tool. Do NOT log it here; shield already audited the access.
  return successResult({ env: data.env, name: data.name, value: data.value }, Date.now() - start);
}

async function handleSetSecret(
  args: Record<string, unknown>,
  context: ToolCallContext,
): Promise<ToolCallResult> {
  const start = Date.now();
  const sandboxId = resolveSandboxId(context);
  if (!sandboxId) {
    return errorResult('INVALID_INPUT', 'No sandbox context — set_secret requires an active sandbox.');
  }
  const name = args.name;
  const value = args.value;
  if (typeof name !== 'string' || !SECRET_NAME_RE.test(name)) {
    return errorResult('INVALID_INPUT', 'name must match POSIX env var syntax ([a-zA-Z_][a-zA-Z0-9_]*).');
  }
  if (typeof value !== 'string') {
    return errorResult('INVALID_INPUT', 'value must be a string.');
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_SECRET_VALUE_BYTES) {
    return errorResult('INVALID_INPUT', `value exceeds ${MAX_SECRET_VALUE_BYTES} bytes.`);
  }
  const env = resolveSecretEnv(args.env);

  let res: Response;
  try {
    res = await callShieldInternal(
      `/api/internal/secrets/${encodeURIComponent(sandboxId)}/${encodeURIComponent(name)}`,
      { method: 'PUT', body: { value, env, threadId: context.threadId }, timeout: 10_000 },
    );
  } catch (err) {
    return errorResult('SHIELD_ERROR', `Shield unreachable: ${(err as Error).message}`, true);
  }

  const mapped = await mapShieldResponse(res, 'writing secret');
  if (!mapped.ok) return mapped.result;

  return successResult({ env, name, written: true }, Date.now() - start);
}

async function handleDeleteSecret(
  args: Record<string, unknown>,
  context: ToolCallContext,
): Promise<ToolCallResult> {
  const start = Date.now();
  const sandboxId = resolveSandboxId(context);
  if (!sandboxId) {
    return errorResult('INVALID_INPUT', 'No sandbox context — delete_secret requires an active sandbox.');
  }
  const name = args.name;
  if (typeof name !== 'string' || !SECRET_NAME_RE.test(name)) {
    return errorResult('INVALID_INPUT', 'name must match POSIX env var syntax ([a-zA-Z_][a-zA-Z0-9_]*).');
  }
  const env = resolveSecretEnv(args.env);

  let res: Response;
  try {
    res = await callShieldInternal(
      `/api/internal/secrets/${encodeURIComponent(sandboxId)}/${encodeURIComponent(name)}?env=${env}&threadId=${encodeURIComponent(context.threadId)}`,
      { method: 'DELETE', timeout: 10_000 },
    );
  } catch (err) {
    return errorResult('SHIELD_ERROR', `Shield unreachable: ${(err as Error).message}`, true);
  }

  const mapped = await mapShieldResponse(res, 'deleting secret');
  if (!mapped.ok) return mapped.result;

  const data = mapped.data as { existed: boolean };
  return successResult({ env, name, existed: data.existed, deleted: data.existed }, Date.now() - start);
}

// ── DB query handlers ──

interface DbQueryResponse {
  rows: unknown[];
  rowCount: number;
  command: string;
  category: 'read' | 'write' | 'migrate';
  truncated: boolean;
}

async function runDbQuery(
  context: ToolCallContext,
  mode: 'read' | 'write' | 'migrate',
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const start = Date.now();
  const sandboxId = resolveSandboxId(context);
  if (!sandboxId) {
    return errorResult('INVALID_INPUT', `No sandbox context — db_${mode === 'read' ? 'query_read' : mode === 'write' ? 'query_write' : 'migrate'} requires an active sandbox.`);
  }

  const sql = args.sql;
  if (typeof sql !== 'string' || !sql.trim()) {
    return errorResult('INVALID_INPUT', 'sql must be a non-empty string.');
  }
  if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) {
    return errorResult('INVALID_INPUT', `sql exceeds ${MAX_SQL_BYTES} bytes.`);
  }

  let database: string | undefined;
  if (args.database !== undefined && args.database !== null) {
    if (typeof args.database !== 'string' || !DB_NAME_RE.test(args.database)) {
      return errorResult('INVALID_INPUT', 'database must match [a-zA-Z0-9_-]{1,63}.');
    }
    database = args.database;
  }

  let res: Response;
  try {
    res = await callShieldInternal('/api/internal/db/query', {
      method: 'POST',
      body: { sandboxId, sql, mode, threadId: context.threadId, ...(database ? { database } : {}) },
      timeout: 60_000,
    });
  } catch (err) {
    return errorResult('SHIELD_ERROR', `Shield unreachable: ${(err as Error).message}`, true);
  }

  const mapped = await mapShieldResponse(res, `executing ${mode} query`);
  if (!mapped.ok) return mapped.result;

  const data = mapped.data as DbQueryResponse;
  return successResult(
    {
      rows: data.rows,
      rowCount: data.rowCount,
      command: data.command,
      category: data.category,
      truncated: data.truncated,
    },
    Date.now() - start,
  );
}

function handleDbQueryRead(args: Record<string, unknown>, context: ToolCallContext): Promise<ToolCallResult> {
  return runDbQuery(context, 'read', args);
}

function handleDbQueryWrite(args: Record<string, unknown>, context: ToolCallContext): Promise<ToolCallResult> {
  return runDbQuery(context, 'write', args);
}

function handleDbMigrate(args: Record<string, unknown>, context: ToolCallContext): Promise<ToolCallResult> {
  return runDbQuery(context, 'migrate', args);
}

// ── Git tool handlers ──
//
// Same gate pattern as secrets/database — MCP gateway checks the git gate
// BEFORE the handler fires, so every call implies explicit user approval.
// Handler mints an action token via shield's git-auto-authorize, then runs
// ellul-git-flow (the same script the console's "Git Sync" button uses).

async function mintGitPushToken(
  sandboxId: string,
  threadId: string,
): Promise<{ token: string; credentialSession?: string } | null> {
  try {
    const res = await callShieldInternal('/api/internal/git-auto-authorize', {
      method: 'POST',
      body: { sandboxId, threadId },
      timeout: 5_000,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { token?: string; credentialSession?: string };
    return data.token ? { token: data.token, credentialSession: data.credentialSession } : null;
  } catch {
    return null;
  }
}

function resolveGitProject(raw: string): { target: ResolvedTarget | null; error?: string } {
  const resolved = resolveProjectTarget(raw);
  if (resolved.target) return resolved;

  const parts = raw.split('/').filter(Boolean);
  if (parts.length === 1 && isSandboxId(parts[0]!)) {
    const absolutePath = path.resolve(PROJECTS_DIR, raw);
    if (!fs.existsSync(absolutePath)) return resolved;
    try {
      const gitChildren = fs.readdirSync(absolutePath).filter((name) => {
        try {
          return fs.statSync(path.join(absolutePath, name)).isDirectory()
            && !name.startsWith('.')
            && fs.existsSync(path.join(absolutePath, name, '.git'));
        } catch { return false; }
      });
      if (gitChildren.length === 1) {
        return { target: { absolutePath: path.join(absolutePath, gitChildren[0]!), appDirectory: `${raw}/${gitChildren[0]}` } };
      }
      if (gitChildren.length > 1) {
        return { target: null, error: `Sandbox "${raw}" has ${gitChildren.length} git repos — specify which: ${gitChildren.map((c) => `"${raw}/${c}"`).join(', ')}.` };
      }
    } catch { /* fall through */ }
  }
  return resolved;
}

async function handleGitPush(
  args: Record<string, unknown>,
  context: ToolCallContext,
): Promise<ToolCallResult> {
  const start = Date.now();
  const sandboxId = resolveSandboxId(context);
  if (!sandboxId) {
    return errorResult('INVALID_INPUT', 'No sandbox context — git_push requires an active sandbox.');
  }
  const raw = typeof args.project === 'string' ? args.project : sandboxId;
  const resolved = resolveGitProject(raw);
  if (!resolved.target) {
    return errorResult('INVALID_INPUT', resolved.error || `Could not resolve project: ${raw}`);
  }
  const { absolutePath: projectDir, appDirectory } = resolved.target;

  if (!fs.existsSync(path.join(projectDir, '.git'))) {
    return errorResult('NO_GIT_REPO', `No git repository at "${appDirectory}". Run \`git init\` and \`git remote add origin <url>\` first.`);
  }

  const remoteCheck = await execTool('git', ['remote', 'get-url', 'origin'], { cwd: projectDir, timeoutMs: 5_000 });
  if (!remoteCheck.success) {
    return errorResult('NO_REMOTE', `No remote "origin" at "${appDirectory}". Run \`git remote add origin <url>\` first.`);
  }

  const headCheck = await execTool('git', ['rev-parse', 'HEAD'], { cwd: projectDir, timeoutMs: 5_000 });
  if (!headCheck.success) {
    return errorResult('EMPTY_REPO', `Repository at "${appDirectory}" has no commits. Stage and commit files first, then push.`);
  }

  const tokenResult = await mintGitPushToken(sandboxId, context.threadId);
  if (!tokenResult) {
    return errorResult('SHIELD_ERROR', 'Failed to mint git push token — gate may not be open.', true);
  }

  try {
    const force = args.force === true;
    const pushRes = await callShieldInternal('/api/internal/git-push', {
      method: 'POST',
      body: { token: tokenResult.token, project: appDirectory, force, agentPush: true },
      timeout: 120_000,
    });
    const data = (await pushRes.json()) as {
      success?: boolean;
      error?: string;
      message?: string;
      output?: string;
      detail?: string;
    };
    if (!data.success) {
      if (data.error === 'NO_CREDENTIALS') {
        return errorResult(
          'NO_CREDENTIALS',
          data.message || `No git credentials for "${appDirectory}". The user must link a repository in the console Integrations tab. Tell them: open Settings → Integrations → Git, then connect a GitHub/GitLab account and link this sandbox.`,
        );
      }
      if (data.error === 'AUTH_FAILED') {
        return errorResult(
          'AUTH_FAILED',
          data.message || `Git authentication failed. The stored token may be expired or revoked. Ask the user to re-link the repository in Settings → Integrations → Git.`,
        );
      }
      const errMsg = data.error || 'Push failed';
      const hint = /rejected.*non-fast-forward|failed to push/i.test(errMsg)
        ? ' The remote has commits you don\'t have locally. Pull first with git_pull, resolve any conflicts, then push again. If you need to overwrite the remote, call git_push with force: true.'
        : '';
      return errorResult('GIT_PUSH_FAILED', errMsg + hint);
    }
    return successResult({ status: 'pushed', project: appDirectory, output: data.output }, Date.now() - start);
  } catch (err) {
    return errorResult('SHIELD_ERROR', `Shield unreachable: ${(err as Error).message}`, true);
  }
}

async function handleGitPull(
  args: Record<string, unknown>,
  context: ToolCallContext,
): Promise<ToolCallResult> {
  const start = Date.now();
  const sandboxId = resolveSandboxId(context);
  if (!sandboxId) {
    return errorResult('INVALID_INPUT', 'No sandbox context — git_pull requires an active sandbox.');
  }
  const raw = typeof args.project === 'string' ? args.project : sandboxId;
  const resolved = resolveGitProject(raw);
  if (!resolved.target) {
    return errorResult('INVALID_INPUT', resolved.error || `Could not resolve project: ${raw}`);
  }
  const { absolutePath: projectDir, appDirectory } = resolved.target;

  if (!fs.existsSync(path.join(projectDir, '.git'))) {
    return errorResult('NO_GIT_REPO', `No git repository at "${appDirectory}". Run \`git init\` and \`git remote add origin <url>\` first.`);
  }

  let res: Response;
  try {
    res = await callShieldInternal('/api/internal/git-pull', {
      method: 'POST',
      body: { project: appDirectory },
      timeout: 60_000,
    });
  } catch (err) {
    return errorResult('SHIELD_ERROR', `Shield unreachable: ${(err as Error).message}`, true);
  }

  const mapped = await mapShieldResponse(res, 'pulling from remote');
  if (!mapped.ok) return mapped.result;

  const data = mapped.data as { status: string; branch: string };
  return successResult({ ...data, project: appDirectory }, Date.now() - start);
}

// ── Secret tool schemas ──

const ENV_PARAM_SCHEMA = {
  type: 'string',
  enum: ['production', 'development'],
  description: 'Which environment: "production" (deployed apps, default) or "development" (preview server).',
};

// ── Tool definitions ──

const PLATFORM_TOOLS: Array<{
  definition: GovernedToolDefinition;
  handler: (args: Record<string, unknown>, context: ToolCallContext) => Promise<ToolCallResult>;
  permission?: 'allow_always';
}> = [
  {
    definition: buildToolDef(
      'scaffold_project',
      '**MANDATORY for any new app/package/framework creation.** Read the user message: if they ask to add/create/scaffold/build/spin-up any framework or app (Next.js, Hono, NestJS, Express, Vite, Django, FastAPI, Flask, Rails, Phoenix, Flutter, Astro, Svelte, etc. — including spaced/capitalised forms like "next js" or "Nest JS"), this tool is your FIRST action. Hand-rolling with `mkdir` + `package.json` is forbidden — the platform write-guard rejects scaffold-shaped writes inside workspace dirs and you will lose the round-trip.\n\n' +
        'Handles atomicity, metadata, preview spec, monorepo routing, version pinning, Tailwind/TypeScript wiring, workspace config registration. Reproducing this by hand from training-data memory creates broken builds — your trained reflex for boilerplate is wrong here, the templates are the source of truth.\n\n' +
        'Shell commands remain available for editing existing files, running builds, git, debugging, installing deps with `install_deps` — anything that is NOT creating a new project skeleton.\n\n' +
        '**Single standalone app** (most common): `scaffold_project({framework:"next"})` → lands at `sandbox/my-app/`. One standalone per sandbox — a second call returns `ALREADY_SCAFFOLDED`.\n\n' +
        '**Monorepo with multiple apps** — ONE call does everything: `scaffold_project({framework:"turbo", project:"monorepo", packages:[{framework:"next",project:"web"},{framework:"hono",project:"api"}]})`. The `packages` array scaffolds all leaf packages atomically inside the workspace. Then call `install_deps` once.\n\n' +
        '**Adding a leaf to an existing monorepo** (e.g. user says "add a nest js backend too"): `scaffold_project({framework:"nestjs", project:"api"})` — the tool auto-detects the existing workspace and lands the new package inside it. No need to specify the workspace root.\n\n' +
        '**Framework selection**: use the exact framework the user asked for. If the framework is not available on this server, the tool returns `SCAFFOLD_FAILED` with a list of alternatives — relay that error and the alternatives to the user. Never substitute a different framework without asking.\n\n' +
        '**Naming monorepo packages**: use domain names, not framework names. `web` for frontend, `api` for backend, `docs` for docs, `shared` for shared libs. Single-app sandboxes default to `my-app`.\n\n' +
        '**When NOT to ask**: never ask "what framework?" if the user already named one. Never ask "what name?" — default to `web`/`api`/`my-app`. Only ask ONE clarifying question when the request is genuinely ambiguous AND affects scaffold shape.\n\n' +
        '**Scaffold is file-system-only.** It writes package.json, src/, config files, ellul.json, and nothing else. After all scaffold_project calls are done, call `install_deps` once at the monorepo root (or standalone app). The preview activates when the user clicks it in the UI. Do NOT skip install_deps — the preview will fail without dependencies.\n\n' +
        '**Error kinds:**\n' +
        '- `ALREADY_SCAFFOLDED` — standalone app already exists; cannot add a second to the same sandbox. Tell the user to create a new sandbox.\n' +
        '- `PACKAGE_EXISTS` — inside a monorepo, that package slug is taken. Retry with a **different** domain name (`web` → `web-v2`, or switch to `dashboard`, etc.).\n' +
        '- `SCAFFOLD_FAILED` — scaffold CLI failed. Report the exact error to the user. You can use shell to investigate (check disk space, network, logs) but don\'t try to manually reconstruct the scaffold with shell — call scaffold_project again or ask the user what to do.\n' +
        '- `WORKSPACE_CONFIG_INVALID` — the monorepo config is malformed. You can use shell to inspect and fix the config file, then retry scaffold_project.\n',
      'execution:shell',
      {
        type: 'object',
        properties: {
          project: {
            type: 'string',
            description: 'Short subfolder name (lowercase a-z/0-9/dash). Defaults to "my-app" for standalone, "monorepo" for monorepos.',
          },
          framework: {
            type: 'string',
            enum: [...SCAFFOLDABLE_FRAMEWORK_IDS],
            description: 'Framework id — use exactly what the user asked for. "turbo" for monorepo. Defaults to "next" only when the user did not specify. If unavailable, the tool returns SCAFFOLD_FAILED with alternatives.',
          },
          packages: {
            type: 'array',
            description: 'For monorepos ONLY: list of packages to scaffold inside the workspace. Each entry creates one app in apps/<project>/. Provide this with framework:"turbo" to scaffold the entire monorepo in one atomic call. Example: [{framework:"nuxt",project:"web"},{framework:"dotnet",project:"api"}]',
            items: {
              type: 'object',
              properties: {
                framework: { type: 'string', enum: [...SCAFFOLDABLE_FRAMEWORK_IDS] },
                project: { type: 'string' },
              },
              required: ['framework', 'project'],
            },
          },
        },
        required: [],
      },
    ),
    handler: handleScaffoldProject,
    // Safe-by-construction: scaffold_project runs ONLY commands from the
    // centralized framework registry (packages/vps/src/.../frameworks),
    // passed as an exec-style array (no shell interpretation, no injection),
    // inside the project directory (cannot escape via ..), bounded by a
    // 180s timeout, and refuses to run if the target dir is non-empty
    // (except for a short allowlist of scaffolded metadata). It takes no
    // user-supplied shell string — only a framework ID from a fixed enum
    // and a project name validated elsewhere. Gating this behind the
    // execution:shell approval popup added friction for zero extra
    // security — the tool surface is strictly narrower than "arbitrary
    // shell". Marking it allow_always puts it in the same permission
    // class as install_deps. Preview lifecycle is platform-managed and
    // deterministic — no agent-facing restart/verify tools.
    permission: 'allow_always',
  },
  {
    definition: buildToolDef(
      'install_deps',
      'Kick off dependency install in the background. Returns immediately once the install has been started — DO NOT wait or poll for completion. The preview service runs its own install check on first preview click and will wait for deps to finish before launching the dev server; this tool just warms the install in advance so that click is fast. Auto-detects package manager from lockfile / manifest. Call this once after scaffold_project, then end your turn with a short success message — the user clicks preview when they\'re ready.',
      'execution:shell',
      {
        type: 'object',
        properties: {
          project: {
            type: 'string',
            description: 'Either a sandbox slug ("sbx-xyz", auto-resolves to the sandbox\'s single app) or a nested app path ("sbx-xyz/my-app"). Required when the sandbox has multiple apps.',
          },
        },
        required: ['project'],
      },
    ),
    handler: handleInstallDeps,
    permission: 'allow_always',
  },
  // ── Secrets (require env gate) ──
  {
    definition: buildToolDef(
      'list_secrets',
      'List the names of every secret set for the current sandbox. Does NOT return values. ' +
        'Call before read_secret when you need to discover what secrets exist. ' +
        'Returns `{ env, names: string[], count }`. Requires the `env` gate to be open — ' +
        'the first call in a session triggers a user-approval popup in the chat UI.',
      'secrets:env_read',
      {
        type: 'object',
        properties: { env: ENV_PARAM_SCHEMA },
        required: [],
      },
    ),
    handler: handleListSecrets,
  },
  {
    definition: buildToolDef(
      'read_secret',
      'Read the plaintext value of a single secret for the current sandbox. Merges _global + ' +
        'sandbox + app scopes (app overrides sandbox overrides global). Requires the `env` gate. ' +
        'Returns `{ env, name, value }` on success, `NOT_FOUND` if the secret is not set. ' +
        'Never log or echo the returned value to the chat — the platform audits every read.',
      'secrets:env_read',
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Secret name (POSIX env var syntax: [a-zA-Z_][a-zA-Z0-9_]*).' },
          env: ENV_PARAM_SCHEMA,
        },
        required: ['name'],
      },
    ),
    handler: handleReadSecret,
  },
  {
    definition: buildToolDef(
      'set_secret',
      'Create or update a secret for the current sandbox. Persisted in the shielded secrets vault ' +
        'and auto-injected into the app env on next deploy/preview. Requires the `env` gate. ' +
        'Value is limited to 64 KiB. Returns `{ env, name, written: true }`.',
      'secrets:env_inject',
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Secret name (POSIX env var syntax).' },
          value: { type: 'string', description: 'Secret value. Max 64 KiB.' },
          env: ENV_PARAM_SCHEMA,
        },
        required: ['name', 'value'],
      },
    ),
    handler: handleSetSecret,
  },
  {
    definition: buildToolDef(
      'delete_secret',
      'Remove a secret from the current sandbox. Idempotent — returns existed:false if the ' +
        'secret did not exist. Requires the `env` gate.',
      'secrets:env_inject',
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Secret name to delete.' },
          env: ENV_PARAM_SCHEMA,
        },
        required: ['name'],
      },
    ),
    handler: handleDeleteSecret,
  },
  // ── Database (granular gates: db_read / db_write / db_migrate) ──
  {
    definition: buildToolDef(
      'db_query_read',
      'Execute a read-only SQL query (SELECT, SHOW, EXPLAIN, WITH ... SELECT) against the ' +
        'sandbox\'s PostgreSQL database as the scoped readonly role. Results capped at 10,000 rows. ' +
        'Requires the `db_read` gate. Use `database` to target a named DB when the sandbox has ' +
        'more than one; omit for the default. Non-read SQL is rejected with FORBIDDEN — use ' +
        'db_query_write or db_migrate instead.',
      'database:read',
      {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL to execute. Must classify as read (SELECT, WITH ... SELECT, SHOW, EXPLAIN).' },
          database: { type: 'string', description: 'Named database label, e.g. "default". Optional.' },
        },
        required: ['sql'],
      },
    ),
    handler: handleDbQueryRead,
  },
  {
    definition: buildToolDef(
      'db_query_write',
      'Execute a read or write SQL query (INSERT, UPDATE, DELETE) against the sandbox\'s ' +
        'PostgreSQL database as the scoped app role. Requires the `db_write` gate. ' +
        'DDL and DROP are NOT accepted — use db_migrate for schema changes. Returns ' +
        '`{ rows, rowCount, command, category, truncated }`.',
      'database:write',
      {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL to execute. Must classify as read or write (no DDL / DROP).' },
          database: { type: 'string', description: 'Named database label. Optional.' },
        },
        required: ['sql'],
      },
    ),
    handler: handleDbQueryWrite,
  },
  {
    definition: buildToolDef(
      'db_migrate',
      'Execute a schema migration (CREATE TABLE, ALTER TABLE, DROP TABLE, CREATE INDEX, ...) ' +
        'against the sandbox\'s PostgreSQL database as the scoped owner role. Requires the ' +
        '`db_migrate` gate. Administrative commands (SET, VACUUM, CLUSTER) are blocked.',
      'database:migrate',
      {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'Migration SQL. Any non-admin category is accepted.' },
          database: { type: 'string', description: 'Named database label. Optional.' },
        },
        required: ['sql'],
      },
    ),
    handler: handleDbMigrate,
  },
  // ── Git (require git gate) ──
  {
    definition: buildToolDef(
      'git_push',
      'Push the current branch to the remote repository. Requires the `git` gate — ' +
        'the first call in a session triggers a user-approval popup in the chat UI. ' +
        'Works for initial pushes (new repos) and subsequent pushes alike. ' +
        'Never run `git push` directly — always use this tool.',
      'deployment:git_write',
      {
        type: 'object',
        properties: {
          project: {
            type: 'string',
            description: 'Sandbox slug (e.g. "sbx-xyz") or nested app path. Defaults to current sandbox.',
          },
          force: {
            type: 'boolean',
            description: 'Use --force-with-lease to overwrite remote. Only when the user explicitly asks to force push.',
          },
        },
        required: [],
      },
    ),
    handler: handleGitPush,
  },
  {
    definition: buildToolDef(
      'git_pull',
      'Pull (fetch + rebase) the current branch from the remote repository. Requires the `git` gate. ' +
        'Never run `git pull` directly — always use this tool.',
      'deployment:git_read',
      {
        type: 'object',
        properties: {
          project: {
            type: 'string',
            description: 'Sandbox slug (e.g. "sbx-xyz") or nested app path. Defaults to current sandbox.',
          },
        },
        required: [],
      },
    ),
    handler: handleGitPull,
  },
];

// ── Registration ──

/**
 * Supported framework IDs for scaffold_project.
 * Derived from the centralised framework registry at module load.
 */
export const SUPPORTED_FRAMEWORKS: readonly string[] = SCAFFOLDABLE_FRAMEWORK_IDS;

/**
 * Names of every platform tool the bridge exposes via the local
 * MCP relay. The OpenCode emitter reads this to opt every agent into
 * each tool by name in `agent.<name>.tools` — without that opt-in,
 * OpenCode reports the MCP server as `connected` but never includes
 * the tools in the LLM's tool catalog (verified across three sandboxes).
 *
 * Single source of truth — when a new tool is added to PLATFORM_TOOLS,
 * this list updates with it.
 */
export const PLATFORM_TOOL_NAMES: readonly string[] =
  PLATFORM_TOOLS.map((t) => t.definition.name);

// Model-bypass scaffold for main.ts scaffold-intent handler. Idempotent; safe
// even when sandbox already has platform files (temp dir + merge).
export async function scaffoldProjectDirect(
  sandboxId: string,
  opts: {
    framework?: string;
    project?: string;
    // Batch form — atomically scaffold N leaf packages (fresh or existing monorepo).
    packages?: Array<{ framework: string; project: string }>;
    threadId?: string;
  } = {},
): Promise<ToolCallResult> {
  return handleScaffoldProject(
    {
      framework: opts.framework,
      project: opts.project,
      packages: opts.packages,
    },
    {
      sandboxId,
      threadId: opts.threadId ?? '',
      serverId: '',
      userId: '',
      callerType: 'system',
    },
  );
}

export function registerPlatformTools(gateway: McpGateway): void {
  for (const { definition, handler, permission } of PLATFORM_TOOLS) {
    gateway.registerBuiltinTool(definition.name, definition, handler);

    if (permission === 'allow_always') {
      gateway.setToolPermission(BUILTIN_CONNECTION_ID, definition.name, 'allow_always');
    }

    console.log(`${LOG_PREFIX} Registered: ${definition.name} (${definition.capability})`);
  }

  console.log(`${LOG_PREFIX} ${PLATFORM_TOOLS.length} platform tools registered (${SCAFFOLDABLE_FRAMEWORK_IDS.length} scaffoldable frameworks)`);
}
