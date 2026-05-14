// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

// This preserves the original requirement that the pill never appears
// - While loading with no prior data, the pill stays hidden — avoids the

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, Loader2, Zap } from "lucide-react";
import { useTranslations } from "use-intl";
import type { ResolvedAction } from "@ellul.ai/types";
import { ACTIONS } from "@ellul.ai/chat-actions";
import { cn } from "@shared/utils";
import { resolveIconKey } from "../actions/icons";
import { resolvePalette } from "../actions/colors";

export interface ActionsDropdownProps {
  // Actions whose availability criteria are met right now.
  resolvedActions: ResolvedAction[];
  // Hook is performing its first fetch.
  loading: boolean;
  // Whether the chat has an active project — suppresses the pill entirely otherwise.
  hasProject: boolean;
  // Action currently being executed — drives per-action spinner + top-of-pill state.
  executingActionId: string | null;
  // the pill visible even when the action would otherwise be hidden.
  pendingGateActionId: string | null;
  // Invoked when the user clicks an action (after any confirmation).
  onExecute: (action: ResolvedAction) => void;
}

export function ActionsDropdown({
  resolvedActions,
  loading,
  hasProject,
  executingActionId,
  pendingGateActionId,
  onExecute,
}: ActionsDropdownProps) {
  const tChat = useTranslations("chat");
  const [open, setOpen] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click — identical behaviour to the original pill.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirmingId(null);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // If the agent requests a gate for an action the resolver would otherwise
  const menuActions = useMemo<ResolvedAction[]>(() => {
    if (!pendingGateActionId) return resolvedActions;
    if (resolvedActions.some((a) => a.id === pendingGateActionId)) {
      return resolvedActions;
    }
    const fromRegistry = ACTIONS.find((a) => a.id === pendingGateActionId);
    if (!fromRegistry) return resolvedActions;
    const injected: ResolvedAction = {
      ...fromRegistry,
      available: true,
      unavailableReason: undefined,
    };
    return [injected, ...resolvedActions];
  }, [resolvedActions, pendingGateActionId]);

  const executing = executingActionId !== null;
  const shouldRender = hasProject && menuActions.length > 0;

  if (!shouldRender) return null;

  const handleClick = (action: ResolvedAction) => {
    if (executing) return;
    if (action.requiresConfirmation && confirmingId !== action.id) {
      setConfirmingId(action.id);
      return;
    }
    setConfirmingId(null);
    setOpen(false);
    onExecute(action);
  };

  return (
    <div className="pointer-events-auto relative ml-auto" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        className={cn(
          "flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-medium transition-colors backdrop-blur-md",
          open
            ? "bg-card/90 text-cream shadow-lg border border-cream/[0.08]"
            : "bg-card/70 text-cream/60 hover:text-cream hover:bg-card/90 border border-cream/[0.06]",
          executing && "text-sodium",
          pendingGateActionId && "text-sodium ring-1 ring-sodium/30",
        )}
      >
        {executing ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <Zap className="w-3.5 h-3.5" />
        )}
        <span className="hidden sm:inline">{tChat("actionsDropdown.actions")}</span>
        <ChevronDown
          className={cn("w-3 h-3 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1.5 w-52 bg-[#1a1a2e] border border-cream/[0.08] rounded-xl shadow-2xl z-50 py-1.5 backdrop-blur-xl"
        >
          {menuActions.map((action) => {
            const Icon = resolveIconKey(action.iconKey);
            const palette = resolvePalette(action.id, action.severity);
            const isExecuting = executingActionId === action.id;
            const isPending = pendingGateActionId === action.id;
            const isConfirming = confirmingId === action.id;

            if (isConfirming) {
              return (
                <div
                  key={action.id}
                  className="px-3.5 py-2.5 border-b border-cream/[0.06] last:border-b-0"
                >
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <AlertTriangle
                      className={cn("h-3.5 w-3.5", palette.iconFg)}
                    />
                    <span className="text-xs font-medium text-cream">
                      {action.severity === "destructive"
                        ? tChat("actionsDropdown.destructive")
                        : tChat("actionsDropdown.areYouSure")}
                    </span>
                  </div>
                  <p className="text-[10px] text-cream/45 mb-2 leading-tight">
                    {action.description}
                  </p>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => setConfirmingId(null)}
                      className="flex-1 px-2 py-1 text-[10px] font-medium rounded bg-cream/[0.05] text-cream/60 hover:text-cream transition-colors"
                    >
                      {tChat("actionsDropdown.cancel")}
                    </button>
                    <button
                      onClick={() => handleClick(action)}
                      className={cn(
                        "flex-1 px-2 py-1 text-[10px] font-medium rounded transition-colors",
                        action.severity === "destructive"
                          ? "bg-terra/20 text-terra hover:bg-terra/30"
                          : "bg-sodium/20 text-sodium hover:bg-sodium/30",
                      )}
                    >
                      {tChat("actionsDropdown.confirm")}
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <button
                key={action.id}
                role="menuitem"
                onClick={() => handleClick(action)}
                disabled={executing && !isExecuting}
                className="flex items-center gap-3 w-full px-3.5 py-2.5 text-left hover:bg-cream/[0.06] transition-colors disabled:opacity-40 disabled:cursor-not-allowed group"
              >
                <div
                  className={cn(
                    "flex items-center justify-center w-7 h-7 rounded-md shrink-0 transition-colors",
                    palette.iconBg,
                    palette.iconBgHover,
                  )}
                >
                  {isExecuting ? (
                    <Loader2
                      className={cn("w-3.5 h-3.5 animate-spin", palette.iconFg)}
                    />
                  ) : (
                    <Icon className={cn("w-3.5 h-3.5", palette.iconFg)} />
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-cream/85">
                      {action.label}
                    </span>
                    {isPending && (
                      <span className="relative flex h-2 w-2">
                        <span
                          className={cn(
                            "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
                            palette.pingBg,
                          )}
                        />
                        <span
                          className={cn(
                            "relative inline-flex rounded-full h-2 w-2",
                            palette.pingFg,
                          )}
                        />
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-cream/45 leading-tight">
                    {isPending
                      ? tChat("actionsDropdown.agentRequesting", { action: action.label.toLowerCase() })
                      : action.description}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
