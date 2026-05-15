// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";
import { TabEditor } from "./tabs/TabEditor";
import type { ApiApp } from "@/contexts/AppsListContext";

type AppInfo = ApiApp;

interface ChatGridProps {
  serverId: string;
  ipAddress: string;
  domain?: string;
  serverDomain: string;
  preferredSession?: "main" | "claw" | "opencode" | "claude" | "codex" | "cursor" | "grok";
  app?: AppInfo | null;
  onUpgrade?: () => void;
}

const MAX_GRID_CELLS = 4;

export function ChatGrid({
  serverId,
  ipAddress,
  domain,
  serverDomain,
  preferredSession = "claw",
  app,
  onUpgrade,
}: ChatGridProps) {
  const t = useTranslations("console.chatGrid");
  // Each cell is an independent TabEditor instance
  const [cells, setCells] = useState<string[]>(() => [`cell-${Date.now()}`]);

  const addCell = useCallback(() => {
    if (cells.length >= MAX_GRID_CELLS) return;
    setCells((prev) => [...prev, `cell-${Date.now()}`]);
  }, [cells.length]);

  const removeCell = useCallback((cellId: string) => {
    setCells((prev) => {
      const next = prev.filter((id) => id !== cellId);
      // Always keep at least 1 cell
      return next.length > 0 ? next : prev;
    });
  }, []);

  return (
    <div className="flex-1 grid gap-1.5 min-h-0 p-1.5" style={{
      gridTemplateColumns: `repeat(${cells.length <= 2 ? cells.length : 2}, 1fr)`,
      gridTemplateRows: cells.length <= 2 ? "1fr" : `repeat(${Math.ceil(cells.length / 2)}, 1fr)`,
    }}>
      {cells.map((cellId) => (
        <div key={cellId} className="relative flex flex-col min-h-0 panel-ascente overflow-hidden rounded-lg">
          {/* Cell header with close button */}
          {cells.length > 1 && (
            <div className="absolute top-1 right-1 z-10">
              <button
                onClick={() => removeCell(cellId)}
                className="p-1 rounded bg-black/40 hover:bg-black/60 text-cream/60 hover:text-cream transition-colors"
                title={t("removeFromGrid")}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}
          <TabEditor
            serverId={serverId}
            ipAddress={ipAddress}
            domain={domain}
            preferredSession={preferredSession}
            visible={true}
            app={app}
            onUpgrade={onUpgrade}
            viewMode="focus"
          />
        </div>
      ))}

      {/* Add cell button */}
      {cells.length < MAX_GRID_CELLS && (
        <button
          onClick={addCell}
          className="flex flex-col items-center justify-center min-h-[200px] rounded-lg border-2 border-dashed border-border hover:border-sodium/30 bg-card/30 hover:bg-card/50 text-cream/45 hover:text-cream/75 transition-all"
        >
          <Plus className="w-8 h-8 mb-2" />
          <span className="text-sm font-medium">{t("addThread")}</span>
          <span className="text-xs text-cream/35 mt-1">{cells.length}/{MAX_GRID_CELLS}</span>
        </button>
      )}
    </div>
  );
}
