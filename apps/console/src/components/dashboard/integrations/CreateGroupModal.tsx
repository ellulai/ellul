// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { createPortal } from "react-dom";
import {
  X,
  Terminal,
  Database,
  Rocket,
  GitBranch,
  KeyRound,
  Shield,
  Bot,
  Layers,
  Network,
  Activity,
  Loader2,
  Star,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useVisualViewport } from "@/hooks/useVisualViewport";

// ─── Types ──────────────────────────────────────────────────────────────────

interface CreateGroupModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: { name: string; iconKey: string; routeRole?: string }) => void;
  existingRoles: string[];
  isCreating: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ICON_OPTIONS = [
  { key: "terminal", label: "Terminal", Icon: Terminal },
  { key: "database", label: "Database", Icon: Database },
  { key: "rocket", label: "Rocket", Icon: Rocket },
  { key: "git-branch", label: "Git Branch", Icon: GitBranch },
  { key: "key", label: "Key", Icon: KeyRound },
  { key: "shield", label: "Shield", Icon: Shield },
  { key: "bot", label: "Bot", Icon: Bot },
  { key: "layers", label: "Layers", Icon: Layers },
  { key: "network", label: "Network", Icon: Network },
  { key: "activity", label: "Activity", Icon: Activity },
] as const;

import { isRouteRoleVisible } from "@/lib/feature-flags";

const ALL_ROUTE_ROLE_OPTIONS = [
  { value: "", label: "None - general tools for agent", badge: null, defaultIcon: "terminal", defaultName: "" },
  { value: "db-default", label: "Database default", badge: "db-default", defaultIcon: "database", defaultName: "Database" },
  { value: "deploy-default", label: "Deploy default", badge: "deploy-default", defaultIcon: "rocket", defaultName: "Deploy" },
  { value: "cloudflare-default", label: "Cloudflare default", badge: "cloudflare-default", defaultIcon: "cloud", defaultName: "Cloudflare" },
  { value: "payments-default", label: "Payments default", badge: "payments-default", defaultIcon: "credit-card", defaultName: "Payments" },
  { value: "git-default", label: "Git default", badge: "git-default", defaultIcon: "git-branch", defaultName: "Source Control" },
] as const;

const ROUTE_ROLE_OPTIONS = ALL_ROUTE_ROLE_OPTIONS.filter(
  (opt) => isRouteRoleVisible(opt.value),
);

// ─── Component ──────────────────────────────────────────────────────────────

export function CreateGroupModal({
  open,
  onClose,
  onSubmit,
  existingRoles,
  isCreating,
}: CreateGroupModalProps) {
  const t = useTranslations("console.integrations.createGroup");
  const vh = useVisualViewport();
  const [name, setName] = useState("");
  const [iconKey, setIconKey] = useState("terminal");
  const [routeRole, setRouteRole] = useState("");
  const [showIconPicker, setShowIconPicker] = useState(false);

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setName("");
      setIconKey("terminal");
      setRouteRole("");
      setShowIconPicker(false);
    }
  }, [open]);

  const handleSubmit = useCallback(() => {
    if (!name.trim()) return;
    onSubmit({
      name: name.trim(),
      iconKey,
      routeRole: routeRole || undefined,
    });
  }, [name, iconKey, routeRole, onSubmit]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && name.trim() && !isCreating) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [name, isCreating, handleSubmit],
  );

  if (!open) return null;

  const selectedIcon = ICON_OPTIONS.find((opt) => opt.key === iconKey);
  const SelectedIconComponent = selectedIcon?.Icon ?? Terminal;

  return createPortal(
    <div
      className="fixed inset-x-0 top-0 z-[120] flex items-end sm:items-center justify-center"
      style={{ height: vh }}
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in-0 duration-200" />

      {/* Modal */}
      <div
        className="relative w-full sm:max-w-md max-h-[90%] flex flex-col bg-card border border-border rounded-t-xl sm:rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-4 sm:zoom-in-95 sm:slide-in-from-bottom-0 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-semibold text-cream">{t("title")}</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-cream/[0.06] text-cream/60 hover:text-cream transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Name */}
          <div>
            <label className="text-[10px] text-cream/45 uppercase tracking-wider mb-1.5 block">
              {t("name")}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t("namePlaceholder")}
              className="w-full px-3 py-2 rounded-lg border border-cream/[0.08] bg-cream/[0.03] text-sm text-cream placeholder:text-cream/45 focus:border-sodium/50 focus:outline-none transition-colors"
              autoFocus
            />
          </div>

          {/* Icon Picker */}
          <div>
            <label className="text-[10px] text-cream/45 uppercase tracking-wider mb-1.5 block">
              {t("icon")}
            </label>
            <button
              onClick={() => setShowIconPicker(!showIconPicker)}
              className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-cream/[0.08] bg-cream/[0.03] text-sm text-cream hover:border-cream/[0.15] transition-colors w-full"
            >
              <SelectedIconComponent className="h-4 w-4 text-cream/75" />
              <span className="text-cream/75">{selectedIcon?.label ?? iconKey}</span>
            </button>
            {showIconPicker && (
              <div className="mt-2 grid grid-cols-5 gap-1.5 p-2 rounded-lg border border-cream/[0.08] bg-cream/[0.03]">
                {ICON_OPTIONS.map((opt) => {
                  const OptIcon = opt.Icon;
                  const isSelected = iconKey === opt.key;
                  return (
                    <button
                      key={opt.key}
                      onClick={() => {
                        setIconKey(opt.key);
                        setShowIconPicker(false);
                      }}
                      className={cn(
                        "flex flex-col items-center gap-1 p-2 rounded-lg transition-all",
                        isSelected
                          ? "bg-sodium/10 border border-sodium/30 text-sodium"
                          : "hover:bg-cream/[0.04] text-cream/60 hover:text-cream/85 border border-transparent",
                      )}
                      title={opt.label}
                    >
                      <OptIcon className="h-4 w-4" />
                      <span className="text-[9px] truncate w-full text-center">
                        {opt.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Route Role */}
          <div>
            <label className="text-[10px] text-cream/45 uppercase tracking-wider mb-1.5 block">
              {t("systemRouteRole")}{" "}
              <span className="text-cream/35 normal-case tracking-normal">
                {t("optional")}
              </span>
            </label>
            <div className="space-y-1.5">
              {ROUTE_ROLE_OPTIONS.map((opt) => {
                const isDisabled =
                  opt.value !== "" && existingRoles.includes(opt.value) && routeRole !== opt.value;
                const isSelected = routeRole === opt.value;
                return (
                  <label
                    key={opt.value}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2 rounded-lg border transition-all cursor-pointer",
                      isDisabled && "opacity-40 cursor-not-allowed",
                      isSelected
                        ? "border-sodium/30 bg-sodium/[0.05]"
                        : "border-cream/[0.06] bg-cream/[0.02] hover:bg-cream/[0.04]",
                    )}
                  >
                    <input
                      type="radio"
                      name="routeRole"
                      value={opt.value}
                      checked={isSelected}
                      onChange={() => {
                        setRouteRole(opt.value);
                        // Auto-switch icon and name to match the role
                        if (opt.defaultIcon) setIconKey(opt.defaultIcon);
                        if (opt.defaultName && (!name || ROUTE_ROLE_OPTIONS.some(r => r.defaultName === name))) {
                          setName(opt.defaultName);
                        }
                      }}
                      disabled={isDisabled}
                      className="sr-only"
                    />
                    <div
                      className={cn(
                        "w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0",
                        isSelected
                          ? "border-sodium bg-sodium/20"
                          : "border-cream/[0.15]",
                      )}
                    >
                      {isSelected && (
                        <div className="w-1.5 h-1.5 rounded-full bg-sodium" />
                      )}
                    </div>
                    <span className={cn(
                      "text-sm flex-1",
                      isSelected ? "text-cream" : "text-cream/75",
                    )}>
                      {opt.label}
                    </span>
                    {opt.badge && (
                      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium bg-cream/[0.04] text-cream/45 border border-cream/[0.06]">
                        <Star className="h-2.5 w-2.5" />
                        {opt.badge}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-4 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-cream/60 hover:text-cream transition-colors"
          >
            {t("cancel")}
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || isCreating}
            className={cn(
              "flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-all",
              !name.trim() || isCreating
                ? "bg-cream/[0.05] text-cream/45 cursor-not-allowed"
                : "bg-sodium text-ink shadow-sm shadow-sodium/10",
            )}
          >
            {isCreating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            {t("create")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
