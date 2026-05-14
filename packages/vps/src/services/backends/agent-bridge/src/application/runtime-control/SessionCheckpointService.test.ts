// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSessionCheckpointService, redact } from "./SessionCheckpointService";

function vault() {
  return mkdtempSync(join(tmpdir(), "checkpoint-"));
}

describe("redact", () => {
  it("strips Anthropic OATs", () => {
    expect(redact("sk-ant-oat01-sajhsv1234567890abcdef end-of-line")).toBe("[redacted] end-of-line");
    const r = redact({ token: "sk-ant-oat01-XXXXXXXXXXXXXXXXXXXX" });
    expect((r as { token: string }).token).toBe("[redacted]");
  });

  it("strips API keys / GitHub PATs / Slack bot tokens / AWS keys", () => {
    expect(redact("ghp_abcdefghijklmnopqrstuvwx")).toBe("[redacted]");
    expect(redact("xoxb-1234567890-abcdefghij")).toBe("[redacted]");
    expect(redact("AKIA0123456789ABCDEF")).toBe("[redacted]");
  });

  it("redacts keys whose name matches token/key/secret etc.", () => {
    const r = redact({ apiKey: "abc", api_key: "abc", password: "x", innocuous: "ok", nested: { authorization: "Bearer x" } });
    const s = r as Record<string, unknown>;
    expect(s.apiKey).toBe("[redacted]");
    expect(s.api_key).toBe("[redacted]");
    expect(s.password).toBe("[redacted]");
    expect(s.innocuous).toBe("ok");
    expect((s.nested as Record<string, string>).authorization).toBe("[redacted]");
  });

  it("recurses into arrays", () => {
    const r = redact([{ token: "ghp_abcdefghijklmnopqrstuvwx" }, "plain"]);
    expect((r as Array<Record<string, string>>)[0]!.token).toBe("[redacted]");
  });

  it("preserves null/undefined/numbers/booleans", () => {
    expect(redact(null)).toBeNull();
    expect(redact(undefined)).toBeUndefined();
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
  });
});

describe("SessionCheckpointService", () => {
  it("round-trips a Claude checkpoint", async () => {
    const svc = makeSessionCheckpointService({ vaultRoot: vault() });
    const payload = { transcript: ["hi", "there"], cursor: 5 };
    await svc.checkpoint("thread1", "claude", payload, "session-abc", 3, "sbx-abc1234");
    const cp = await svc.load("thread1");
    expect(cp).not.toBeNull();
    expect(cp!.adapter).toBe("claude");
    expect(cp!.sessionId).toBe("session-abc");
    expect(cp!.turn).toBe(3);
    expect(cp!.payload).toEqual(payload);
  });

  it("redacts secrets in payload before writing", async () => {
    const svc = makeSessionCheckpointService({ vaultRoot: vault() });
    const payload = { token: "sk-ant-oat01-XXXXXXXXXXXXXXXXXXXX", history: [{ role: "user", content: "hi sk-ant-api01-XXXXXXXXXXXXXXXXXXXX" }] };
    await svc.checkpoint("threadX", "opencode", payload, "session-y", 1);
    const cp = await svc.load("threadX");
    const p = cp!.payload as { token: string; history: Array<{ role: string; content: string }> };
    expect(p.token).toBe("[redacted]");
    expect(p.history[0]!.content).toContain("[redacted]");
  });

  it("returns null for unknown thread", async () => {
    const svc = makeSessionCheckpointService({ vaultRoot: vault() });
    expect(await svc.load("nope")).toBeNull();
  });

  it("forget() removes the thread directory", async () => {
    const svc = makeSessionCheckpointService({ vaultRoot: vault() });
    await svc.checkpoint("t", "codex", { x: 1 }, "s", 1);
    expect(await svc.load("t")).not.toBeNull();
    await svc.forget("t");
    expect(await svc.load("t")).toBeNull();
  });

  it("list() reports every persisted thread with current turn", async () => {
    const svc = makeSessionCheckpointService({ vaultRoot: vault() });
    await svc.checkpoint("a", "claude", {}, "s1", 5);
    await svc.checkpoint("b", "cursor", {}, "s2", 7);
    const list = await svc.list();
    const ids = list.map((e) => e.threadId).sort();
    expect(ids).toEqual(["a", "b"]);
    const a = list.find((e) => e.threadId === "a")!;
    expect(a.adapter).toBe("claude");
    expect(a.turn).toBe(5);
  });

  it("returns latest turn from load()", async () => {
    const svc = makeSessionCheckpointService({ vaultRoot: vault() });
    await svc.checkpoint("t", "codex", { v: 1 }, "s", 1);
    await svc.checkpoint("t", "codex", { v: 2 }, "s", 2);
    await svc.checkpoint("t", "codex", { v: 3 }, "s", 3);
    const cp = await svc.load("t");
    expect(cp!.turn).toBe(3);
    expect((cp!.payload as { v: number }).v).toBe(3);
  });

  it("garbage-collects checkpoints beyond maxTurnCheckpoints", async () => {
    const svc = makeSessionCheckpointService({ vaultRoot: vault(), maxTurnCheckpoints: 3 });
    for (let t = 1; t <= 10; t++) await svc.checkpoint("t", "codex", { v: t }, "s", t);
    const cp = await svc.load("t");
    expect(cp!.turn).toBe(10);
    const list = await svc.list();
    expect(list).toHaveLength(1);
  });

  it("rejects invalid threadId", async () => {
    const svc = makeSessionCheckpointService({ vaultRoot: vault() });
    await expect(svc.checkpoint("../../etc/passwd", "claude", {}, "s", 1)).rejects.toThrow(/invalid threadId/);
    await expect(svc.checkpoint("a/b", "claude", {}, "s", 1)).rejects.toThrow(/invalid threadId/);
  });

  it("serialises concurrent checkpoints for same thread (no corruption)", async () => {
    const svc = makeSessionCheckpointService({ vaultRoot: vault() });
    const N = 30;
    await Promise.all(
      Array.from({ length: N }, (_, i) => svc.checkpoint("t", "codex", { i }, "s", i + 1)),
    );
    const cp = await svc.load("t");
    expect(cp!.turn).toBe(N);
  });

  it("constructor throws if vault root cannot be created", () => {
    expect(() => makeSessionCheckpointService({ vaultRoot: "/proc/cannot/mkdir/here/" + Math.random() })).toThrow();
  });

  it("write throws if vault becomes unwritable", async () => {
    const svc = makeSessionCheckpointService({ vaultRoot: vault() });
    await svc.checkpoint("t", "codex", { v: 1 }, "s", 1);
    await svc.forget("t");
    await svc.checkpoint("t", "codex", { v: 2 }, "s", 2);
    expect((await svc.load("t"))!.turn).toBe(2);
  });
});
