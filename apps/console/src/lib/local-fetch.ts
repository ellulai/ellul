// SPDX-License-Identifier: MIT
// Client-side utilities for local VPS communication (Tauri IPC + browser-local).
"use client";

export interface LocalFetchResult {
  status: number;
  body: string;
  content_type: string;
}

function getInvoke(): ((cmd: string, args: Record<string, unknown>) => Promise<unknown>) | null {
  if (typeof window === "undefined") return null;
  return (window as any).__TAURI_INTERNALS__?.invoke ?? null;
}

export function hasTauriInvoke(): boolean {
  return !!getInvoke();
}

const CADDY_PORT = 8443;

export async function localFetch(
  method: string,
  path: string,
  opts?: { body?: string | null; port?: number },
): Promise<LocalFetchResult> {
  const invoke = getInvoke();
  if (!invoke) throw new Error("Tauri not available");
  return invoke("plugin:proot|proot_fetch", {
    method: method.toUpperCase(),
    path,
    body: opts?.body ?? null,
    port: opts?.port ?? CADDY_PORT,
  }) as Promise<LocalFetchResult>;
}

export function localResponse(result: LocalFetchResult): Response {
  return new Response(result.body, {
    status: result.status,
    headers: { "Content-Type": result.content_type || "application/json" },
  });
}
