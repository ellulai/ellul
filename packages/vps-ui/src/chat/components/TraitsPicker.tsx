// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";
import { useTranslations } from "use-intl";
import { cn } from "@shared/utils";
import {
  getModelCapabilities,
  MODELS_BY_PROVIDER,
  type ProviderKind,
} from "@ellul.ai/types/model-catalog";
import {
  type ThreadCliOptions,
  type CodexReasoningEffort,
  type ClaudeEffort,
} from "@ellul.ai/types/cli-options";

type Session = "claude" | "codex" | "cursor" | "opencode";

function buildEffortLabels(t: (key: string) => string): Record<string, string> {
  return {
    low: t("traitsLegacy.low"),
    medium: t("traitsLegacy.medium"),
    high: t("traitsLegacy.high"),
    xhigh: t("traitsLegacy.extraHigh"),
    max: t("traitsLegacy.max"),
    ultrathink: t("traitsLegacy.ultrathink"),
  };
}

function sessionToProvider(session: Session): ProviderKind {
  return session;
}

function readModel(session: Session, options: ThreadCliOptions | null): string | null {
  if (session === "claude") return options?.claude?.model ?? null;
  if (session === "codex") return options?.codex?.model ?? null;
  if (session === "opencode") return options?.opencode?.model ?? null;
  return null;
}

function readEffort(session: Session, options: ThreadCliOptions | null): string | null {
  if (session === "codex") return options?.codex?.reasoningEffort ?? null;
  if (session === "claude") return options?.claude?.effort ?? null;
  return null;
}

function readFastMode(session: Session, options: ThreadCliOptions | null): boolean {
  if (session === "codex") return !!options?.codex?.fastMode;
  if (session === "claude") return !!options?.claude?.fastMode;
  return false;
}

function readAlwaysThink(session: Session, options: ThreadCliOptions | null): boolean {
  return session === "claude" && !!options?.claude?.alwaysThink;
}

function readThinking(session: Session, options: ThreadCliOptions | null): boolean {
  return session === "claude" && !!options?.claude?.thinking;
}

function withThinking(options: ThreadCliOptions | null, thinking: boolean): ThreadCliOptions {
  const next: ThreadCliOptions = options ? { ...options } : {};
  next.claude = { ...(next.claude ?? {}), thinking };
  return next;
}

function withEffort(session: Session, options: ThreadCliOptions | null, effort: string): ThreadCliOptions {
  const next: ThreadCliOptions = options ? { ...options } : {};
  if (session === "codex") next.codex = { ...(next.codex ?? {}), reasoningEffort: effort as CodexReasoningEffort };
  else if (session === "claude") next.claude = { ...(next.claude ?? {}), effort: effort as ClaudeEffort };
  return next;
}

function withFastMode(session: Session, options: ThreadCliOptions | null, fastMode: boolean): ThreadCliOptions {
  const next: ThreadCliOptions = options ? { ...options } : {};
  if (session === "codex") next.codex = { ...(next.codex ?? {}), fastMode };
  else if (session === "claude") next.claude = { ...(next.claude ?? {}), fastMode };
  return next;
}

function withAlwaysThink(options: ThreadCliOptions | null, alwaysThink: boolean): ThreadCliOptions {
  const next: ThreadCliOptions = options ? { ...options } : {};
  next.claude = { ...(next.claude ?? {}), alwaysThink };
  return next;
}

function withVariant(options: ThreadCliOptions | null, variant: string | undefined): ThreadCliOptions {
  const next: ThreadCliOptions = options ? { ...options } : {};
  next.opencode = { ...(next.opencode ?? {}), variant: variant || undefined };
  return next;
}

export function TraitsPicker({
  session,
  options,
  disabled,
  onChange,
}: {
  session: Session;
  options: ThreadCliOptions | null;
  disabled?: boolean;
  onChange: (next: ThreadCliOptions) => void;
}) {
  const tChat = useTranslations("chat");
  const EFFORT_LABELS = buildEffortLabels(tChat);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ bottom: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) { setPos(null); return; }
    const el = buttonRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({ bottom: window.innerHeight - rect.top + 4, left: rect.left });
    const onDocClick = (e: MouseEvent) => {
      if (popoverRef.current?.contains(e.target as Node)) return;
      if (buttonRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const provider = sessionToProvider(session);
  const model = readModel(session, options);
  const caps = (model ? getModelCapabilities(provider, model) : null) ?? MODELS_BY_PROVIDER[provider]?.[0] ?? null;
  const effortOptions = caps?.supportedEfforts ?? [];
  const supportsFastMode = caps?.supportsFastMode ?? false;
  const currentEffort = readEffort(session, options);
  const fastMode = readFastMode(session, options);
  const alwaysThink = readAlwaysThink(session, options);

  const thinking = readThinking(session, options);
  const showEffort = effortOptions.length > 0;
  const showFast = supportsFastMode;
  const showAlwaysThink = session === "claude";
  const showThinking = session === "claude";
  const showVariant = false;
  if (!showEffort && !showFast && !showAlwaysThink && !showThinking && !showVariant) return null;

  const labelParts: string[] = [];
  if (showEffort) labelParts.push(EFFORT_LABELS[currentEffort ?? caps?.defaultEffort ?? "medium"] ?? EFFORT_LABELS.medium ?? tChat("traitsLegacy.medium"));
  if (fastMode) labelParts.push(tChat("traits.fastLabel"));
  if (thinking) labelParts.push(tChat("traitsLegacy.thinking"));
  if (alwaysThink) labelParts.push(tChat("traitsLegacy.alwaysThink"));
  const triggerLabel = labelParts.length > 0 ? labelParts.join(" · ") : tChat("traitsLegacy.default");

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
          open ? "bg-sodium/10 text-sodium" : "text-muted-foreground/70 hover:text-foreground/80 hover:bg-secondary/60",
        )}
        title={tChat("traitsLegacy.title")}
      >
        <span className="truncate max-w-[160px]">{triggerLabel}</span>
        <ChevronDown className="h-3 w-3 opacity-50" />
      </button>
      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          <div
            ref={popoverRef}
            className="fixed w-60 bg-card border border-border rounded-lg shadow-xl z-[70] py-2 px-2 max-h-[400px] overflow-y-auto animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2 duration-150"
            style={{ bottom: pos.bottom, left: pos.left }}
          >
            {showEffort && (
              <div>
                <p className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/50 px-1 pb-1">{tChat("traitsLegacy.reasoningEffort")}</p>
                <div className="flex flex-col gap-0.5">
                  {effortOptions.map((eff) => {
                    const active = (currentEffort ?? caps?.defaultEffort) === eff;
                    return (
                      <button
                        key={eff}
                        type="button"
                        onClick={() => onChange(withEffort(session, options, eff))}
                        className={cn(
                          "w-full text-left px-2 py-1.5 rounded text-xs transition-colors flex items-center justify-between",
                          active ? "bg-sodium/10 text-sodium" : "text-cream/75 hover:bg-secondary",
                        )}
                      >
                        <span>{EFFORT_LABELS[eff] ?? eff}{eff === caps?.defaultEffort && currentEffort == null ? tChat("traits.defaultSuffix") : ""}</span>
                        {active && <Check className="h-3 w-3" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {showFast && (
              <div className={cn(showEffort ? "mt-2 pt-2 border-t border-border/40" : "")}>
                <p className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/50 px-1 pb-1">{tChat("traitsLegacy.fastMode")}</p>
                <div className="flex flex-col gap-0.5">
                  {(["off", "on"] as const).map((v) => {
                    const active = fastMode === (v === "on");
                    return (
                      <button
                        key={v}
                        type="button"
                        onClick={() => onChange(withFastMode(session, options, v === "on"))}
                        className={cn(
                          "w-full text-left px-2 py-1.5 rounded text-xs transition-colors flex items-center justify-between",
                          active ? "bg-sodium/10 text-sodium" : "text-cream/75 hover:bg-secondary",
                        )}
                      >
                        <span>{v === "on" ? tChat("traitsLegacy.on") : tChat("traitsLegacy.off")}</span>
                        {active && <Check className="h-3 w-3" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {showThinking && (
              <div className={cn(showEffort || showFast ? "mt-2 pt-2 border-t border-border/40" : "")}>
                <p className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/50 px-1 pb-1">{tChat("traitsLegacy.thinking")}</p>
                <div className="flex flex-col gap-0.5">
                  {(["off", "on"] as const).map((v) => {
                    const active = thinking === (v === "on");
                    return (
                      <button
                        key={v}
                        type="button"
                        onClick={() => onChange(withThinking(options, v === "on"))}
                        className={cn(
                          "w-full text-left px-2 py-1.5 rounded text-xs transition-colors flex items-center justify-between",
                          active ? "bg-sodium/10 text-sodium" : "text-cream/75 hover:bg-secondary",
                        )}
                      >
                        <span>{v === "on" ? tChat("traitsLegacy.on") : tChat("traitsLegacy.off")}</span>
                        {active && <Check className="h-3 w-3" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {showAlwaysThink && (
              <div className={cn(showEffort || showFast || showThinking ? "mt-2 pt-2 border-t border-border/40" : "")}>
                <p className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/50 px-1 pb-1">{tChat("traitsLegacy.alwaysThink")}</p>
                <div className="flex flex-col gap-0.5">
                  {(["off", "on"] as const).map((v) => {
                    const active = alwaysThink === (v === "on");
                    return (
                      <button
                        key={v}
                        type="button"
                        onClick={() => onChange(withAlwaysThink(options, v === "on"))}
                        className={cn(
                          "w-full text-left px-2 py-1.5 rounded text-xs transition-colors flex items-center justify-between",
                          active ? "bg-sodium/10 text-sodium" : "text-cream/75 hover:bg-secondary",
                        )}
                      >
                        <span>{v === "on" ? tChat("traitsLegacy.on") : tChat("traitsLegacy.off")}</span>
                        {active && <Check className="h-3 w-3" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {showVariant && (
              <div className={cn(showEffort || showFast || showAlwaysThink ? "mt-2 pt-2 border-t border-border/40" : "")}>
                <p className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/50 px-1 pb-1">{tChat("traitsLegacy.variant")}</p>
                <input
                  type="text"
                  value={options?.opencode?.variant ?? ""}
                  placeholder={tChat("traitsLegacy.variantPlaceholder")}
                  onChange={(e) => onChange(withVariant(options, e.target.value || undefined))}
                  className="w-full bg-background/40 border border-border/40 rounded px-2 py-1 text-xs text-foreground/80 focus:outline-none focus:border-ring/45"
                />
              </div>
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
