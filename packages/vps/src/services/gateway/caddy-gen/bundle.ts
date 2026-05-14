// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * Caddy Generator Bundle
 *
 * Bundles the caddy-gen CLI into a deployable JavaScript script using esbuild.
 * Deployed to /usr/local/bin/ellul-caddy-gen on the VPS.
 *
 * Usage:
 *   import { getCaddyGenScript } from './bundle';
 *   const script = await getCaddyGenScript();
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
    return path.join(packageRoot, "src", "services", "gateway", "caddy-gen");
  }
  return currentDir;
}

async function bundleModular(): Promise<string> {
  if (cachedBundle) return cachedBundle;
  if (inflight) return inflight;

  inflight = doBundleModular();
  try { return await inflight; } finally { inflight = null; }
}

async function doBundleModular(): Promise<string> {
  if (cachedBundle) return cachedBundle;

  const curDir = path.dirname(fileURLToPath(import.meta.url));
  if (curDir.includes("/dist/") || curDir.endsWith("/dist")) {
    const pkgRoot = curDir.replace(/\/dist(\/.*)?$/, "");
    const pre = path.join(pkgRoot, "dist", "prebundled", "caddy-gen.js");
    if (fs.existsSync(pre)) {
      cachedBundle = fs.readFileSync(pre, "utf8");
      return cachedBundle;
    }
  }

  console.warn("[caddy-gen] prebundled artifact missing — falling back to runtime esbuild");
  const esbuild = await import("esbuild");
  const sourceDir = getSourceDir();
  const packageRoot = path.resolve(sourceDir, "..", "..", "..", "..");
  const entryPoint = path.join(sourceDir, "main.ts");

  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    minify: false,
    write: false,
    tsconfig: path.resolve(packageRoot, "tsconfig.json"),
    external: ["fs", "path", "crypto", "os", "url", "util"],
  });

  if (!result.outputFiles?.[0]) {
    throw new Error("esbuild produced no output");
  }

  cachedBundle = result.outputFiles[0].text;
  return cachedBundle;
}

/**
 * Get the caddy-gen CLI script for VPS deployment.
 * Returns JavaScript code that generates Caddyfile content.
 */
export async function getCaddyGenScript(): Promise<string> {
  const bundledCode = await bundleModular();

  return `#!/usr/bin/env node
// ellul-caddy-gen — Caddyfile Generator
// Single source of truth for Caddy configuration.
// Usage: ellul-caddy-gen --model <cloudflare|direct|gateway> --main-domain <d> --code-domain <d> --dev-domain <d>

${bundledCode}
`;
}
