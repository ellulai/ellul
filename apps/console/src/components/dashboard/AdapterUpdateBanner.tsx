"use client";

import { useEffect, useState } from "react";
import { Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import type { ServerStatus } from "@/contexts/DashboardContext";

type AdapterUpdates = NonNullable<ServerStatus["adapterUpdates"]>;

const ADAPTER_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  grok: "Grok",
};

export function AdapterUpdateBanner({
  adapterUpdates,
}: {
  adapterUpdates: AdapterUpdates;
}) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const entries = Object.entries(adapterUpdates).filter(
    ([key, val]) => val.status !== "current" && !dismissed.has(key),
  );

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const [key, val] of Object.entries(adapterUpdates)) {
      if (val.status === "updated") {
        timers.push(
          setTimeout(() => setDismissed((s) => new Set(s).add(key)), 5000),
        );
      }
    }
    return () => timers.forEach(clearTimeout);
  }, [adapterUpdates]);

  if (entries.length === 0) return null;

  return (
    <div className="space-y-2">
      {entries.map(([key, val]) => {
        const label = ADAPTER_LABELS[key] ?? key;

        if (val.status === "updating") {
          return (
            <div
              key={key}
              className="flex items-center gap-2 rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-sm text-blue-200"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>
                Updating {label}... This may take a moment.
              </span>
            </div>
          );
        }

        if (val.status === "updated") {
          return (
            <div
              key={key}
              className="flex items-center gap-2 rounded-lg border border-green-500/20 bg-green-500/5 px-4 py-3 text-sm text-green-200"
            >
              <CheckCircle2 className="h-4 w-4" />
              <span>
                {label} updated to v{val.targetVersion}.
              </span>
            </div>
          );
        }

        if (val.status === "failed") {
          return (
            <div
              key={key}
              className="flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-200"
            >
              <AlertTriangle className="h-4 w-4" />
              <span>
                Failed to update {label}.
              </span>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}
