// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Tests for the vault-backed provider session directory. The module
// owns two contracts that have load-bearing UX consequences:
//
//   1. writeCheckpoint MUST NOT fail the upsert Effect when the binding
//      has no sessionId yet. The status="starting" upsert that the
//      adapter does immediately after spawning a session has no
//      sessionId — failing that path was the root of the
//      first-message-fail bug. This test is the regression rail.
//
//   2. The directory rehydrates its in-memory ref from the vault on
//      construction so a bridge restart doesn't leave threads with no
//      adapter binding (which surfaces as "Provider not ready" in the
//      UI). This test ensures bindings written on one process boot
//      survive into the next.

import { describe, expect, it, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Option, Ref, Scope } from "effect";
import type { ThreadId, ProviderKind } from "@ellul.ai/types";

import {
  __TEST_setCheckpointService,
  makeProviderSessionDirectoryVaultBacked,
} from "./session-directory-vault";
import {
  makeSessionCheckpointService,
  type SessionCheckpointService,
} from "../application/runtime-control/SessionCheckpointService";

let vaultDir: string;
let svc: SessionCheckpointService;

beforeEach(() => {
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "ellul-vault-dir-"));
  // Inject a fresh checkpoint service per test so the cached one
  // (getCheckpointService) doesn't leak DEFAULT_VAULT into our tmpdir.
  svc = makeSessionCheckpointService({ vaultRoot: vaultDir });
  __TEST_setCheckpointService(svc);
});

function runEffect<A>(effect: Effect.Effect<A>): Promise<A> {
  return Effect.runPromise(Effect.scoped(effect));
}

describe("session-directory-vault — writeCheckpoint regression rail", () => {
  it("upsert with status='starting' and no sessionId does NOT fail", async () => {
    // This is the path adapter.startSession takes immediately after
    // spawning the underlying provider session. The sessionId arrives
    // on a later upsert; the first one must complete cleanly so the
    // user's first message reaches the adapter.
    const dir = await runEffect(makeProviderSessionDirectoryVaultBacked());
    const result = await Effect.runPromiseExit(
      dir.upsert({
        threadId: "thread-no-sid" as ThreadId,
        provider: "opencode" as ProviderKind,
        status: "starting",
      }),
    );
    expect(result._tag).toBe("Success");
  });

  it("in-memory binding is set even when checkpoint is skipped", async () => {
    const dir = await runEffect(makeProviderSessionDirectoryVaultBacked());
    await runEffect(
      dir.upsert({
        threadId: "thread-no-sid" as ThreadId,
        provider: "opencode" as ProviderKind,
        status: "starting",
      }),
    );
    const found = await runEffect(dir.getBinding("thread-no-sid" as ThreadId));
    expect(Option.isSome(found)).toBe(true);
    if (Option.isSome(found)) {
      expect(found.value.provider).toBe("opencode");
      expect(found.value.status).toBe("starting");
    }
  });

  it("upsert with sessionId DOES persist to vault", async () => {
    const dir = await runEffect(makeProviderSessionDirectoryVaultBacked());
    await runEffect(
      dir.upsert({
        threadId: "thread-with-sid" as ThreadId,
        provider: "codex" as ProviderKind,
        status: "running",
        resumeCursor: { sessionId: "codex-thread-abc" },
      }),
    );
    // The vault checkpoint service should now have an entry.
    const list = await svc.list();
    const entry = list.find((e) => e.threadId === "thread-with-sid");
    expect(entry).toBeDefined();
    expect(entry?.adapter).toBe("codex");
  });

  it("works through 'starting' → 'running' lifecycle: first upsert skipped, second persists", async () => {
    const dir = await runEffect(makeProviderSessionDirectoryVaultBacked());
    // Step 1: status="starting", no sessionId — vault is empty after
    await runEffect(
      dir.upsert({
        threadId: "thread-lifecycle" as ThreadId,
        provider: "cursor" as ProviderKind,
        status: "starting",
      }),
    );
    let list = await svc.list();
    expect(list.find((e) => e.threadId === "thread-lifecycle")).toBeUndefined();
    // Step 2: status="running" with sessionId — vault now has it
    await runEffect(
      dir.upsert({
        threadId: "thread-lifecycle" as ThreadId,
        provider: "cursor" as ProviderKind,
        status: "running",
        resumeCursor: { sessionId: "cursor-session-xyz" },
      }),
    );
    list = await svc.list();
    expect(list.find((e) => e.threadId === "thread-lifecycle")).toBeDefined();
  });
});

describe("session-directory-vault — rehydrate on construction", () => {
  it("loads previously-persisted bindings into the in-memory ref", async () => {
    // Seed the vault with a checkpoint as if the previous bridge
    // process wrote it before crashing.
    await svc.checkpoint(
      "rehydrated-thread-id",
      "opencode",
      {
        resumeCursor: { sessionId: "opencode-session-rehydrate" },
        runtimePayload: null,
        status: "running",
        adapterKey: null,
      },
      "opencode-session-rehydrate",
      1,
    );

    // Construct a fresh directory — should pick up the seeded binding.
    const dir = await runEffect(makeProviderSessionDirectoryVaultBacked());
    const found = await runEffect(dir.getBinding("rehydrated-thread-id" as ThreadId));
    expect(Option.isSome(found)).toBe(true);
    if (Option.isSome(found)) {
      expect(found.value.provider).toBe("opencode");
      expect(found.value.status).toBe("running");
      expect((found.value.resumeCursor as { sessionId?: string })?.sessionId).toBe(
        "opencode-session-rehydrate",
      );
    }
  });

  it("listThreadIds returns rehydrated threads", async () => {
    await svc.checkpoint(
      "rehydrate-1",
      "claude",
      { resumeCursor: { sessionId: "s1" }, runtimePayload: null, status: "running", adapterKey: null },
      "s1",
      1,
    );
    await svc.checkpoint(
      "rehydrate-2",
      "codex",
      { resumeCursor: { sessionId: "s2" }, runtimePayload: null, status: "running", adapterKey: null },
      "s2",
      1,
    );
    const dir = await runEffect(makeProviderSessionDirectoryVaultBacked());
    const ids = await runEffect(dir.listThreadIds());
    expect(new Set(ids)).toEqual(new Set(["rehydrate-1", "rehydrate-2"]));
  });

  it("rehydrate failure on one thread does not prevent loading the others", async () => {
    // Write two valid checkpoints; corrupt one of them after the fact.
    await svc.checkpoint(
      "good-thread",
      "opencode",
      { resumeCursor: { sessionId: "good-sid" }, runtimePayload: null, status: "running", adapterKey: null },
      "good-sid",
      1,
    );
    await svc.checkpoint(
      "bad-thread",
      "cursor",
      { resumeCursor: { sessionId: "bad-sid" }, runtimePayload: null, status: "running", adapterKey: null },
      "bad-sid",
      1,
    );
    fs.writeFileSync(path.join(vaultDir, "bad-thread", "1.json"), "{not valid json");

    const dir = await runEffect(makeProviderSessionDirectoryVaultBacked());
    const goodFound = await runEffect(dir.getBinding("good-thread" as ThreadId));
    expect(Option.isSome(goodFound)).toBe(true);
    // Bad thread either loads (if list returns its meta) and then load
    // throws and is swallowed, or doesn't appear at all. Either way,
    // construction succeeded and the good thread is present.
  });

  it("empty vault yields empty in-memory state without error", async () => {
    // Vault dir exists but has no thread subdirs.
    fs.mkdirSync(vaultDir, { recursive: true });
    const dir = await runEffect(makeProviderSessionDirectoryVaultBacked());
    const ids = await runEffect(dir.listThreadIds());
    expect(ids).toEqual([]);
  });
});
