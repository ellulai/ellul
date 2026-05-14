// SPDX-License-Identifier: MIT

import { describe, it, expect } from "vitest";
import {
  createSandboxStream,
  SandboxStreamError_,
  type SandboxProgressEvent,
} from "./create-sandbox-stream";

/**
 * SSE parser under stress. The real network splits events across TCP
 * reads in ways that naive implementations miss — the parser must cope
 * with:
 *   - events split mid-chunk (`event: pro` | `gress\ndata: {…}\n\n`)
 *   - multiple events in one chunk
 *   - terminal events immediately followed by EOF
 *   - malformed frames (ignored, no crash)
 *   - empty/heartbeat frames (ignored)
 */

function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const fakeApp = {
  kind: "app",
  name: "my-app",
  directory: "sbx-abcdefg/my-app",
  displayName: "my-app",
  path: "/home/dev/projects/sbx-abcdefg/my-app",
  sandboxId: "sbx-abcdefg",
  appRoot: "sbx-abcdefg/my-app",
  framework: "next",
  scripts: [],
  type: "frontend",
  previewable: true,
  isMonorepo: false,
  hasPackageJson: true,
  port: 4000,
  workspacePackages: [],
  subdir: "my-app",
} as const;

function runStream(chunks: string[], onProgress?: (e: SandboxProgressEvent) => void) {
  return createSandboxStream({
    endpoint: "/api/apps/create",
    fetcher: async () => sseResponse(chunks),
    payload: { name: "x", type: "scaffold", framework: "next" },
    onProgress,
  });
}

describe("createSandboxStream SSE parser", () => {
  it("resolves with done payload for a well-formed single-chunk stream", async () => {
    const result = await runStream([
      `event: progress\ndata: {"stage":"creating_sandbox"}\n\n`,
      `event: done\ndata: ${JSON.stringify({ success: true, installing: false, app: fakeApp })}\n\n`,
    ]);
    expect(result.success).toBe(true);
    expect(result.app.directory).toBe("sbx-abcdefg/my-app");
  });

  it("re-assembles events split across chunk boundaries", async () => {
    const progress: SandboxProgressEvent[] = [];
    const result = await runStream(
      [
        // Frame split mid-event name — classic TCP fragmentation.
        "event: prog",
        "ress\ndata: {\"stage\":\"scaffolding\",\"framework\":\"next\"}\n",
        "\nevent: done\ndata: ",
        JSON.stringify({ success: true, installing: false, app: fakeApp }),
        "\n\n",
      ],
      (e) => progress.push(e),
    );
    expect(progress).toEqual([{ stage: "scaffolding", framework: "next" }]);
    expect(result.installing).toBe(false);
  });

  it("fires multiple progress events emitted in a single chunk", async () => {
    const progress: SandboxProgressEvent[] = [];
    await runStream(
      [
        `event: progress\ndata: {"stage":"creating_sandbox"}\n\n` +
          `event: progress\ndata: {"stage":"cloning"}\n\n` +
          `event: progress\ndata: {"stage":"installing_deps"}\n\n` +
          `event: done\ndata: ${JSON.stringify({ success: true, installing: true, app: fakeApp })}\n\n`,
      ],
      (e) => progress.push(e),
    );
    expect(progress.map((e) => e.stage)).toEqual([
      "creating_sandbox",
      "cloning",
      "installing_deps",
    ]);
  });

  it("rejects with SandboxStreamError_ on error event", async () => {
    await expect(
      runStream([
        `event: error\ndata: ${JSON.stringify({ error: "Clone failed", code: "clone_failed" })}\n\n`,
      ]),
    ).rejects.toMatchObject({
      name: "SandboxStreamError",
      message: "Clone failed",
      code: "clone_failed",
    });
  });

  it("rejects when stream closes without a terminal event", async () => {
    await expect(
      runStream([`event: progress\ndata: {"stage":"creating_sandbox"}\n\n`]),
    ).rejects.toBeInstanceOf(SandboxStreamError_);
  });

  it("ignores malformed frames without crashing", async () => {
    const result = await runStream([
      `garbage no-colon line\n\n`,
      `event: progress\n\n`, // no data field
      `event: progress\ndata: not-json\n\n`, // data not JSON
      `event: done\ndata: ${JSON.stringify({ success: true, installing: false, app: fakeApp })}\n\n`,
    ]);
    expect(result.success).toBe(true);
  });

  it("handles terminal event on final chunk with trailing whitespace only", async () => {
    const result = await runStream([
      `event: done\ndata: ${JSON.stringify({ success: true, installing: false, app: fakeApp })}\n\n\n`,
    ]);
    expect(result.installing).toBe(false);
  });

  it("propagates AbortSignal to the underlying fetch", async () => {
    // The helper passes the caller's signal straight through to fetch(); the
    // browser's fetch implementation rejects with AbortError when the signal
    // fires. We assert the signal reaches the fetcher, which is what the
    // real OnboardingFlow Cancel button relies on.
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const promise = createSandboxStream({
      endpoint: "/api/apps/create",
      fetcher: async (_url, init) => {
        seen = init?.signal ?? undefined;
        // Simulate fetch's behavior: reject with AbortError when the signal fires.
        if (seen?.aborted) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" });
        }
        return new Promise<Response>((_resolve, reject) => {
          seen?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      },
      payload: { name: "x", type: "scaffold", framework: "next" },
      signal: controller.signal,
    });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toBe(controller.signal);
  });
});
