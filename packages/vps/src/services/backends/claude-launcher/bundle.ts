// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Claude Launcher Bundle Generator
 *
 * Bundles ellul-claude-launch — the small Node binary that exchanges a
 * single-use OAT issuance token for the actual Claude OAuth Access Token,
 * then execve's into the namespace wrapper with CLAUDE_CODE_OAUTH_TOKEN
 * injected into env.
 *
 * Wired into core-runtime via scripts/build-agent-bundles.mjs.
 * Deployed to /usr/local/bin/ellul-claude-launch by the enforcer's
 * agent-sync.sh (cp, not symlink — survives core-runtime hot updates).
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

let cachedBundle: string | null = null;
let inflight: Promise<string> | null = null;

function getSourceDir(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  if (currentDir.includes("/dist/") || currentDir.endsWith("/dist")) {
    const packageRoot = currentDir.replace(/\/dist(\/.*)?$/, "");
    return path.join(packageRoot, "src", "services", "backends", "claude-launcher");
  }
  return currentDir;
}

async function bundleLauncher(): Promise<string> {
  if (cachedBundle) return cachedBundle;
  if (inflight) return inflight;

  inflight = doBundleLauncher();
  try { return await inflight; } finally { inflight = null; }
}

async function doBundleLauncher(): Promise<string> {
  if (cachedBundle) return cachedBundle;

  const curDir = path.dirname(fileURLToPath(import.meta.url));
  if (curDir.includes("/dist/") || curDir.endsWith("/dist")) {
    const pkgRoot = curDir.replace(/\/dist(\/.*)?$/, "");
    const pre = path.join(pkgRoot, "dist", "prebundled", "claude-launcher.js");
    if (fs.existsSync(pre)) {
      cachedBundle = fs.readFileSync(pre, "utf8");
      return cachedBundle;
    }
  }

  console.warn("[claude-launcher] prebundled artifact missing — falling back to runtime esbuild");
  const esbuild = await import("esbuild");
  const sourceDir = getSourceDir();
  const packageRoot = path.resolve(sourceDir, "..", "..", "..", "..");
  const entryPoint = path.join(sourceDir, "src", "main.ts");
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    minify: false,
    write: false,
    tsconfig: path.join(packageRoot, "tsconfig.json"),
    external: [
      "fs", "path", "http", "https", "child_process",
      "url", "events", "stream", "util", "os",
    ],
  });
  if (!result.outputFiles?.[0]) {
    throw new Error("esbuild produced no claude-launcher output");
  }
  cachedBundle = result.outputFiles[0].text;
  return cachedBundle;
}

/**
 * Get the launcher script (Node CJS module) for VPS deployment.
 * The first line is a node shebang so the file is directly executable
 * when chmod +x'd at install time. The host's /usr/bin/env node resolves
 * via PATH to the same node version bridge uses.
 */
export async function getClaudeLauncherScript(): Promise<string> {
  const bundledCode = await bundleLauncher();
  return `#!/usr/bin/env node
// ellul-claude-launch — OAT injection launcher (greenfield credential subsystem)
${bundledCode}
`;
}
