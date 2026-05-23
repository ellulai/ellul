import * as fs from "fs";
import { logEvent } from "./event-log";

type SignalType = "version-block" | "api-deprecation" | "binary-missing" | "sdk-drift";

interface VersionErrorPattern {
  adapter: string;
  pattern: RegExp;
  signalType: SignalType;
}

const VERSION_ERROR_PATTERNS: VersionErrorPattern[] = [
  { adapter: "claude-code", pattern: /your version of Claude Code.*needs an update/i, signalType: "version-block" },
  { adapter: "codex", pattern: /Missing optional dependency @openai\/codex-/i, signalType: "binary-missing" },
  { adapter: "opencode", pattern: /package manager failed to install the right version/i, signalType: "sdk-drift" },
  { adapter: "cursor", pattern: /Please update to the latest version of Cursor/i, signalType: "version-block" },
  { adapter: "grok", pattern: /Please update.*grok|your.*grok.*version.*outdated/i, signalType: "version-block" },
];

export interface VersionSignal {
  adapter: string;
  installedVersion: string;
  errorPattern: string;
  stderrSample: string;
  exitCode: number | undefined;
  signalType: SignalType;
}

export function detectVersionSignal(
  adapter: string,
  stderrTail: string,
  exitCode: number | undefined,
): VersionSignal | null {
  for (const entry of VERSION_ERROR_PATTERNS) {
    if (entry.adapter !== adapter) continue;
    const match = stderrTail.match(entry.pattern);
    if (match) {
      return {
        adapter,
        installedVersion: extractVersion(stderrTail) ?? "unknown",
        errorPattern: match[0].slice(0, 200),
        stderrSample: stderrTail.slice(-512),
        exitCode,
        signalType: entry.signalType,
      };
    }
  }
  return null;
}

function extractVersion(text: string): string | null {
  const m = text.match(/(\d+\.\d+\.\d+)/);
  return m?.[1] ?? null;
}

// Throttle: one signal per adapter per 5 min
const lastSignalAt = new Map<string, number>();
const SIGNAL_THROTTLE_MS = 5 * 60 * 1000;

const API_URL_FILE = "/etc/ellul/api-url";
const SERVER_ID_FILE = "/etc/ellul/server-id";

function resolveApiUrl(): string | null {
  try { return fs.readFileSync(API_URL_FILE, "utf8").trim(); } catch { return null; }
}

function resolveServerId(): string | null {
  try { return fs.readFileSync(SERVER_ID_FILE, "utf8").trim(); } catch { return null; }
}

export async function emitVersionSignal(signal: VersionSignal): Promise<void> {
  const apiUrl = resolveApiUrl();
  const serverId = resolveServerId();
  const token = process.env.AI_PROXY_TOKEN?.trim();
  if (!apiUrl || !serverId || !token) return;
  const now = Date.now();
  const last = lastSignalAt.get(signal.adapter) ?? 0;
  if (now - last < SIGNAL_THROTTLE_MS) return;
  lastSignalAt.set(signal.adapter, now);

  logEvent("adapter.version.signal.emitted", {
    adapter: signal.adapter,
    signalType: signal.signalType,
    installedVersion: signal.installedVersion,
  });

  try {
    await fetch(`${apiUrl}/api/servers/${serverId}/adapter-version-signal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(signal),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    logEvent("adapter.version.signal.failed", { adapter: signal.adapter });
  }
}
