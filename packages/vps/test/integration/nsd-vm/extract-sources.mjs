// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// extract-sources.mjs — emit the daemon + helper C sources to a flat dir.
// Reuses the same exports the production provisioning pipeline consumes
// (packages/vps/dist/scripts/index.cjs), so what CI compiles is byte-equal
// to what ships to the fleet.
//
// Usage:
//   node packages/vps/test/integration/nsd-vm/extract-sources.mjs <out_dir>
//
// Writes:
//   <out_dir>/ellul-namespaced/*.{c,h}    — daemon (multi-file)
//   <out_dir>/ellul-namespaced/fd_pass.c  — fd-pass helper
//   <out_dir>/ns-mount.c                  — ns-mount helper
//   <out_dir>/seccomp-exec.c              — seccomp-exec wrapper
//   <out_dir>/ellul-namespaced.service    — systemd unit
//   <out_dir>/ellul-agent-namespace       — bash control-plane wrapper
//
// Fails hard on any extraction error. No fallbacks.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..", "..");
const distScripts = resolve(
  repoRoot,
  "packages",
  "vps",
  "dist",
  "scripts",
  "index.cjs",
);

const require = createRequire(import.meta.url);
const scripts = require(distScripts);

const requiredExports = [
  "getDaemonSources",
  "getDaemonTestSources",
  "getFdPassSource",
  "getNsMountSource",
  "getSeccompExecSource",
  "getNamespacedDaemonService",
  "getAgentNamespaceScript",
];
for (const k of requiredExports) {
  if (typeof scripts[k] !== "function") {
    console.error(`extract-sources: missing export ${k} from ${distScripts}`);
    process.exit(1);
  }
}

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: extract-sources.mjs <out_dir>");
  process.exit(1);
}

mkdirSync(resolve(outDir, "ellul-namespaced"), { recursive: true });

for (const src of scripts.getDaemonSources()) {
  if (!/^[A-Za-z0-9_.-]+$/.test(src.filename)) {
    console.error(`extract-sources: refusing unsafe filename ${src.filename}`);
    process.exit(1);
  }
  writeFileSync(resolve(outDir, "ellul-namespaced", src.filename), src.content);
}

/* Test sources are emitted alongside production sources so build.sh can
 * compile each as a single-file binary without pulling in the daemon's
 * libsodium/libtinycbor link. */
for (const src of scripts.getDaemonTestSources()) {
  if (!/^test_[A-Za-z0-9_.-]+\.c$/.test(src.filename)) {
    console.error(`extract-sources: refusing test filename ${src.filename}`);
    process.exit(1);
  }
  writeFileSync(resolve(outDir, "ellul-namespaced", src.filename), src.content);
}

writeFileSync(resolve(outDir, "ns-mount.c"), scripts.getNsMountSource());
writeFileSync(resolve(outDir, "seccomp-exec.c"), scripts.getSeccompExecSource());
writeFileSync(
  resolve(outDir, "ellul-namespaced.service"),
  scripts.getNamespacedDaemonService(),
);
writeFileSync(
  resolve(outDir, "ellul-agent-namespace"),
  scripts.getAgentNamespaceScript(),
);

console.log(`extract-sources: emitted to ${outDir}`);
