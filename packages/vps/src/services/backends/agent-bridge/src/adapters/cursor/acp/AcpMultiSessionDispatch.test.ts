// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

// Functional tests for the multi-session dispatch layer. These prove
// the security-critical routing properties of the per-project pool —
// the part of the refactor that the pool/adapter integration tests
// can't reach because they stub the runtime.
//
// What this file proves end-to-end:
//   - session/update for session A populates A's queue, NOT B's
//     (per-session event isolation)
//   - session/request_permission for session A invokes A's permission
//     handler, NOT B's (per-session permission isolation: granting
//     "always allow Bash" in A does not auto-grant in B)
//   - cursor/ask_question with toolCallId X (after a tool_call update
//     on session A registered X → A) routes to A's handler (per-
//     session ext routing via toolCallId map)
//   - Closing session A drops its toolCallId entries; a subsequent
//     cursor/* ext request with a stale toolCallId fails with a
//     clear error (no use-after-close)
//   - Unknown sessionId / unknown toolCallId fail loudly, not silently
//
// Tests don't spawn cursor-agent — they construct fake SessionState
// objects via `makeSessionStateSync` and drive the dispatch fns
// directly. JS-level assertions of routing behavior; the kernel-level
// namespace boundary is asserted elsewhere.

import { describe, it, expect } from "vitest";
import { Effect, Exit, Queue, Ref } from "effect";

import * as EffectAcpErrors from "../../vendor/t3code/effect-acp/errors";
import type * as EffectAcpSchema from "../../vendor/t3code/effect-acp/schema";
import {
  closeSessionInState,
  dispatchRequestPermission,
  dispatchSessionUpdate,
  dispatchUnknownExtNotification,
  dispatchUnknownExtRequest,
  makeSessionStateSync,
  type SessionState,
} from "./AcpMultiSessionDispatch";
import type { AcpParsedSessionEvent } from "./AcpRuntimeModel";

const makeFakeSessionState = (sessionId: string): SessionState =>
  makeSessionStateSync({
    sessionId,
    initializeResult: {
      protocolVersion: 1,
      agentCapabilities: {} as never,
      authMethods: [],
    } as never,
    sessionSetupResult: {
      sessionId,
      configOptions: [],
    } as never,
  });

const drainQueue = (queue: Queue.Queue<AcpParsedSessionEvent>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result: Array<AcpParsedSessionEvent> = [];
      while (true) {
        const next = yield* Queue.poll(queue);
        if (next._tag === "None") return result;
        result.push(next.value);
      }
    }),
  );

const makeSessionUpdateNotification = (
  sessionId: string,
  text: string,
): EffectAcpSchema.SessionNotification =>
  ({
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  }) as never;

const makeToolCallNotification = (
  sessionId: string,
  toolCallId: string,
  status: "pending" | "in_progress" | "completed" | "failed" = "pending",
): EffectAcpSchema.SessionNotification =>
  ({
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId,
      title: "stub tool",
      kind: "execute",
      status,
      rawInput: { command: "echo hi" },
    },
  }) as never;

const makePermissionRequest = (
  sessionId: string,
  toolCallId = "tc-perm-1",
): EffectAcpSchema.RequestPermissionRequest =>
  ({
    sessionId,
    options: [
      { kind: "allow_once", optionId: "allow", name: "Allow once" },
      { kind: "reject_once", optionId: "reject", name: "Reject" },
    ],
    toolCall: {
      toolCallId,
      title: "stub perm tool",
      kind: "execute",
      status: "pending",
      rawInput: {},
    },
  }) as never;

describe("AcpMultiSessionDispatch — per-session event isolation", () => {
  it("session/update routes by params.sessionId; A's events never appear in B's queue", async () => {
    const sessions = new Map<string, SessionState>();
    const toolCallIdToSession = new Map<string, string>();
    const sessA = makeFakeSessionState("sess-A");
    const sessB = makeFakeSessionState("sess-B");
    sessions.set("sess-A", sessA);
    sessions.set("sess-B", sessB);

    await Effect.runPromise(
      dispatchSessionUpdate({
        sessions,
        toolCallIdToSession,
        notification: makeSessionUpdateNotification("sess-A", "hello A"),
      }),
    );
    await Effect.runPromise(
      dispatchSessionUpdate({
        sessions,
        toolCallIdToSession,
        notification: makeSessionUpdateNotification("sess-B", "hello B"),
      }),
    );

    const eventsA = await drainQueue(sessA.eventQueue);
    const eventsB = await drainQueue(sessB.eventQueue);

    // Each session sees only its own content delta. No cross-bleed.
    const aTexts = eventsA.flatMap((e) =>
      e._tag === "ContentDelta" ? [e.text] : [],
    );
    const bTexts = eventsB.flatMap((e) =>
      e._tag === "ContentDelta" ? [e.text] : [],
    );
    expect(aTexts).toEqual(["hello A"]);
    expect(bTexts).toEqual(["hello B"]);
  });

  it("session/update for unknown sessionId is silently dropped (no crash, no cross-bleed)", async () => {
    const sessions = new Map<string, SessionState>();
    const toolCallIdToSession = new Map<string, string>();
    const sessA = makeFakeSessionState("sess-A");
    sessions.set("sess-A", sessA);

    // Inbound notification for an unrelated session must not crash, must
    // not write to A's queue, must not register the toolCallId.
    await Effect.runPromise(
      dispatchSessionUpdate({
        sessions,
        toolCallIdToSession,
        notification: makeSessionUpdateNotification("sess-ghost", "ignored"),
      }),
    );
    expect(await drainQueue(sessA.eventQueue)).toEqual([]);
  });

  it("tool_call notification populates toolCallId → sessionId map for the OWNING session only", async () => {
    const sessions = new Map<string, SessionState>();
    const toolCallIdToSession = new Map<string, string>();
    sessions.set("sess-A", makeFakeSessionState("sess-A"));
    sessions.set("sess-B", makeFakeSessionState("sess-B"));

    await Effect.runPromise(
      dispatchSessionUpdate({
        sessions,
        toolCallIdToSession,
        notification: makeToolCallNotification("sess-A", "tc-A1"),
      }),
    );
    await Effect.runPromise(
      dispatchSessionUpdate({
        sessions,
        toolCallIdToSession,
        notification: makeToolCallNotification("sess-B", "tc-B1"),
      }),
    );

    expect(toolCallIdToSession.get("tc-A1")).toBe("sess-A");
    expect(toolCallIdToSession.get("tc-B1")).toBe("sess-B");
    // Cross-bleed guard.
    expect(toolCallIdToSession.get("tc-A1")).not.toBe("sess-B");
  });

  it("session/update for a closed session is dropped without leaking events", async () => {
    const sessions = new Map<string, SessionState>();
    const toolCallIdToSession = new Map<string, string>();
    const sessA = makeFakeSessionState("sess-A");
    sessions.set("sess-A", sessA);
    await Effect.runPromise(Ref.set(sessA.closed, true));

    await Effect.runPromise(
      dispatchSessionUpdate({
        sessions,
        toolCallIdToSession,
        notification: makeSessionUpdateNotification("sess-A", "post-close"),
      }),
    );

    // Closed flag short-circuited the dispatch; queue is empty.
    expect(await drainQueue(sessA.eventQueue)).toEqual([]);
  });
});

describe("AcpMultiSessionDispatch — per-session permission isolation", () => {
  it("request_permission for sess-A invokes A's handler; B's handler is never called", async () => {
    const sessions = new Map<string, SessionState>();
    const sessA = makeFakeSessionState("sess-A");
    const sessB = makeFakeSessionState("sess-B");
    sessions.set("sess-A", sessA);
    sessions.set("sess-B", sessB);

    let aInvocations = 0;
    let bInvocations = 0;
    sessA.permissionHandler = () =>
      Effect.sync(() => {
        aInvocations += 1;
        return {
          outcome: { outcome: "selected" as const, optionId: "allow-from-A" },
        } as never;
      });
    sessB.permissionHandler = () =>
      Effect.sync(() => {
        bInvocations += 1;
        return {
          outcome: { outcome: "selected" as const, optionId: "allow-from-B" },
        } as never;
      });

    const responseA = await Effect.runPromise(
      dispatchRequestPermission({
        sessions,
        params: makePermissionRequest("sess-A"),
      }),
    );
    const responseB = await Effect.runPromise(
      dispatchRequestPermission({
        sessions,
        params: makePermissionRequest("sess-B"),
      }),
    );

    expect(aInvocations).toBe(1);
    expect(bInvocations).toBe(1);
    // The "allow-always-from-A" handler did NOT auto-grant in B's
    // session — each session has its own handler reference.
    expect((responseA as { outcome: { optionId: string } }).outcome.optionId).toBe(
      "allow-from-A",
    );
    expect((responseB as { outcome: { optionId: string } }).outcome.optionId).toBe(
      "allow-from-B",
    );
  });

  it("request_permission for unknown session fails with invalidParams (NOT a silent drop)", async () => {
    const sessions = new Map<string, SessionState>();
    sessions.set("sess-A", makeFakeSessionState("sess-A"));

    const exit = await Effect.runPromiseExit(
      dispatchRequestPermission({
        sessions,
        params: makePermissionRequest("sess-ghost"),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const err = exit.cause as unknown as { failure?: { errorMessage?: string } };
      const message =
        err.failure?.errorMessage ??
        // Effect Cause may nest the failure differently; fall back to
        // serializing the whole cause if so.
        JSON.stringify(exit.cause);
      expect(message).toMatch(/Unknown session for request_permission/);
    }
  });

  it("request_permission for a session with no registered handler fails with internalError", async () => {
    const sessions = new Map<string, SessionState>();
    sessions.set("sess-A", makeFakeSessionState("sess-A"));

    const exit = await Effect.runPromiseExit(
      dispatchRequestPermission({
        sessions,
        params: makePermissionRequest("sess-A"),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("request_permission on a closed session fails (no use-after-close)", async () => {
    const sessions = new Map<string, SessionState>();
    const sessA = makeFakeSessionState("sess-A");
    sessions.set("sess-A", sessA);
    sessA.permissionHandler = () =>
      Effect.succeed({
        outcome: { outcome: "selected" as const, optionId: "allow" },
      } as never);
    await Effect.runPromise(Ref.set(sessA.closed, true));

    const exit = await Effect.runPromiseExit(
      dispatchRequestPermission({
        sessions,
        params: makePermissionRequest("sess-A"),
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("AcpMultiSessionDispatch — cursor extension routing by toolCallId", () => {
  it("cursor/ask_question with toolCallId from A's tool_call routes to A's handler", async () => {
    const sessions = new Map<string, SessionState>();
    const toolCallIdToSession = new Map<string, string>();
    const sessA = makeFakeSessionState("sess-A");
    const sessB = makeFakeSessionState("sess-B");
    sessions.set("sess-A", sessA);
    sessions.set("sess-B", sessB);

    let aHits = 0;
    let bHits = 0;
    sessA.extRequestHandlers.set("cursor/ask_question", () =>
      Effect.sync(() => {
        aHits += 1;
        return { answers: ["from A"] };
      }),
    );
    sessB.extRequestHandlers.set("cursor/ask_question", () =>
      Effect.sync(() => {
        bHits += 1;
        return { answers: ["from B"] };
      }),
    );

    // A's tool_call registers the routing entry.
    await Effect.runPromise(
      dispatchSessionUpdate({
        sessions,
        toolCallIdToSession,
        notification: makeToolCallNotification("sess-A", "tc-A-ask"),
      }),
    );

    // Cursor extension request with toolCallId tc-A-ask routes to A.
    const result = await Effect.runPromise(
      dispatchUnknownExtRequest({
        sessions,
        toolCallIdToSession,
        method: "cursor/ask_question",
        params: { toolCallId: "tc-A-ask", questions: [] },
      }),
    );

    expect(aHits).toBe(1);
    expect(bHits).toBe(0);
    expect(result).toEqual({ answers: ["from A"] });
  });

  it("cursor extension request with no toolCallId fails with invalidParams", async () => {
    const sessions = new Map<string, SessionState>();
    const toolCallIdToSession = new Map<string, string>();

    const exit = await Effect.runPromiseExit(
      dispatchUnknownExtRequest({
        sessions,
        toolCallIdToSession,
        method: "cursor/ask_question",
        params: { questions: [] },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("cursor extension request with unknown toolCallId fails with invalidParams", async () => {
    const sessions = new Map<string, SessionState>();
    const toolCallIdToSession = new Map<string, string>();
    sessions.set("sess-A", makeFakeSessionState("sess-A"));

    const exit = await Effect.runPromiseExit(
      dispatchUnknownExtRequest({
        sessions,
        toolCallIdToSession,
        method: "cursor/ask_question",
        params: { toolCallId: "tc-ghost", questions: [] },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("cursor extension request for a method the session never registered fails with methodNotFound", async () => {
    const sessions = new Map<string, SessionState>();
    const toolCallIdToSession = new Map<string, string>();
    const sessA = makeFakeSessionState("sess-A");
    sessions.set("sess-A", sessA);
    // tool_call registers the routing entry, but A never registered a
    // handler for cursor/ask_question.
    await Effect.runPromise(
      dispatchSessionUpdate({
        sessions,
        toolCallIdToSession,
        notification: makeToolCallNotification("sess-A", "tc-A1"),
      }),
    );

    const exit = await Effect.runPromiseExit(
      dispatchUnknownExtRequest({
        sessions,
        toolCallIdToSession,
        method: "cursor/ask_question",
        params: { toolCallId: "tc-A1", questions: [] },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const errMessage = JSON.stringify(exit.cause);
      // Static verification that we surface methodNotFound, not a
      // generic 500-class error.
      expect(errMessage).toContain("Method not found");
    }
  });

  it("ext notification with unknown toolCallId is silently dropped (notifications can't fail)", async () => {
    const sessions = new Map<string, SessionState>();
    const toolCallIdToSession = new Map<string, string>();
    sessions.set("sess-A", makeFakeSessionState("sess-A"));

    // Should not throw, should not crash; just drops on the floor.
    await Effect.runPromise(
      dispatchUnknownExtNotification({
        sessions,
        toolCallIdToSession,
        method: "cursor/update_todos",
        params: { toolCallId: "tc-ghost" },
      }),
    );
  });

  it("ext notification routes to the right session's handler", async () => {
    const sessions = new Map<string, SessionState>();
    const toolCallIdToSession = new Map<string, string>();
    const sessA = makeFakeSessionState("sess-A");
    const sessB = makeFakeSessionState("sess-B");
    sessions.set("sess-A", sessA);
    sessions.set("sess-B", sessB);

    let aNotifies = 0;
    let bNotifies = 0;
    sessA.extNotificationHandlers.set("cursor/update_todos", () =>
      Effect.sync(() => {
        aNotifies += 1;
      }),
    );
    sessB.extNotificationHandlers.set("cursor/update_todos", () =>
      Effect.sync(() => {
        bNotifies += 1;
      }),
    );
    await Effect.runPromise(
      dispatchSessionUpdate({
        sessions,
        toolCallIdToSession,
        notification: makeToolCallNotification("sess-A", "tc-A-notify"),
      }),
    );

    await Effect.runPromise(
      dispatchUnknownExtNotification({
        sessions,
        toolCallIdToSession,
        method: "cursor/update_todos",
        params: { toolCallId: "tc-A-notify", merge: false, todos: [] },
      }),
    );

    expect(aNotifies).toBe(1);
    expect(bNotifies).toBe(0);
  });
});

describe("AcpMultiSessionDispatch — close cleanup", () => {
  it("closing a session drops its toolCallId entries; subsequent ext request with stale toolCallId fails", async () => {
    const sessions = new Map<string, SessionState>();
    const toolCallIdToSession = new Map<string, string>();
    const sessA = makeFakeSessionState("sess-A");
    sessions.set("sess-A", sessA);
    await Effect.runPromise(
      dispatchSessionUpdate({
        sessions,
        toolCallIdToSession,
        notification: makeToolCallNotification("sess-A", "tc-X"),
      }),
    );
    expect(toolCallIdToSession.get("tc-X")).toBe("sess-A");

    await Effect.runPromise(
      closeSessionInState({
        sessions,
        toolCallIdToSession,
        sessionId: "sess-A",
      }),
    );

    // Map cleared; sessions map cleared.
    expect(toolCallIdToSession.has("tc-X")).toBe(false);
    expect(sessions.has("sess-A")).toBe(false);

    // A subsequent ext request with the now-stale toolCallId fails.
    const exit = await Effect.runPromiseExit(
      dispatchUnknownExtRequest({
        sessions,
        toolCallIdToSession,
        method: "cursor/ask_question",
        params: { toolCallId: "tc-X", questions: [] },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("closing a session is idempotent — second close is a no-op", async () => {
    const sessions = new Map<string, SessionState>();
    const toolCallIdToSession = new Map<string, string>();
    sessions.set("sess-A", makeFakeSessionState("sess-A"));

    await Effect.runPromise(
      closeSessionInState({ sessions, toolCallIdToSession, sessionId: "sess-A" }),
    );
    // Second close on a sessionId that's already gone — should be a
    // no-op, not a crash.
    await Effect.runPromise(
      closeSessionInState({ sessions, toolCallIdToSession, sessionId: "sess-A" }),
    );
    expect(sessions.size).toBe(0);
  });

  it("closing one session leaves a sibling session in the same project unaffected", async () => {
    const sessions = new Map<string, SessionState>();
    const toolCallIdToSession = new Map<string, string>();
    const sessA = makeFakeSessionState("sess-A");
    const sessB = makeFakeSessionState("sess-B");
    sessions.set("sess-A", sessA);
    sessions.set("sess-B", sessB);

    // Each session registers its own toolCall routes.
    await Effect.runPromise(
      dispatchSessionUpdate({
        sessions,
        toolCallIdToSession,
        notification: makeToolCallNotification("sess-A", "tc-A"),
      }),
    );
    await Effect.runPromise(
      dispatchSessionUpdate({
        sessions,
        toolCallIdToSession,
        notification: makeToolCallNotification("sess-B", "tc-B"),
      }),
    );

    await Effect.runPromise(
      closeSessionInState({ sessions, toolCallIdToSession, sessionId: "sess-A" }),
    );

    // A's routes gone; B's routes intact.
    expect(toolCallIdToSession.has("tc-A")).toBe(false);
    expect(toolCallIdToSession.get("tc-B")).toBe("sess-B");
    expect(sessions.has("sess-A")).toBe(false);
    expect(sessions.has("sess-B")).toBe(true);

    // B's queue still works.
    await Effect.runPromise(
      dispatchSessionUpdate({
        sessions,
        toolCallIdToSession,
        notification: makeSessionUpdateNotification("sess-B", "still alive"),
      }),
    );
    const eventsB = await drainQueue(sessB.eventQueue);
    const bTexts = eventsB.flatMap((e) =>
      e._tag === "ContentDelta" ? [e.text] : [],
    );
    expect(bTexts).toContain("still alive");
  });
});

describe("AcpMultiSessionDispatch — per-session state isolation", () => {
  it("modeStateRef in A is independent of B", async () => {
    const sessA = makeFakeSessionState("sess-A");
    const sessB = makeFakeSessionState("sess-B");
    // Each session's modeStateRef starts undefined (no modes in the
    // fake setupResult) — verify they're DIFFERENT Ref cells, not the
    // same object reference.
    expect(sessA.modeStateRef).not.toBe(sessB.modeStateRef);
    await Effect.runPromise(
      Ref.set(sessA.modeStateRef, {
        currentModeId: "plan",
        availableModes: [{ id: "plan", name: "Plan" }],
      }),
    );
    const aMode = await Effect.runPromise(Ref.get(sessA.modeStateRef));
    const bMode = await Effect.runPromise(Ref.get(sessB.modeStateRef));
    expect(aMode?.currentModeId).toBe("plan");
    expect(bMode).toBeUndefined();
  });

  it("eventQueue, toolCallsRef, configOptionsRef in A are independent of B", () => {
    const sessA = makeFakeSessionState("sess-A");
    const sessB = makeFakeSessionState("sess-B");
    expect(sessA.eventQueue).not.toBe(sessB.eventQueue);
    expect(sessA.toolCallsRef).not.toBe(sessB.toolCallsRef);
    expect(sessA.configOptionsRef).not.toBe(sessB.configOptionsRef);
    expect(sessA.assistantSegmentRef).not.toBe(sessB.assistantSegmentRef);
    // Handler maps are per-session — granting "always allow" in A's
    // map can never auto-grant in B's map.
    expect(sessA.extRequestHandlers).not.toBe(sessB.extRequestHandlers);
    expect(sessA.extNotificationHandlers).not.toBe(sessB.extNotificationHandlers);
  });
});
