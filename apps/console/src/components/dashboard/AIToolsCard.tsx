// SPDX-License-Identifier: MIT
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { GstackLogo, ZeroClawLogo } from "@/components/ui/ai-logos";
import { useState, useRef, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { useVpsBridge } from "@/lib/vps-bridge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ProviderStatus {
  connected: boolean;
}

interface FeaturesResponse {
  gbrain: { enabled: boolean; available: boolean; ramMb: number; provider: string };
  gstack: { enabled: boolean; available: boolean };
  zeroclaw: { provider: string };
  providers: Record<string, ProviderStatus>;
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  openrouter: "OpenRouter",
  xai: "xAI",
};

interface AIToolsCardProps {
  serverDomain: string;
}

function ProviderDropdown({
  value,
  providers,
  onChange,
  disabled,
  autoLabel,
  noKeysLabel,
}: {
  value: string;
  providers: Record<string, ProviderStatus>;
  onChange: (provider: string) => void;
  disabled?: boolean;
  autoLabel: string;
  noKeysLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const label = value === "auto" ? autoLabel : (PROVIDER_LABELS[value] ?? value);
  const connectedProviders = Object.entries(providers).filter(([, s]) => s.connected);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className="flex items-center gap-1 px-2 py-1 rounded-md border border-cream/[0.08] bg-cream/[0.03] text-[11px] text-cream/75 hover:border-cream/[0.15] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <span>{label}</span>
        <ChevronDown className={`h-2.5 w-2.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 min-w-[140px] bg-card border border-border rounded-lg shadow-xl z-50 py-1 animate-in fade-in-0 zoom-in-95 duration-150">
          <button
            type="button"
            onClick={() => { onChange("auto"); setOpen(false); }}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-secondary transition-colors ${
              value === "auto" ? "text-cream" : "text-cream/60"
            }`}
          >
            {value === "auto" && <span className="w-1.5 h-1.5 rounded-full bg-sodium shrink-0" />}
            <span className={value === "auto" ? "" : "ml-[14px]"}>{autoLabel}</span>
          </button>
          {connectedProviders.map(([id]) => (
            <button
              key={id}
              type="button"
              onClick={() => { onChange(id); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-secondary transition-colors ${
                value === id ? "text-cream" : "text-cream/60"
              }`}
            >
              {value === id && <span className="w-1.5 h-1.5 rounded-full bg-sodium shrink-0" />}
              <span className={value === id ? "" : "ml-[14px]"}>{PROVIDER_LABELS[id] ?? id}</span>
            </button>
          ))}
          {connectedProviders.length === 0 && (
            <div className="px-3 py-1.5 text-[10px] text-cream/30">{noKeysLabel}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function AIToolsCard({ serverDomain }: AIToolsCardProps) {
  const t = useTranslations("console.aiTools");
  const queryClient = useQueryClient();
  const { send: vpsSend } = useVpsBridge();

  const { data, isLoading } = useQuery<FeaturesResponse>({
    queryKey: ["vps-features", serverDomain],
    queryFn: () => vpsSend<FeaturesResponse>("features_get"),
    refetchInterval: 30_000,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ feature, enabled }: { feature: string; enabled: boolean }) =>
      vpsSend("features_toggle", { feature, enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vps-features", serverDomain] });
    },
  });

  const providerMutation = useMutation({
    mutationFn: ({ tool, provider }: { tool: string; provider: string }) =>
      vpsSend("tool_provider_set", { tool, provider }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["vps-features", serverDomain] });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner size="sm" />
      </div>
    );
  }

  if (!data) return null;

  const providers = data.providers ?? {};
  const connectedCount = Object.values(providers).filter((p) => p.connected).length;
  const isToggling = toggleMutation.isPending;

  return (
    <div className="space-y-4">
      {/* Connected Providers */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-cream/40 uppercase tracking-wider">{t("providers")}</span>
        {Object.entries(providers).map(([id, status]) => (
          <div
            key={id}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] ${
              status.connected
                ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-400"
                : "border-cream/[0.06] text-cream/25"
            }`}
          >
            <div className={`h-1.5 w-1.5 rounded-full ${
              status.connected ? "bg-emerald-400" : "bg-cream/15"
            }`} />
            {PROVIDER_LABELS[id] ?? id}
          </div>
        ))}
        {connectedCount === 0 && (
          <span className="text-[10px] text-cream/25">{t("addKeysHint")}</span>
        )}
      </div>

      {/* gbrain */}
      <div className={`rounded-lg border p-4 transition-colors ${
        data.gbrain.enabled
          ? "border-violet-500/30 bg-violet-500/5"
          : "border-cream/[0.08]"
      }`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="mt-0.5 shrink-0">
              <GstackLogo className="h-7 w-7 rounded-md" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-cream">gbrain</span>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                  {t("gbrainRam")}
                </Badge>
              </div>
              <p className="text-xs text-cream/50 mt-0.5">
                {t("gbrainDescription")}
              </p>
              <p className="text-[10px] text-cream/30 mt-0.5">
                {t("byAuthor", { author: "Garry Tan" })}
              </p>
            </div>
          </div>
          <div className="shrink-0">
            {data.gbrain.available ? (
              <Switch
                checked={data.gbrain.enabled}
                disabled={isToggling}
                onCheckedChange={(checked) =>
                  toggleMutation.mutate({ feature: "gbrain", enabled: checked })
                }
              />
            ) : (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div>
                      <Switch checked={false} disabled />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    <p className="text-xs">{t("requiresRam")}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
        {data.gbrain.enabled && (
          <div className="mt-3 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[10px] text-violet-400/70">
              <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              {t("runningOnPort", { port: 7704 })}
            </div>
            <ProviderDropdown
              value={data.gbrain.provider}
              providers={providers}
              onChange={(provider) => providerMutation.mutate({ tool: "gbrain", provider })}
              disabled={providerMutation.isPending}
              autoLabel={t("auto")}
              noKeysLabel={t("noKeys")}
            />
          </div>
        )}
      </div>

      {/* gstack */}
      <div className={`rounded-lg border p-4 transition-colors ${
        data.gstack.enabled
          ? "border-amber-500/30 bg-amber-500/5"
          : "border-cream/[0.08]"
      }`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="mt-0.5 shrink-0">
              <GstackLogo className="h-7 w-7 rounded-md" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium text-cream">gstack</span>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                  {t("gstackDisk")}
                </Badge>
              </div>
              <p className="text-xs text-cream/50 mt-0.5">
                {t("gstackDescription")}
              </p>
              <p className="text-[10px] text-cream/30 mt-0.5">
                {t("byAuthor", { author: "Garry Tan" })}
              </p>
            </div>
          </div>
          <div className="shrink-0">
            {data.gstack.available ? (
              <Switch
                checked={data.gstack.enabled}
                disabled={isToggling}
                onCheckedChange={(checked) =>
                  toggleMutation.mutate({ feature: "gstack", enabled: checked })
                }
              />
            ) : (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div>
                      <Switch checked={false} disabled />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="left">
                    <p className="text-xs">{t("notAvailable")}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
        {data.gstack.enabled && (
          <div className="mt-3 flex items-center gap-1.5 text-[10px] text-amber-400/70">
            <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            {t("skillsActive")}
          </div>
        )}
      </div>

      {/* ZeroClaw */}
      <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="mt-0.5 p-1.5 rounded-md bg-cyan-500/10">
              <ZeroClawLogo className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <span className="text-sm font-medium text-cream">ZeroClaw</span>
              <p className="text-xs text-cream/50 mt-0.5">
                AI agent framework for all workspaces
              </p>
            </div>
          </div>
          <ProviderDropdown
            value={data.zeroclaw.provider}
            providers={providers}
            onChange={(provider) => providerMutation.mutate({ tool: "zeroclaw", provider })}
            disabled={providerMutation.isPending}
            autoLabel={t("auto")}
            noKeysLabel={t("noKeys")}
          />
        </div>
      </div>

      {/* Error display */}
      {(toggleMutation.isError || providerMutation.isError) && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
          <AlertTriangle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
          <p className="text-xs text-red-300">
            {(toggleMutation.error as Error)?.message ||
             (providerMutation.error as Error)?.message ||
             t("operationFailed")}
          </p>
        </div>
      )}
    </div>
  );
}
