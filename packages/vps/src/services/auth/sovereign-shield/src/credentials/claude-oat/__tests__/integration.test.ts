// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

/**
 * Integration tests with real infrastructure (filesystem, crypto).
 *
 * Verifies:
 *   - Encryption at rest: token plaintext doesn't leak into the JSON
 *     store or the audit log on disk.
 *   - Crash safety: state survives a "restart" (rebuild the module
 *     against the same data dir).
 *   - Tamper detection: out-of-band store mutation flips state to
 *     revoked on next read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("../../../config", () => ({
  SHIELD_DATA_DIR: "/tmp/test-overridden",
  SERVER_ID_FILE: "/tmp/test-overridden",
}));

import {
  buildClaudeOatModule,
  buildClaudeOatPorts,
  type ClaudeOatModule,
} from "../bootstrap";

const VALID_OAT =
  "sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let dataDir: string;
let module: ClaudeOatModule;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ellul-claude-oat-int-"));
  const ports = buildClaudeOatPorts({
    dataDir,
    serverIdPath: path.join(dataDir, ".server-id"),
  });
  module = buildClaudeOatModule(ports);
});

afterEach(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {}
});

describe("encryption at rest", () => {
  it("OAT plaintext is never written to disk", () => {
    module.saveToken({ token: VALID_OAT, sessionId: "s" });
    const storeRaw = fs.readFileSync(path.join(dataDir, "claude-oat.json"), "utf8");
    expect(storeRaw).not.toContain(VALID_OAT);
    expect(storeRaw).not.toContain(VALID_OAT.slice(13));
    const auditRaw = fs.readFileSync(
      path.join(dataDir, "claude-oat.audit.jsonl"),
      "utf8",
    );
    expect(auditRaw).not.toContain(VALID_OAT);
  });

  it("redeem still returns the original plaintext", () => {
    module.saveToken({ token: VALID_OAT, sessionId: "s" });
    const i = module.issueOat({ threadId: "t", project: null });
    const r = module.redeemOat({ issuanceToken: i.issuanceToken });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.token).toBe(VALID_OAT);
  });
});

describe("crash safety (restart simulation)", () => {
  it("state survives across a re-bootstrap", () => {
    module.saveToken({ token: VALID_OAT, sessionId: "s" });
    expect(module.peek().state).toBe("active");

    // Simulate restart: rebuild the module with the same data dir.
    const ports2 = buildClaudeOatPorts({
      dataDir,
      serverIdPath: path.join(dataDir, ".server-id"),
    });
    const module2 = buildClaudeOatModule(ports2);
    expect(module2.peek().state).toBe("active");
    expect(module2.getTokenForProbe()).toBe(VALID_OAT);
  });

  it("audit chain seq continues across restart", () => {
    module.saveToken({ token: VALID_OAT, sessionId: "s" });
    const auditPath = path.join(dataDir, "claude-oat.audit.jsonl");
    const before = fs.readFileSync(auditPath, "utf8").trim().split("\n").length;

    const ports2 = buildClaudeOatPorts({
      dataDir,
      serverIdPath: path.join(dataDir, ".server-id"),
    });
    const module2 = buildClaudeOatModule(ports2);
    module2.issueOat({ threadId: "t", project: null });

    const after = fs.readFileSync(auditPath, "utf8").trim().split("\n").length;
    expect(after).toBeGreaterThan(before);

    // Verify chain integrity: each entry's prevHash matches preceding hash.
    const entries = fs
      .readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { seq: number; prevHash: string; hash: string });
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.prevHash).toBe(entries[i - 1]!.hash);
    }
    // Sequence is monotonic.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]!.seq).toBe(entries[i - 1]!.seq + 1);
    }
  });
});

describe("tamper detection", () => {
  it("out-of-band corruption flips state to revoked on next probe", () => {
    module.saveToken({ token: VALID_OAT, sessionId: "s" });
    const storePath = path.join(dataDir, "claude-oat.json");
    const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
    store.active.wrappedToken =
      "AAAA" + (store.active.wrappedToken as string).slice(4);
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

    // Rebuild to clear the in-memory cache, then trigger an unwrap.
    const ports2 = buildClaudeOatPorts({
      dataDir,
      serverIdPath: path.join(dataDir, ".server-id"),
    });
    const module2 = buildClaudeOatModule(ports2);
    expect(module2.getTokenForProbe()).toBeNull();
    expect(module2.peek().state).toBe("revoked");
    expect(module2.peek().revokedReason).toBe("tamper-detected");
  });
});
