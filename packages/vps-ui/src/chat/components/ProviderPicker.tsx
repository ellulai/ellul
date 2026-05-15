// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Cpu } from "lucide-react";
import { useTranslations } from "use-intl";
import { cn } from "@shared/utils";
import {
  MODELS_BY_PROVIDER,
  type ModelCapabilities,
  type ProviderKind,
} from "@ellul.ai/types/model-catalog";
import { type ThreadCliOptions } from "@ellul.ai/types";

type Session = "claude" | "codex" | "cursor" | "opencode" | "grokAgent";

const BADGE_LABELS: Record<string, string> = {
  new: "NEW",
  recommended: "REC",
  preview: "BETA",
  deprecated: "DEPR",
};

function badgeClass(badge: string): string {
  if (badge === "deprecated") return "bg-terra/20 text-terra";
  if (badge === "preview") return "bg-amber-500/20 text-amber-400";
  if (badge === "new") return "bg-sodium/20 text-sodium";
  if (badge === "recommended") return "bg-foreground/10 text-foreground/80";
  return "bg-muted-foreground/20 text-muted-foreground";
}

function sessionToProvider(session: Session): ProviderKind {
  return session;
}

function readSelectedModel(session: Session, options: ThreadCliOptions | null): string | null {
  if (session === "claude") return options?.claude?.model ?? null;
  if (session === "codex") return options?.codex?.model ?? null;
  if (session === "cursor") return options?.cursor?.model ?? null;
  if (session === "opencode") return options?.opencode?.model ?? null;
  return null;
}

function withModel(session: Session, options: ThreadCliOptions | null, model: string): ThreadCliOptions {
  const next: ThreadCliOptions = options ? { ...options } : {};
  if (session === "claude") next.claude = { ...(next.claude ?? {}), model };
  else if (session === "codex") next.codex = { ...(next.codex ?? {}), model };
  else if (session === "cursor") next.cursor = { ...(next.cursor ?? {}), model };
  else if (session === "opencode") next.opencode = { ...(next.opencode ?? {}), model };
  return next;
}

export function ProviderPicker({
  session,
  options,
  disabled,
  runtimeOpenCodeModels,
  recentModelIds,
  onChange,
}: {
  session: Session;
  options: ThreadCliOptions | null;
  disabled?: boolean;
  runtimeOpenCodeModels?: ReadonlyArray<{ id: string; openCodeId: string }>;
  recentModelIds?: ReadonlyArray<string>;
  onChange: (next: ThreadCliOptions) => void;
}) {
  const tChat = useTranslations("chat");
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ bottom: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) { setPopoverPos(null); return; }
    const el = buttonRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPopoverPos({ bottom: window.innerHeight - rect.top + 4, left: rect.left });
    const onDocClick = (e: MouseEvent) => {
      if (popoverRef.current?.contains(e.target as Node)) return;
      if (buttonRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const provider = sessionToProvider(session);
  const selectedModel = readSelectedModel(session, options);

  const models: readonly ModelCapabilities[] = useMemo(() => {
    if (session === "opencode") {
      return (runtimeOpenCodeModels ?? []).map((m) => ({
        id: m.openCodeId,
        name: m.id,
        supportedEfforts: [],
      }));
    }
    return MODELS_BY_PROVIDER[provider] ?? [];
  }, [session, provider, runtimeOpenCodeModels]);

  const activeModel = selectedModel ? models.find((m) => m.id === selectedModel) : null;
  const fallbackModel = activeModel ?? models[0] ?? null;
  const triggerLabel = fallbackModel?.name ?? (session === "opencode" ? tChat("providerPicker.discovering") : tChat("providerPicker.model").toLowerCase());

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "shrink-0 h-8 px-2 sm:px-3 rounded-lg text-xs font-medium transition-colors whitespace-nowrap",
          "disabled:opacity-30 flex items-center gap-1.5",
          open
            ? "bg-sodium/10 text-sodium"
            : "text-muted-foreground/70 hover:text-foreground/80 hover:bg-secondary/60",
        )}
        title={tChat("providerPicker.modelTitle")}
      >
        <Cpu className="h-3 w-3" />
        <span className="truncate max-w-[160px]">{triggerLabel}</span>
        <ChevronDown className="h-3 w-3 opacity-50" />
      </button>
      {open && popoverPos && createPortal(
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          <div
            ref={popoverRef}
            className="fixed w-64 bg-card border border-border rounded-lg shadow-xl z-[70] py-2 px-2 max-h-[420px] overflow-y-auto animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 duration-150"
            style={{ bottom: popoverPos.bottom, left: popoverPos.left }}
          >
            {models.length > 0 ? (
              <>
                {recentModelIds && recentModelIds.length > 0 && (() => {
                  const recentSet = new Set(recentModelIds);
                  const recentModels = recentModelIds
                    .map((id) => models.find((m) => m.id === id))
                    .filter((m): m is ModelCapabilities => !!m);
                  if (recentModels.length === 0) return null;
                  return (
                    <>
                      <p className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/50 px-1 pb-1">{tChat("providerPicker.recent")}</p>
                      <div className="flex flex-col gap-0.5 mb-2">
                        {recentModels.map((m) => {
                          const effectiveModel = selectedModel ?? fallbackModel?.id;
                          const isSelected = effectiveModel === m.id;
                          return (
                            <button
                              key={`recent-${m.id}`}
                              type="button"
                              onClick={() => {
                                onChange(withModel(session, options, m.id));
                                setOpen(false);
                              }}
                              className={cn(
                                "w-full text-left px-2 py-1.5 rounded text-xs transition-colors flex items-start gap-2",
                                isSelected ? "bg-sodium/10 text-sodium" : "text-cream/75 hover:bg-secondary",
                              )}
                            >
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="truncate">{m.name}</span>
                                </div>
                              </div>
                              {isSelected && <Check className="h-3 w-3 mt-0.5 shrink-0" />}
                            </button>
                          );
                        })}
                      </div>
                      <p className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/50 px-1 pb-1">{tChat("providerPicker.all")}</p>
                    </>
                  );
                })()}
                {(!recentModelIds || recentModelIds.length === 0) && (
                  <p className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/50 px-1 pb-1">{tChat("providerPicker.model")}</p>
                )}
                <div className="flex flex-col gap-0.5">
                  {models.map((m) => {
                    const effectiveModel = selectedModel ?? fallbackModel?.id;
                    const isSelected = effectiveModel === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => {
                          onChange(withModel(session, options, m.id));
                          setOpen(false);
                        }}
                        className={cn(
                          "w-full text-left px-2 py-1.5 rounded text-xs transition-colors flex items-start gap-2",
                          isSelected ? "bg-sodium/10 text-sodium" : "text-cream/75 hover:bg-secondary",
                        )}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate">{m.name}</span>
                            {m.badge && (
                              <span className={cn("text-[8px] uppercase px-1 py-0.5 rounded font-mono", badgeClass(m.badge))}>
                                {BADGE_LABELS[m.badge] ?? m.badge}
                              </span>
                            )}
                          </div>
                          {m.description && (
                            <p className="text-[10px] text-muted-foreground/60 mt-0.5">{m.description}</p>
                          )}
                        </div>
                        {isSelected && <Check className="h-3 w-3 mt-0.5 shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <p className="text-[10px] text-muted-foreground/60 px-2 py-2">
                {session === "opencode" ? tChat("providerPicker.discoveringModels") : tChat("providerPicker.noModelsConfigured")}
              </p>
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
