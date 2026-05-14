// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2025 ellul.ai. All rights reserved.
//
// Minimal best-effort ndjson event logger. t3code's upstream version uses
// RotatingFileSink from @t3tools/shared/logging; we inline a plain append-only
// writer since the supply chain for RotatingFileSink isn't ported.

import fs from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import type { ThreadId } from "@ellul.ai/types";

import { toSafeThreadAttachmentSegment } from "../shared/attachmentStore";

export type EventNdjsonStream = "native" | "canonical" | "orchestration";

const GLOBAL_THREAD_SEGMENT = "_global";

export interface EventNdjsonLogger {
  readonly filePath: string;
  readonly write: (event: unknown, threadId: ThreadId | null) => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
}

export interface EventNdjsonLoggerOptions {
  readonly stream: EventNdjsonStream;
}

function resolveThreadSegment(raw: string | null | undefined): string {
  const normalized = typeof raw === "string" ? toSafeThreadAttachmentSegment(raw) : null;
  return normalized ?? GLOBAL_THREAD_SEGMENT;
}

function resolveStreamLabel(stream: EventNdjsonStream): string {
  switch (stream) {
    case "native":
      return "NTIVE";
    case "canonical":
    case "orchestration":
    default:
      return "CANON";
  }
}

export const makeEventNdjsonLogger = (
  filePath: string,
  options: EventNdjsonLoggerOptions,
): Effect.Effect<EventNdjsonLogger | undefined> =>
  Effect.sync(() => {
    const handles = new Map<string, fs.WriteStream>();
    const failedSegments = new Set<string>();
    const streamLabel = resolveStreamLabel(options.stream);
    const baseDir = path.dirname(filePath);

    try {
      fs.mkdirSync(baseDir, { recursive: true });
    } catch (err) {
      console.warn(`[${options.stream}-event-logger] mkdir failed ${baseDir}:`, err);
      return undefined;
    }

    const getStream = (segment: string): fs.WriteStream | undefined => {
      if (failedSegments.has(segment)) return undefined;
      const existing = handles.get(segment);
      if (existing) return existing;
      try {
        const threadPath = path.join(baseDir, `${segment}.log`);
        const stream = fs.createWriteStream(threadPath, { flags: "a" });
        stream.on("error", (err) =>
          console.warn(`[${options.stream}-event-logger] write error ${segment}:`, err),
        );
        handles.set(segment, stream);
        return stream;
      } catch (err) {
        console.warn(`[${options.stream}-event-logger] open failed ${segment}:`, err);
        failedSegments.add(segment);
        return undefined;
      }
    };

    return {
      filePath,
      write: (event, threadId) =>
        Effect.sync(() => {
          const segment = resolveThreadSegment(threadId);
          const stream = getStream(segment);
          if (!stream) return;
          try {
            const serialized = JSON.stringify(event);
            stream.write(`[${new Date().toISOString()}] ${streamLabel}: ${serialized}\n`);
          } catch (err) {
            console.warn(`[${options.stream}-event-logger] serialize failed:`, err);
          }
        }),
      close: () =>
        Effect.sync(() => {
          for (const stream of handles.values()) {
            stream.end();
          }
          handles.clear();
          failedSegments.clear();
        }),
    } satisfies EventNdjsonLogger;
  });
