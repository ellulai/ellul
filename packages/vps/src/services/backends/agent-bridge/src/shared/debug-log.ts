import * as fs from "fs";

export const DEBUG_LOG_PATH = "/var/log/ellul/agent-bridge-debug.log";

export function debugLog(msg: string, prefix?: string): void {
  try {
    const line = prefix
      ? `[${new Date().toISOString()}] ${prefix} ${msg}\n`
      : `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(DEBUG_LOG_PATH, line);
  } catch {}
}
