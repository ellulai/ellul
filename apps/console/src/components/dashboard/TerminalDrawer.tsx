// SPDX-License-Identifier: MIT
"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Terminal, X, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

const MIN_HEIGHT = 180;
const MAX_HEIGHT_RATIO = 0.75;
const DEFAULT_HEIGHT = 300;
const STORAGE_KEY = "ellul-terminal-drawer-height";

function clampHeight(h: number): number {
  const max = typeof window !== "undefined"
    ? window.innerHeight * MAX_HEIGHT_RATIO
    : 600;
  return Math.max(MIN_HEIGHT, Math.min(h, max));
}

interface TerminalDrawerProps {
  serverDomain: string;
  open: boolean;
  onToggle: () => void;
}

export function TerminalDrawer({ serverDomain, open, onToggle }: TerminalDrawerProps) {
  const t = useTranslations("console.terminalDrawer");
  const [height, setHeight] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_HEIGHT;
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? clampHeight(Number(saved)) : DEFAULT_HEIGHT;
  });

  const resizeRef = useRef<{ startY: number; startH: number } | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Persist height on change
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(height));
  }, [height]);

  // Clamp on window resize
  useEffect(() => {
    const onResize = () => setHeight((h) => clampHeight(h));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      resizeRef.current = { startY: e.clientY, startH: height };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [height]
  );

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!resizeRef.current) return;
    const delta = resizeRef.current.startY - e.clientY; // dragging up = bigger
    setHeight(clampHeight(resizeRef.current.startH + delta));
  }, []);

  const handlePointerEnd = useCallback(() => {
    resizeRef.current = null;
  }, []);

  if (!open) return null;

  const termUrl = `https://${serverDomain}/_term/main/`;

  return (
    <div
      ref={drawerRef}
      className="relative shrink-0 border-t border-border bg-card/80"
      style={{ height }}
    >
      {/* Resize handle */}
      <div
        className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize hover:bg-sodium/20 transition-colors"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      />

      {/* Header bar */}
      <div className="flex items-center justify-between h-8 px-3 border-b border-border/60 bg-card/60">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Terminal className="h-3.5 w-3.5" />
          <span className="font-medium">{t("title")}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onToggle}
            className="p-1 rounded hover:bg-cream/10 text-cream/60 hover:text-cream transition-colors"
            title={t("minimize")}
          >
            <Minus className="h-3 w-3" />
          </button>
          <button
            onClick={onToggle}
            className="p-1 rounded hover:bg-cream/10 text-cream/60 hover:text-cream transition-colors"
            title={t("close")}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Terminal iframe */}
      <iframe
        src={termUrl}
        className="w-full border-0 bg-black"
        style={{ height: height - 32 }} // subtract header
        title={t("iframeTitle")}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  );
}
