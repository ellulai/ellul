// SPDX-License-Identifier: MIT
"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { useVisualViewport } from "@/hooks/useVisualViewport";

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}

// Uses a portal to render at document root to avoid stacking context issues.
export function Sheet({ open, onOpenChange, children }: SheetProps) {
  const [mounted, setMounted] = React.useState(false);
  const vh = useVisualViewport();

  // Only render portal on client
  React.useEffect(() => {
    setMounted(true);
  }, []);

  // Handle escape key
  React.useEffect(() => {
    if (!open) return;

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onOpenChange(false);
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [open, onOpenChange]);

  // Prevent body scroll when open
  React.useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open || !mounted) return null;

  return createPortal(
    <div className="fixed inset-x-0 top-0 z-[200] flex items-end md:items-center justify-center" style={{ height: vh }}>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in-0 duration-200"
        onClick={() => onOpenChange(false)}
      />

      {/* Content */}
      <div
        className={cn(
          "relative w-full bg-card border border-border",
          "h-[calc(100%-0.5rem)] overflow-hidden flex flex-col",
          // Mobile: full width, rounded top only
          "rounded-t-xl border-b-0",
          // Desktop: constrained width, fully rounded, centered
          "md:max-w-lg md:rounded-xl md:border-b md:mx-4 md:h-auto md:max-h-[80vh]",
          // Animation
          "animate-in slide-in-from-bottom-4 md:slide-in-from-bottom-0 md:zoom-in-95 duration-200"
        )}
        style={{
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

interface SheetHeaderProps {
  children: React.ReactNode;
  className?: string;
}

export function SheetHeader({ children, className }: SheetHeaderProps) {
  return (
    <div
      className={cn(
        "flex px-4 py-3 border-b border-cream/10 shrink-0",
        className
      )}
    >
      {children}
    </div>
  );
}

interface SheetContentProps {
  children: React.ReactNode;
  className?: string;
}

export function SheetContent({ children, className }: SheetContentProps) {
  return (
    <div className={cn("flex-1 overflow-y-auto", className)}>{children}</div>
  );
}
