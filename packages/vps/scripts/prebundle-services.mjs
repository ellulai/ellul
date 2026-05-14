#!/usr/bin/env node
// SPDX-License-Identifier: BUSL-1.1
// Pre-bundles all VPS services at build time so the API container
// never invokes esbuild at runtime. Eliminates the ~200 MB per-request
// memory spike that caused OOM crashes on Cloud Run (768 Mi limit).
//
// Run: node packages/vps/scripts/prebundle-services.mjs
// Called by: pnpm --filter @ellul.ai/vps build (via package.json postbuild)

import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const srcRoot = path.join(packageRoot, "src");
const outDir = path.join(packageRoot, "dist", "prebundled");

fs.mkdirSync(outDir, { recursive: true });

const services = [
  {
    name: "sovereign-shield",
    entry: path.join(srcRoot, "services/auth/sovereign-shield/src/main.ts"),
    external: [
      "fs", "path", "crypto", "http", "https", "url", "events", "stream",
      "util", "os", "net", "tls", "dns", "zlib", "buffer", "querystring",
      "string_decoder", "child_process", "worker_threads", "perf_hooks",
      "async_hooks", "better-sqlite3", "@solana/web3.js", "bip39",
      "ed25519-hd-key",
    ],
    plugins: [staticTextPlugin()],
  },
  {
    name: "file-api",
    entry: path.join(srcRoot, "services/backends/file-api/src/main.ts"),
    external: [
      "fs", "path", "crypto", "http", "https", "url", "events", "stream",
      "util", "os", "child_process", "ws", "chokidar",
    ],
  },
  {
    name: "agent-bridge",
    entry: path.join(srcRoot, "services/backends/agent-bridge/src/main.ts"),
    external: [
      "fs", "path", "crypto", "http", "https", "url", "events", "stream",
      "util", "os", "child_process", "ws", "node-pty", "better-sqlite3",
      "isolated-vm",
    ],
    loader: {
      ".md": "text", ".sh": "text", ".txt": "text", ".conf": "text",
      ".c": "text", ".h": "text", ".service": "text", ".slice": "text",
      ".timer": "text",
    },
  },
  {
    name: "claude-launcher",
    entry: path.join(srcRoot, "services/backends/claude-launcher/src/main.ts"),
    external: [
      "fs", "path", "crypto", "http", "https", "url", "events", "stream",
      "util", "os", "child_process",
    ],
  },
  {
    name: "caddy-gen",
    entry: path.join(srcRoot, "services/gateway/caddy-gen/main.ts"),
    external: [
      "fs", "path", "crypto", "http", "https", "url", "events", "stream",
      "util", "os", "child_process",
    ],
  },
];

function staticTextPlugin() {
  return {
    name: "static-text",
    setup(build) {
      build.onLoad(
        { filter: /[/\\]static[/\\][^/\\]+\.(html|js\.map|js)$/ },
        async (args) => ({
          contents: `export default ${JSON.stringify(fs.readFileSync(args.path, "utf8"))}`,
          loader: "js",
        }),
      );
    },
  };
}

let failed = 0;

for (const svc of services) {
  const t0 = Date.now();
  try {
    const result = await esbuild.build({
      entryPoints: [svc.entry],
      bundle: true,
      platform: "node",
      target: "node18",
      format: "cjs",
      minify: false,
      write: false,
      tsconfig: path.join(packageRoot, "tsconfig.json"),
      external: svc.external,
      plugins: svc.plugins || [],
      loader: svc.loader || {},
    });

    if (!result.outputFiles?.[0]) {
      throw new Error("esbuild produced no output");
    }

    const outPath = path.join(outDir, `${svc.name}.js`);
    fs.writeFileSync(outPath, result.outputFiles[0].text);
    const kb = Math.round(result.outputFiles[0].text.length / 1024);
    console.log(`  ✓ ${svc.name} (${kb} KB, ${Date.now() - t0}ms)`);
  } catch (err) {
    console.error(`  ✗ ${svc.name}: ${err.message}`);
    failed++;
  }
}

if (failed > 0) {
  console.error(`\n${failed} service(s) failed to pre-bundle`);
  process.exit(1);
}

console.log(`\nAll ${services.length} services pre-bundled to ${outDir}`);
