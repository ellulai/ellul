// SPDX-License-Identifier: MIT
"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { ChevronDown, Plus, Shield, Monitor, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ServerSummary } from "@/contexts/DashboardContext";

interface ServerSwitcherProps {
  servers: ServerSummary[];
  activeServerId: string | null;
  onSelectServer: (id: string) => void;
  onCreateServer?: () => void;
}

const PRODUCT_ICONS: Record<string, typeof Shield> = {
  shield_proxy: Shield,
  cloud_platform: Monitor,
};

const STATUS_DOT: Record<string, string> = {
  running: "bg-sodium",
  creating: "bg-sodium animate-pulse",
  provisioning: "bg-sodium animate-pulse",
  waking: "bg-sodium animate-pulse",
  awaiting_unlock: "bg-sodium animate-pulse",
  upgrading: "bg-sodium animate-pulse",
  downgrading: "bg-sodium animate-pulse",
  hibernated: "bg-ink-1",
  hibernating: "bg-blue-500 animate-pulse",
  pool_ready: "bg-ink-1",
  pool_assigned: "bg-sodium animate-pulse",
  error: "bg-terra",
  frozen: "bg-terra",
  pending_deletion: "bg-terra",
  none: "bg-ink-1",
};

function getStatusDot(status: string) {
  return STATUS_DOT[status] ?? "bg-ink-1";
}

function getProductKey(server: ServerSummary): string {
  return server.server?.product ?? "cloud_platform";
}

function getProductIcon(productKey: string) {
  return PRODUCT_ICONS[productKey] ?? PRODUCT_ICONS.cloud_platform ?? Monitor;
}

export function ServerSwitcher({
  servers,
  activeServerId,
  onSelectServer,
  onCreateServer,
}: ServerSwitcherProps) {
  const t = useTranslations("console.serverSwitcher");
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);

  const productLabel = (productKey: string): string => {
    if (productKey === "shield_proxy") return t("products.shieldGateway");
    return t("products.cloudPlatform");
  };

  const getServerLabel = (server: ServerSummary): string => {
    const name = (server.server as Record<string, unknown>)?.name as string | undefined;
    return name || productLabel(getProductKey(server)) || t("fallbackName");
  };

  const activeServer = servers.find((s) => s.server?.id === activeServerId);
  const activeProductKey = activeServer ? getProductKey(activeServer) : "cloud_platform";
  const ActiveIcon = getProductIcon(activeProductKey);

  // Filter out pool/migration infrastructure servers and group by product
  const visibleServers = servers.filter((s) => s.state !== "pool_ready" && s.state !== "pool_assigned");
  const grouped = visibleServers.reduce<Record<string, ServerSummary[]>>((acc, s) => {
    const key = s.server?.product ?? "cloud_platform";
    if (!acc[key]) acc[key] = [];
    acc[key].push(s);
    return acc;
  }, {});

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const handleToggle = () => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom + 4, left: rect.left });
    }
    setOpen((prev) => !prev);
  };

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        onClick={handleToggle}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-secondary hover:bg-secondary/80 border border-border transition-colors"
      >
        <ActiveIcon className="h-4 w-4 text-sodium" />
        <span className="text-xs text-cream/85 font-medium max-w-[100px] truncate">
          {activeServer ? getServerLabel(activeServer) : t("selectServer")}
        </span>
        <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", getStatusDot(activeServer?.state ?? "none"))} />
        <ChevronDown className={cn("h-3 w-3 text-cream/60 transition-transform", open && "rotate-180")} />
      </button>

      {open && dropdownPos && createPortal(
        <>
          <div className="fixed inset-0 z-[60]" onClick={(e) => { e.stopPropagation(); setOpen(false); }} />
          <div
            className="fixed w-56 bg-card border border-border rounded-lg shadow-xl z-[70] py-1 animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150"
            style={{ top: dropdownPos.top, left: dropdownPos.left }}
          >
            {Object.entries(grouped).map(([product, productServers]) => {
              const Icon = getProductIcon(product);
              return (
                <div key={product}>
                  <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-cream/45">
                    {productLabel(product)}
                  </div>
                  {productServers.map((s) => {
                    const isActive = s.server?.id === activeServerId;
                    return (
                      <button
                        key={s.server?.id}
                        onClick={() => {
                          if (s.server?.id) {
                            onSelectServer(s.server.id);
                            setOpen(false);
                          }
                        }}
                        className={cn(
                          "w-full flex items-center gap-2 px-3 py-2 text-left transition-colors",
                          isActive ? "bg-sodium/10" : "hover:bg-secondary",
                        )}
                      >
                        {isActive && (
                          <span className="w-1.5 h-1.5 rounded-full bg-sodium shrink-0" />
                        )}
                        <Icon className={cn("h-3.5 w-3.5", isActive ? "text-sodium" : "text-cream/60")} />
                        <span className={cn("text-sm flex-1 truncate", isActive ? "text-cream" : "text-cream/75")}>
                          {getServerLabel(s)}
                        </span>
                        <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", getStatusDot(s.state))} />
                      </button>
                    );
                  })}
                </div>
              );
            })}

            {onCreateServer && (
              <>
                <div className="border-t border-border my-1" />
                <button
                  onClick={() => {
                    onCreateServer();
                    setOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-secondary transition-colors"
                >
                  <Plus className="h-3.5 w-3.5 text-sodium" />
                  <span className="text-sm text-cream/75">{t("newServer")}</span>
                </button>
              </>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
