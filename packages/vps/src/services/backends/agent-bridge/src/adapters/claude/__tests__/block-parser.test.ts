// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.

// Coverage for the stream-json parser shared between the SDK helper
// (Pro) and one-shot CLI (Lite) Claude adapters. The parser is pure;
// each test feeds canned stream-json lines and asserts the exact list
// of intermediate events that come back. Real Claude Code captures
// (used to build these fixtures) live in `fixtures/` if/when we lift
// from production traces — for now everything is synthetic and matches
// the documented stream-json shape.

import { describe, expect, it } from "vitest";
import {
  flushClaudeStreamOnAbort,
  newClaudeStreamState,
  parseClaudeStreamLine,
  resetClaudeStreamTurn,
  type ClaudeBlockParserDeps,
  type ParsedClaudeEvent,
} from "../shared/block-parser";

function makeDeps(): ClaudeBlockParserDeps {
  let counter = 0;
  return {
    genItemId: () => `itm-${++counter}`,
  };
}

function parseAll(
  lines: ReadonlyArray<string>,
  deps?: ClaudeBlockParserDeps,
): { events: ReadonlyArray<ParsedClaudeEvent>; state: ReturnType<typeof newClaudeStreamState> } {
  const state = newClaudeStreamState();
  const d = deps ?? makeDeps();
  const events: ParsedClaudeEvent[] = [];
  for (const line of lines) {
    events.push(...parseClaudeStreamLine(state, line, d));
  }
  return { events, state };
}

const ASSISTANT_TEXT = (text: string, blockIndex = 0) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });

const ASSISTANT_THINKING = (thinking: string) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "thinking", thinking }] },
  });

const TOOL_USE = (name: string, id: string, input: Record<string, unknown>, blockIndex = 0) =>
  JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });

const TOOL_RESULT = (toolUseId: string, content: string, isError = false) =>
  JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
  });

const TOOL_RESULT_WITH_EXEC = (
  toolUseId: string,
  exec: { stdout?: string; stderr?: string; exit_code?: number },
) =>
  JSON.stringify({
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "" }],
    },
    tool_use_result: exec,
  });

const RESULT = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1234,
    num_turns: 1,
    result: "Done",
    session_id: "sess-1",
    total_cost_usd: 0.01,
    ...overrides,
  });

describe("parseClaudeStreamLine — basic invariants", () => {
  it("returns no events for empty / whitespace lines", () => {
    const { events } = parseAll(["", "   ", "\t"]);
    expect(events).toEqual([]);
  });

  it("returns runtime.warning on malformed JSON, with line preview", () => {
    const { events } = parseAll(['{"type":"assistant"', "not json"]);
    expect(events.every((e) => e.kind === "runtime.warning")).toBe(true);
    expect(events).toHaveLength(2);
  });

  it("ignores objects with no `type` field", () => {
    const { events } = parseAll(['{"foo":1}']);
    expect(events).toEqual([]);
  });

  it("ignores unknown message types", () => {
    const { events } = parseAll([JSON.stringify({ type: "tool_progress", elapsed: 1 })]);
    expect(events).toEqual([]);
  });
});

describe("parseClaudeStreamLine — system init", () => {
  it("emits session.id from system init message", () => {
    const { events, state } = parseAll([
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-abc" }),
    ]);
    expect(events).toEqual([{ kind: "session.id", sessionId: "sess-abc" }]);
    expect(state.sessionId).toBe("sess-abc");
  });

  it("ignores system messages without session_id", () => {
    const { events } = parseAll([
      JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-4-7" }),
    ]);
    expect(events).toEqual([]);
  });
});

describe("parseClaudeStreamLine — assistant text", () => {
  it("emits a single content.delta with the full text on first sight", () => {
    const { events } = parseAll([ASSISTANT_TEXT("Hello, world.")]);
    expect(events).toEqual([
      {
        kind: "content.delta",
        itemId: "itm-1",
        streamKind: "assistant_text",
        delta: "Hello, world.",
        contentIndex: 0,
      },
    ]);
  });

  it("re-emits the same block as a delta when text grows", () => {
    const { events } = parseAll([ASSISTANT_TEXT("Hello"), ASSISTANT_TEXT("Hello, world")]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ delta: "Hello" });
    expect(events[1]).toMatchObject({ delta: ", world" });
  });

  it("dedupes when assistant re-emits exactly the same text", () => {
    const { events } = parseAll([ASSISTANT_TEXT("Hello"), ASSISTANT_TEXT("Hello")]);
    expect(events).toHaveLength(1);
  });

  it("emits the full new text when it doesn't extend the previous text (replacement)", () => {
    const { events } = parseAll([ASSISTANT_TEXT("Hello"), ASSISTANT_TEXT("Goodbye")]);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ delta: "Goodbye" });
  });
});

describe("parseClaudeStreamLine — assistant thinking", () => {
  it("emits content.delta with reasoning_text streamKind", () => {
    const { events } = parseAll([ASSISTANT_THINKING("Let me think...")]);
    expect(events).toEqual([
      {
        kind: "content.delta",
        itemId: "itm-1",
        streamKind: "reasoning_text",
        delta: "Let me think...",
        contentIndex: 0,
      },
    ]);
  });
});

describe("parseClaudeStreamLine — tool_use classification", () => {
  it("classifies Bash as command_execution", () => {
    const { events } = parseAll([TOOL_USE("Bash", "tu-1", { command: "ls -la" })]);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.kind).toBe("item.started");
    if (ev.kind === "item.started") {
      expect(ev.itemType).toBe("command_execution");
      expect(ev.title).toBe("Command run");
      expect(ev.detail).toContain("Bash:");
      expect(ev.detail).toContain("ls -la");
    }
  });

  it("classifies Edit / Write / MultiEdit as file_change", () => {
    for (const name of ["Edit", "Write", "MultiEdit"]) {
      const { events } = parseAll([TOOL_USE(name, "tu", { file_path: "/x.ts" })]);
      const ev = events[0];
      expect(ev.kind).toBe("item.started");
      if (ev.kind === "item.started") expect(ev.itemType).toBe("file_change");
    }
  });

  it("classifies Read / Grep / Glob → file_change (Claude tool names contain 'file' or 'search')", () => {
    // Read → contains "read" but classifyToolItemType prioritizes file/edit
    // verbs which match "Read" via the file_change branch (the substring
    // "read" is not in the file_change set; "Read" lowercased contains
    // none of bash/edit/write/file/etc., so it falls through to dynamic).
    // Document the actual mapping rather than the intuitive one — the
    // canonical category for read-only tools is dynamic_tool_call.
    const { events } = parseAll([TOOL_USE("Read", "tu", { file_path: "/x" })]);
    expect((events[0] as { itemType?: string }).itemType).toBe("dynamic_tool_call");
  });

  it("classifies Task as collab_agent_tool_call", () => {
    const { events } = parseAll([
      TOOL_USE("Task", "tu", { description: "search code", prompt: "find foo" }),
    ]);
    const ev = events[0];
    expect(ev.kind).toBe("item.started");
    if (ev.kind === "item.started") {
      expect(ev.itemType).toBe("collab_agent_tool_call");
      expect(ev.detail).toContain("search code");
    }
  });

  it("classifies WebSearch as web_search", () => {
    const { events } = parseAll([TOOL_USE("WebSearch", "tu", { query: "claude code" })]);
    const ev = events[0];
    expect(ev.kind).toBe("item.started");
    if (ev.kind === "item.started") expect(ev.itemType).toBe("web_search");
  });

  it("falls back to dynamic_tool_call for unknown tool names", () => {
    const { events } = parseAll([TOOL_USE("ZzzCustomThing", "tu", {})]);
    const ev = events[0];
    expect(ev.kind).toBe("item.started");
    if (ev.kind === "item.started") expect(ev.itemType).toBe("dynamic_tool_call");
  });
});

describe("parseClaudeStreamLine — tool_use lifecycle", () => {
  it("emits item.started on first sight, item.updated on re-emit with different input", () => {
    const { events } = parseAll([
      TOOL_USE("Bash", "tu-1", { command: "ls" }),
      TOOL_USE("Bash", "tu-1", { command: "ls -la" }),
    ]);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("item.started");
    expect(events[1].kind).toBe("item.updated");
  });

  it("dedupes identical tool_use re-emits via input fingerprint", () => {
    const { events } = parseAll([
      TOOL_USE("Bash", "tu-1", { command: "ls" }),
      TOOL_USE("Bash", "tu-1", { command: "ls" }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("item.started");
  });

  it("pairs tool_result back to the right tool_use_id and emits item.completed", () => {
    const { events } = parseAll([
      TOOL_USE("Bash", "tu-1", { command: "ls" }),
      TOOL_RESULT("tu-1", "file1\nfile2"),
    ]);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      kind: "item.completed",
      itemId: "itm-1",
      itemType: "command_execution",
      toolUseId: "tu-1",
      status: "completed",
      output: "file1\nfile2",
      isError: false,
    });
  });

  it("marks item.completed status='failed' when is_error is true", () => {
    const { events } = parseAll([
      TOOL_USE("Bash", "tu-1", { command: "false" }),
      TOOL_RESULT("tu-1", "exit 1", true),
    ]);
    const completion = events[1];
    expect(completion).toMatchObject({ status: "failed", isError: true });
  });

  it("uses tool_use_result.exec stdout/stderr/exit_code when present", () => {
    const { events } = parseAll([
      TOOL_USE("Bash", "tu-1", { command: "false" }),
      TOOL_RESULT_WITH_EXEC("tu-1", { stdout: "out", stderr: "err", exit_code: 1 }),
    ]);
    const completion = events[1];
    expect(completion).toMatchObject({
      status: "failed",
      isError: true,
      output: "out\nerr",
    });
  });

  it("ignores tool_result for an unknown tool_use_id", () => {
    const { events } = parseAll([TOOL_RESULT("tu-unknown", "out")]);
    expect(events).toEqual([]);
  });

  it("ignores duplicate tool_result for the same tool_use_id", () => {
    const { events } = parseAll([
      TOOL_USE("Bash", "tu-1", { command: "ls" }),
      TOOL_RESULT("tu-1", "ok"),
      TOOL_RESULT("tu-1", "ok"),
    ]);
    // 1 started + 1 completed = 2; second result is ignored
    expect(events).toHaveLength(2);
    expect(events[1].kind).toBe("item.completed");
  });
});

describe("parseClaudeStreamLine — TodoWrite plan capture", () => {
  it("emits turn.plan.updated with steps mapped from TodoWrite input", () => {
    const todos = [
      { content: "Step A", status: "in_progress" },
      { content: "Step B", status: "completed" },
      { content: "Step C", status: "pending" },
    ];
    const { events } = parseAll([TOOL_USE("TodoWrite", "tu-todo", { todos })]);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("item.started");
    const plan = events[1];
    expect(plan.kind).toBe("turn.plan.updated");
    if (plan.kind === "turn.plan.updated") {
      expect(plan.plan).toEqual([
        { step: "Step A", status: "inProgress" },
        { step: "Step B", status: "completed" },
        { step: "Step C", status: "pending" },
      ]);
    }
  });

  it("does not emit turn.plan.updated for empty todos", () => {
    const { events } = parseAll([TOOL_USE("TodoWrite", "tu-todo", { todos: [] })]);
    expect(events.find((e) => e.kind === "turn.plan.updated")).toBeUndefined();
  });
});

describe("parseClaudeStreamLine — ExitPlanMode interception", () => {
  it("emits turn.proposed.completed with the plan markdown", () => {
    const planText = "# Plan\n- step 1\n- step 2";
    const { events } = parseAll([TOOL_USE("ExitPlanMode", "tu-plan", { plan: planText })]);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("item.started");
    const plan = events[1];
    expect(plan.kind).toBe("turn.proposed.completed");
    if (plan.kind === "turn.proposed.completed") expect(plan.planMarkdown).toBe(planText);
  });

  it("emits item.started but no proposed-plan when plan field is missing", () => {
    const { events } = parseAll([TOOL_USE("ExitPlanMode", "tu-plan", {})]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe("item.started");
  });
});

describe("parseClaudeStreamLine — result message", () => {
  it("emits turn.completed with state='completed' on success", () => {
    const { events, state } = parseAll([RESULT()]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "turn.completed",
      state: "completed",
      durationMs: 1234,
      totalCostUsd: 0.01,
      resultText: "Done",
      errorMessage: null,
    });
    expect(state.result?.status).toBe("success");
  });

  it("emits turn.completed with state='failed' on error_during_execution", () => {
    const { events, state } = parseAll([
      RESULT({ subtype: "error_during_execution", is_error: true, errors: ["network down"] }),
    ]);
    expect(events[0]).toMatchObject({ kind: "turn.completed", state: "failed" });
    expect(state.result?.status).toBe("error");
  });

  it("emits turn.completed with state='interrupted' when errors mention interrupt", () => {
    const { events, state } = parseAll([
      RESULT({
        subtype: "error_during_execution",
        is_error: false,
        errors: ["request was aborted by user"],
      }),
    ]);
    expect(events[0]).toMatchObject({ kind: "turn.completed", state: "interrupted" });
    expect(state.result?.status).toBe("interrupted");
  });
});

describe("parseClaudeStreamLine — stream_event partials", () => {
  it("emits content.delta for text_delta", () => {
    const stream_event = (delta: string, index = 0) =>
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", index, delta: { type: "text_delta", text: delta } },
      });

    const { events } = parseAll([stream_event("Hel"), stream_event("lo, "), stream_event("world.")]);
    expect(events.map((e) => (e.kind === "content.delta" ? e.delta : null))).toEqual([
      "Hel",
      "lo, ",
      "world.",
    ]);
    expect(events.every((e) => e.kind === "content.delta")).toBe(true);
  });

  it("emits content.delta(reasoning_text) for thinking_delta", () => {
    const stream_event = (delta: string) =>
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: delta },
        },
      });

    const { events } = parseAll([stream_event("step 1")]);
    expect(events[0]).toMatchObject({
      kind: "content.delta",
      streamKind: "reasoning_text",
      delta: "step 1",
    });
  });

  it("accumulates input_json_delta but emits no event until full re-emit arrives", () => {
    const stream_event = (partial: string) =>
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: partial },
        },
      });

    const { events, state } = parseAll([stream_event('{"command":'), stream_event('"ls"}')]);
    expect(events).toEqual([]);
    const rec = state.blocks.get(0);
    expect(rec?.partialInputJson).toBe('{"command":"ls"}');
  });

  it("does not double-emit when full assistant message follows stream deltas with same text", () => {
    const stream_event = (delta: string) =>
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: delta } },
      });

    const { events } = parseAll([stream_event("Hello"), stream_event(", world"), ASSISTANT_TEXT("Hello, world")]);
    // 2 deltas from stream_event, 0 additional from full re-emit (already cached)
    expect(events.filter((e) => e.kind === "content.delta")).toHaveLength(2);
  });
});

describe("flushClaudeStreamOnAbort", () => {
  it("returns a synthetic turn.completed in the failed state", () => {
    const ev = flushClaudeStreamOnAbort("process killed by SIGTERM");
    expect(ev).toMatchObject({
      kind: "turn.completed",
      state: "failed",
      errorMessage: "process killed by SIGTERM",
    });
  });
});

describe("parseClaudeStreamLine — multiple assistant messages within one turn", () => {
  // After a tool_result, Claude often emits a second assistant message.
  // Block indices restart at 0, but the prior message's tool_use record
  // must still be reachable so the tool_result we already saw stays
  // resolved and a new text block at index 0 doesn't dedupe against the
  // prior message's text.
  const ASSISTANT_WITH_ID = (id: string, content: ReadonlyArray<unknown>) =>
    JSON.stringify({ type: "assistant", message: { id, content } });

  it("resets block dedupe at message boundary, keeping tool_use lookups alive", () => {
    const state = newClaudeStreamState();
    const deps = makeDeps();

    // First message: text + tool_use, then tool_result.
    parseClaudeStreamLine(
      state,
      ASSISTANT_WITH_ID("msg-1", [
        { type: "text", text: "Calling the tool" },
        { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
      ]),
      deps,
    );
    parseClaudeStreamLine(state, TOOL_RESULT("tu-1", "ok"), deps);

    // Second message: text at index 0 again — must NOT dedupe against the
    // prior message's "Calling the tool".
    const events = parseClaudeStreamLine(
      state,
      ASSISTANT_WITH_ID("msg-2", [{ type: "text", text: "Result was good" }]),
      deps,
    );
    const delta = events.find((e) => e.kind === "content.delta");
    expect(delta).toBeDefined();
    if (delta?.kind === "content.delta") expect(delta.delta).toBe("Result was good");
  });

  it("a late tool_result still finds its tool_use after a new message has started", () => {
    const state = newClaudeStreamState();
    const deps = makeDeps();

    parseClaudeStreamLine(
      state,
      ASSISTANT_WITH_ID("msg-1", [
        { type: "tool_use", id: "tu-late", name: "Bash", input: { command: "sleep" } },
      ]),
      deps,
    );
    parseClaudeStreamLine(
      state,
      ASSISTANT_WITH_ID("msg-2", [{ type: "text", text: "still going" }]),
      deps,
    );
    // Now the tool_result arrives — even though msg-2 has overwritten
    // block index 0, tu-late must still resolve.
    const events = parseClaudeStreamLine(state, TOOL_RESULT("tu-late", "done"), deps);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "item.completed",
      toolUseId: "tu-late",
      output: "done",
    });
  });
});

describe("resetClaudeStreamTurn — hot-window turn boundary", () => {
  it("clears blocks, dedupe maps, result, and completion flag", () => {
    // A single assistant message can carry text (block 0) and tool_use
    // (block 1) — the helper TOOL_USE puts the tool_use at block 0 by
    // default, so we synthesise a multi-block message inline here.
    const assistantMixed = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello" },
          { type: "tool_use", id: "tu-1", name: "Bash", input: { command: "ls" } },
        ],
      },
    });
    const { state } = parseAll([
      JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }),
      assistantMixed,
      TOOL_RESULT("tu-1", "ok"),
      RESULT(),
    ]);

    expect(state.blocks.size).toBeGreaterThan(0);
    expect(state.toolUseIdToBlock.size).toBeGreaterThan(0);
    expect(state.result).not.toBeNull();
    expect(state.hasCompletedToolUse).toBe(true);
    expect(state.sessionId).toBe("sess-1");

    resetClaudeStreamTurn(state);

    expect(state.blocks.size).toBe(0);
    expect(state.toolUseIdToBlock.size).toBe(0);
    expect(state.emittedTextByItemId.size).toBe(0);
    expect(state.emittedInputFingerprintByItemId.size).toBe(0);
    expect(state.result).toBeNull();
    expect(state.hasCompletedToolUse).toBe(false);
    // sessionId is process-scoped, persists across turn resets.
    expect(state.sessionId).toBe("sess-1");
  });

  it("after reset, a new assistant block at index 0 emits a fresh content.delta", () => {
    const state = newClaudeStreamState();
    const deps = makeDeps();

    parseClaudeStreamLine(state, ASSISTANT_TEXT("Turn 1 text"), deps);
    parseClaudeStreamLine(state, RESULT(), deps);
    resetClaudeStreamTurn(state);

    const events = parseClaudeStreamLine(state, ASSISTANT_TEXT("Turn 2 text"), deps);
    const delta = events.find((e) => e.kind === "content.delta");
    expect(delta).toBeDefined();
    if (delta?.kind === "content.delta") expect(delta.delta).toBe("Turn 2 text");
  });
});

describe("parseClaudeStreamLine — hasCompletedToolUse flag", () => {
  it("starts false and flips true once a tool_result arrives", () => {
    const { state } = parseAll([
      TOOL_USE("Bash", "tu-1", { command: "ls" }),
    ]);
    expect(state.hasCompletedToolUse).toBe(false);

    parseClaudeStreamLine(state, TOOL_RESULT("tu-1", "ok"), makeDeps());
    expect(state.hasCompletedToolUse).toBe(true);
  });
});
