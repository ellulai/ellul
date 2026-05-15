// SPDX-License-Identifier: MIT

// SSE client for POST /api/apps/create. Streams progress events so the

import type { ApiApp } from "@/contexts/AppsListContext";

export type CreateSandboxPayload =
  | { name: string; type: "scaffold"; framework: string; project?: string }
  | { name: string; type: "git"; provider: "github" | "gitlab" | "bitbucket"; repoFullName: string; branch?: string }
  | { name: string; type: "upload" }
  | { name: string; type: "local_path"; localPath: string };

export interface SandboxProgressEvent {
  stage:
    | "creating_sandbox"
    | "scaffolding"
    | "cloning"
    | "uploading"
    | "extracting"
    | "writing_metadata"
    | "installing_deps"
    | "detecting";
  framework?: string;
  repoFullName?: string;
}

export interface SandboxDoneResult {
  success: true;
  installing: boolean;
  app: ApiApp;
}

export interface SandboxStreamError {
  error: string;
  code?: string;
  message?: string;
}

export class SandboxStreamError_ extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "SandboxStreamError";
    this.code = code;
  }
}

interface CreateSandboxStreamOptions {
  endpoint: string;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  payload: CreateSandboxPayload;
  onProgress?: (event: SandboxProgressEvent) => void;
  signal?: AbortSignal;
}

export interface UploadSandboxStreamOptions {
  endpoint: string;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  name: string;
  file: File;
  onProgress?: (event: SandboxProgressEvent) => void;
  signal?: AbortSignal;
}

// Fire POST /api/apps/create and stream SSE progress. Resolves with the
export async function createSandboxStream(
  opts: CreateSandboxStreamOptions,
): Promise<SandboxDoneResult> {
  const { endpoint, fetcher, payload, onProgress, signal } = opts;

  const response = await fetcher(endpoint, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    // File-api never sends a non-200 for SSE once headers are written;
    const text = await response.text().catch(() => "");
    let message = text || `Request failed with status ${response.status}`;
    let code: string | undefined;
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string; code?: string };
        if (parsed.error) message = parsed.error;
        else if (parsed.message) message = parsed.message;
        if (parsed.code) code = parsed.code;
      } catch { /* not JSON — keep raw text */ }
    }
    throw new SandboxStreamError_(message, code);
  }

  if (!response.body) {
    throw new SandboxStreamError_("Response body missing — cannot stream events");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminalResult: SandboxDoneResult | null = null;
  let terminalError: SandboxStreamError_ | null = null;

  const flushFrame = (frame: string): void => {
    if (!frame.trim()) return;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    const dataStr = dataLines.join("\n");
    if (!dataStr) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(dataStr);
    } catch {
      return;
    }

    if (event === "progress") {
      onProgress?.(parsed as SandboxProgressEvent);
    } else if (event === "done") {
      terminalResult = parsed as SandboxDoneResult;
    } else if (event === "error") {
      const payload_ = parsed as SandboxStreamError;
      terminalError = new SandboxStreamError_(
        payload_.message || payload_.error || "Sandbox creation failed",
        payload_.code,
      );
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        flushFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
      if (terminalResult || terminalError) break;
    }
    if (buffer.trim()) flushFrame(buffer);
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  if (terminalError) throw terminalError;
  if (!terminalResult) {
    throw new SandboxStreamError_("Stream closed without a terminal event");
  }
  return terminalResult;
}

export async function uploadSandboxStream(
  opts: UploadSandboxStreamOptions,
): Promise<SandboxDoneResult> {
  const { endpoint, fetcher, name, file, onProgress, signal } = opts;

  const formData = new FormData();
  formData.append("name", name);
  formData.append("type", "upload");
  formData.append("file", file);

  const response = await fetcher(endpoint, {
    method: "POST",
    credentials: "include",
    headers: { Accept: "text/event-stream" },
    body: formData,
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = text || `Upload failed with status ${response.status}`;
    let code: string | undefined;
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: string; message?: string; code?: string };
        if (parsed.error) message = parsed.error;
        else if (parsed.message) message = parsed.message;
        if (parsed.code) code = parsed.code;
      } catch {}
    }
    throw new SandboxStreamError_(message, code);
  }

  if (!response.body) {
    throw new SandboxStreamError_("Response body missing");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminalResult: SandboxDoneResult | null = null;
  let terminalError: SandboxStreamError_ | null = null;

  const flushFrame = (frame: string): void => {
    if (!frame.trim()) return;
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    const dataStr = dataLines.join("\n");
    if (!dataStr) return;
    let parsed: unknown;
    try { parsed = JSON.parse(dataStr); } catch { return; }

    if (event === "progress") onProgress?.(parsed as SandboxProgressEvent);
    else if (event === "done") terminalResult = parsed as SandboxDoneResult;
    else if (event === "error") {
      const p = parsed as SandboxStreamError;
      terminalError = new SandboxStreamError_(p.message || p.error || "Upload failed", p.code);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        flushFrame(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf("\n\n");
      }
      if (terminalResult || terminalError) break;
    }
    if (buffer.trim()) flushFrame(buffer);
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  if (terminalError) throw terminalError;
  if (!terminalResult) throw new SandboxStreamError_("Stream closed without a terminal event");
  return terminalResult;
}
