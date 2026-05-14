// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.
//
// harness.ts — drive the full opcode set against a running
// ellul-namespaced daemon. Imports the production EllulNamespacedClient
// so any divergence between bridge code and CI test is caught at the
// source.
//
// Run order:
//   1. Cgroup canary           — fail if not inside ellul-agent-bridge.service
//   2. Feature-flag preconds   — nsd-client-enabled, manifest.pub present
//   3. HEALTH (admin)          — daemon up, pubkey fp echoed
//   4. CREATE_PROJECT          — admin op, daemon binds per-project socket
//   5. SETUP                   — daemon delegates to bash wrapper
//   6. HEALTH (per-project)    — confirms per-project socket reachable
//   7. ATTEST                  — daemon walks anchor mountinfo vs manifest
//   8. INJECT_ENV              — sealed env memfd, daemon-controlled inode
//   9. ENTER                   — fd-passed argv/env/stdio, child runs to exit
//  10. TEARDOWN                — daemon delegates to bash wrapper
//  11. DROP_PROJECT            — admin op, daemon unbinds socket
//  12. Event-log assertions    — every required nsd.* tag observed; no auth.deny
//
// Any step's failure aborts the whole run with exit code 1.
// No try/catch swallows.

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import {
  EllulNamespacedClient,
  isNsdClientEnabled,
} from "../../../src/services/backends/agent-bridge/src/application/namespace/EllulNamespacedClient.js";
import { expectEvent, expectNoEvent, readEventsSince } from "./event-log.js";

const PROJECT = process.env["NSD_VM_PROJECT"] ?? "sbx-cit0001";
const PROJECT_RE = /^sbx-[a-z0-9]{7}$/;

if (!PROJECT_RE.test(PROJECT)) {
  console.error(`harness: invalid project slug ${PROJECT}`);
  process.exit(1);
}

function assertCgroup(): void {
  const cg = fs.readFileSync("/proc/self/cgroup", "utf8");
  if (!cg.includes("/ellul-agent-bridge.service")) {
    throw new Error(
      `harness: process is not inside ellul-agent-bridge.service cgroup:\n${cg}`,
    );
  }
}

function ensureProjectWorkspace(): void {
  const home = process.env["HOME"];
  if (!home) throw new Error("harness: HOME must be set");
  const projectDir = path.join(home, "projects", PROJECT);
  fs.mkdirSync(projectDir, { recursive: true });
  /* The bash setup expects a few dotdirs to exist; pre-create so its
   * overlay-lowerdir step has something to bind. */
  for (const d of [".config", ".claude", ".cursor", ".opencode", ".local", ".cache"]) {
    fs.mkdirSync(path.join(home, d), { recursive: true });
  }
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  process.stdout.write(`[harness] ${label} … `);
  const t0 = Date.now();
  try {
    const v = await fn();
    process.stdout.write(`ok (${Date.now() - t0}ms)\n`);
    return v;
  } catch (err) {
    process.stdout.write(`FAIL (${Date.now() - t0}ms)\n`);
    throw err;
  }
}

async function main(): Promise<void> {
  const startedAtMs = Date.now();

  assertCgroup();
  if (!isNsdClientEnabled()) {
    throw new Error(
      "harness: bridge preconditions absent (nsd-client-enabled flag, manifest.pub, or fd-pass binary)",
    );
  }
  ensureProjectWorkspace();

  // ── HEALTH (admin) ────────────────────────────────────────
  await step("admin HEALTH", async () => {
    const client = await EllulNamespacedClient.tryConnectAdmin();
    if (!client) throw new Error("admin connect returned null");
    try {
      const r = await client.health();
      if (!r.ok) throw new Error(`health ok=false: ${r.errorMessage}`);
      if (r.uptimeMs === undefined || r.uptimeMs < 0) {
        throw new Error(`health uptime invalid: ${r.uptimeMs}`);
      }
      if (!r.manifestPubFp) {
        throw new Error("health missing manifest fingerprint");
      }
    } finally {
      client.close();
    }
  });

  // ── CREATE_PROJECT ────────────────────────────────────────
  await step("admin CREATE_PROJECT", async () => {
    const client = await EllulNamespacedClient.tryConnectAdmin();
    if (!client) throw new Error("admin connect returned null");
    try {
      const r = await client.createProject(PROJECT);
      if (!r.ok) throw new Error(`createProject failed: errcode=${r.errcode} msg=${r.errorMessage}`);
    } finally {
      client.close();
    }
  });

  // The per-project socket should now exist.
  const ctlSock = `/run/ellul-ns/${PROJECT}/ctl.sock`;
  for (let i = 0; i < 25; i++) {
    if (fs.existsSync(ctlSock)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!fs.existsSync(ctlSock)) {
    throw new Error(`harness: per-project socket ${ctlSock} missing after CREATE_PROJECT`);
  }

  // BYOK Phase 1: CREATE_PROJECT must have provisioned a per-project secret
  // at /var/lib/ellul/byok/<slug>/secret (root:root 0400, 32 bytes). The
  // harness runs as $NSD_TEST_USER so we can't directly read the file —
  // shell out to `sudo stat` and assert on the metadata.
  const byokSecret = `/var/lib/ellul/byok/${PROJECT}/secret`;
  await step("BYOK Phase 1: per-project secret created with right perms", async () => {
    const r = spawnSync("sudo", ["stat", "-c", "%a %u %g %s", byokSecret], {
      encoding: "utf8",
    });
    if (r.status !== 0) {
      throw new Error(`byok secret stat failed: ${r.stderr || r.stdout}`);
    }
    const [mode, uid, gid, size] = r.stdout.trim().split(/\s+/);
    if (mode !== "400") throw new Error(`byok secret mode ${mode} != 400`);
    if (uid !== "0") throw new Error(`byok secret uid ${uid} != 0`);
    if (gid !== "0") throw new Error(`byok secret gid ${gid} != 0`);
    if (size !== "32") throw new Error(`byok secret size ${size} != 32`);
  });

  // ── SETUP ─────────────────────────────────────────────────
  const phaseLogPath = "/var/log/ellul/nsd-phase.log";
  const phaseLogPreSize = fs.existsSync(phaseLogPath)
    ? fs.statSync(phaseLogPath).size
    : 0;
  await step("admin SETUP", async () => {
    const client = await EllulNamespacedClient.tryConnectAdmin();
    if (!client) throw new Error("admin connect returned null");
    try {
      const r = await client.setup(PROJECT, {});
      if (!r.ok || !r.success) {
        throw new Error(
          `setup failed: ok=${r.ok} success=${r.success} errcode=${r.errcode} msg=${r.errorMessage}`,
        );
      }
      if (!r.anchorPid || r.anchorPid <= 0) {
        throw new Error(`setup returned no anchorPid: ${r.anchorPid}`);
      }
    } finally {
      client.close();
    }
  });

  // C1: SETUP must run mount-staging in-daemon, never fork-exec the bash
  // wrapper. Phase log records action=nsd-stage on the new path and
  // action=nsd-setup exec begin/end on the legacy bash fork. Assert the
  // post-SETUP log slice has nsd-stage and zero nsd-setup-exec markers.
  if (fs.existsSync(phaseLogPath)) {
    const fd = fs.openSync(phaseLogPath, "r");
    const stat = fs.statSync(phaseLogPath);
    const slice = Buffer.alloc(Math.max(0, stat.size - phaseLogPreSize));
    if (slice.length > 0) {
      fs.readSync(fd, slice, 0, slice.length, phaseLogPreSize);
    }
    fs.closeSync(fd);
    const text = slice.toString("utf8");
    if (!text.includes("action=nsd-stage")) {
      throw new Error(
        `harness: SETUP did not emit nsd-stage phase markers; legacy bash path may have been used. Tail:\n${text.slice(-2000)}`,
      );
    }
    if (/action=nsd-setup\b.*\bphase=exec\b/.test(text)) {
      throw new Error(
        `harness: SETUP fork-exec'd the bash wrapper (action=nsd-setup phase=exec found). Tail:\n${text.slice(-2000)}`,
      );
    }
  }

  // ── HEALTH (per-project) ──────────────────────────────────
  await step("per-project HEALTH", async () => {
    const client = await EllulNamespacedClient.tryConnect(PROJECT);
    if (!client) throw new Error(`per-project connect returned null for ${PROJECT}`);
    try {
      const r = await client.health();
      if (!r.ok) throw new Error(`per-project health ok=false: ${r.errorMessage}`);
    } finally {
      client.close();
    }
  });

  // ── ATTEST ────────────────────────────────────────────────
  // The bash wrapper's mount topology is the source of truth for a
  // matching attest. If it diverges from the manifest, ATTEST returns
  // matches=false with a list of mismatches — the test fails so the
  // operator can reconcile manifest <-> wrapper.
  await step("per-project ATTEST", async () => {
    const client = await EllulNamespacedClient.tryConnect(PROJECT);
    if (!client) throw new Error(`per-project connect returned null for ${PROJECT}`);
    try {
      const r = await client.attest();
      if (!r.ok) throw new Error(`attest call failed: ${r.errorMessage} errcode=${r.errcode}`);
      if (!r.anchorAlive) throw new Error("attest: anchor not alive");
      if (!r.matches) {
        throw new Error(
          `attest: namespace does not match manifest. mismatches=${JSON.stringify(r.mismatches ?? [])}`,
        );
      }
      if (!r.mountinfoDigest) throw new Error("attest: missing mountinfo digest");
    } finally {
      client.close();
    }
  });

  // ── INJECT_ENV ────────────────────────────────────────────
  // EllulNamespacedClient currently exposes ENTER but not INJECT_ENV
  // as a public method on per-project clients (it's invoked
  // out-of-band by the bash spawn path). For the harness we drive the
  // raw INJECT_ENV through a per-project client by extending it via
  // a thin internal accessor — see note below.
  //
  // ENTER coverage is the load-bearing acceptance gate here; INJECT_ENV
  // is exercised end-to-end by the daemon's adversarial test
  // (reject-on-bad-seal) in adversarial.ts.

  // ── BYOK Phase 3: WRAP via daemon, then ENTER with __byok-v1: marker
  // env value. The spawned child dumps environ; we assert the plaintext
  // landed in the child's environ verbatim.
  const byokPlaintext = "sk-ant-test-deadbeef-not-a-real-key-7890";
  const byokProvider = "anthropic";
  let byokMarker: string | null = null;
  await step("BYOK Phase 3: byokWrap returns ciphertext", async () => {
    const ciphertext = await EllulNamespacedClient.byokWrap(
      PROJECT,
      byokProvider,
      Buffer.from(byokPlaintext, "utf8"),
    );
    if (ciphertext.length < 24 + byokPlaintext.length + 16) {
      throw new Error(`byokWrap ciphertext too short: ${ciphertext.length}`);
    }
    byokMarker = `__byok-v1:${byokProvider}:${ciphertext.toString("base64")}`;
  });

  // ── ENTER + cgroup readback ──────────────────────────────
  // Run /bin/sh inside the namespace so we can dump the child's cgroup-v2
  // line on stdout. Asserts the daemon moved the worker into the anchor's
  // cgroup (/ellul-ns-<project>.service) rather than letting it inherit
  // the daemon's own ellul-namespaced.service.
  await step("ENTER + anchor cgroup placement + BYOK inline unwrap", async () => {
    if (!byokMarker) {
      throw new Error("byokMarker not set — BYOK wrap step did not run");
    }
    const child = EllulNamespacedClient.enter(
      PROJECT,
      ["/bin/sh", "-c",
       "cat /proc/self/cgroup; echo hello-world; echo BYOK_VALUE=\"$ANTHROPIC_API_KEY\""],
      {
        env: {
          LANG: "C.UTF-8",
          ANTHROPIC_API_KEY: byokMarker,
        },
      },
    );
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    if (!child.stdout || !child.stderr) {
      throw new Error("ENTER child missing stdio streams");
    }
    child.stdout.on("data", (b: Buffer) => stdoutChunks.push(b));
    child.stderr.on("data", (b: Buffer) => stderrChunks.push(b));

    const exitCode = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        reject(new Error("ENTER child did not exit within 30s"));
      }, 30_000);
      child.on("error", (err: Error) => { clearTimeout(timer); reject(err); });
      child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        clearTimeout(timer);
        if (signal) reject(new Error(`child died on signal ${signal}`));
        else if (code === null) reject(new Error("child exit code null"));
        else resolve(code);
      });
    });

    const out = Buffer.concat(stdoutChunks).toString("utf8");
    const errOut = Buffer.concat(stderrChunks).toString("utf8");
    if (exitCode !== 0) {
      throw new Error(`ENTER child exited ${exitCode}; stderr=${errOut}`);
    }
    if (!out.includes("hello-world")) {
      throw new Error(`ENTER stdout missing marker: ${JSON.stringify(out)}`);
    }
    /* Inline unwrap: BYOK_VALUE line should carry the plaintext, not
     * the __byok-v1: marker. */
    const byokLine = out.split("\n").find((l) => l.startsWith("BYOK_VALUE="));
    if (!byokLine) {
      throw new Error(`ENTER stdout missing BYOK_VALUE line: ${JSON.stringify(out)}`);
    }
    const observed = byokLine.slice("BYOK_VALUE=".length);
    if (observed.startsWith("__byok-v1:")) {
      throw new Error(
        `ENTER did not inline-unwrap __byok-v1: marker (saw raw marker in environ)`,
      );
    }
    if (observed !== byokPlaintext) {
      throw new Error(
        `ENTER inline unwrap mismatch: observed=${JSON.stringify(observed)} expected=${JSON.stringify(byokPlaintext)}`,
      );
    }
    const cgLine = out.split("\n").find((l) => l.startsWith("0::"));
    if (!cgLine) {
      throw new Error(`ENTER stdout missing cgroup-v2 line: ${JSON.stringify(out)}`);
    }
    const expectedSuffix = `/ellul-ns-${PROJECT}.service`;
    const cgPath = cgLine.slice(3);
    if (!cgPath.includes(expectedSuffix)) {
      throw new Error(
        `ENTER child not in anchor cgroup; got ${JSON.stringify(cgPath)}, ` +
          `expected to contain ${expectedSuffix}`,
      );
    }
  });

  // ── TEARDOWN ──────────────────────────────────────────────
  await step("admin TEARDOWN", async () => {
    const client = await EllulNamespacedClient.tryConnectAdmin();
    if (!client) throw new Error("admin connect returned null");
    try {
      const r = await client.teardown(PROJECT);
      if (!r.ok || !r.success) {
        throw new Error(
          `teardown failed: ok=${r.ok} success=${r.success} errcode=${r.errcode} msg=${r.errorMessage}`,
        );
      }
    } finally {
      client.close();
    }
  });

  // ── DROP_PROJECT ──────────────────────────────────────────
  await step("admin DROP_PROJECT", async () => {
    const client = await EllulNamespacedClient.tryConnectAdmin();
    if (!client) throw new Error("admin connect returned null");
    try {
      const r = await client.dropProject(PROJECT);
      if (!r.ok) {
        throw new Error(`dropProject failed: errcode=${r.errcode} msg=${r.errorMessage}`);
      }
    } finally {
      client.close();
    }
  });

  if (fs.existsSync(ctlSock)) {
    /* Daemon should have unlinked the per-project socket on DROP. Give
     * it a beat for filesystem visibility, then assert. */
    for (let i = 0; i < 10; i++) {
      if (!fs.existsSync(ctlSock)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (fs.existsSync(ctlSock)) {
      throw new Error(`harness: per-project socket ${ctlSock} not removed after DROP_PROJECT`);
    }
  }

  // BYOK Phase 1 revocation: secret file must be unlinked by DROP_PROJECT.
  // The unlink-first invariant means even a partial drop has revoked.
  await step("BYOK Phase 1: per-project secret revoked on DROP", async () => {
    const r = spawnSync("sudo", ["stat", byokSecret], {
      encoding: "utf8",
    });
    /* stat returns non-zero with "No such file or directory" on the
     * stderr stream when the file is missing. */
    if (r.status === 0) {
      throw new Error(`byok secret ${byokSecret} still exists after DROP_PROJECT`);
    }
    if (!/No such file or directory/.test(r.stderr || "")) {
      throw new Error(`byok secret stat failed unexpectedly: ${r.stderr || r.stdout}`);
    }
  });

  // ── Event-log assertions ─────────────────────────────────
  // Read everything the daemon + harness wrote since this test started.
  const events = readEventsSince(startedAtMs);

  for (const tag of [
    "nsd.session.open",
    "nsd.admin.create-ok",
    "nsd.setup.ok",
    "nsd.attest.ok",
    "nsd.enter.done",
    "nsd.teardown.ok",
    "nsd.admin.drop-ok",
  ] as const) {
    expectEvent(events, (e) => e.event === tag, tag);
  }

  /* No auth denials should have happened on the happy path. */
  expectNoEvent(events, (e) => e.event === "nsd.auth.deny", "nsd.auth.deny");
  expectNoEvent(events, (e) => e.event === "nsd.replay.deny", "nsd.replay.deny");
  expectNoEvent(events, (e) => e.event === "nsd.attest.mismatch", "nsd.attest.mismatch");

  process.stdout.write(`[harness] all opcodes passed (${Date.now() - startedAtMs}ms total)\n`);
}

main().catch((err) => {
  process.stderr.write(`[harness] FAIL: ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
