// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Globe,
  Copy,
  Check,
  Loader2,
  ArrowUpDown,
  Clock,
  Wifi,
  WifiOff,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { isAndroidApp } from "@/lib/utils";

interface TunnelStatus {
  running: boolean;
  connected: boolean;
  subdomain: string | null;
  url: string | null;
  stats: {
    requests: number;
    bytesUp: number;
    bytesDown: number;
    uptime: number;
  } | null;
  error: string | null;
}

interface TunnelConfig {
  hasToken: boolean;
  subdomain: string | null;
  autoExpose: boolean;
}

async function androidInvoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // TODO: wire proot commands through the Android bridge once available
  return (window as any).androidShield.invokeAsync(`plugin:proot|${cmd}`, args) as Promise<T>;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}

function fmtDuration(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function TunnelCard() {
  const isAndroid = isAndroidApp();
  const [status, setStatus] = useState<TunnelStatus | null>(null);
  const [config, setConfig] = useState<TunnelConfig | null>(null);
  const [subdomainInput, setSubdomainInput] = useState("");
  const [toggling, setToggling] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoStartAttempted = useRef(false);

  const pollStatus = useCallback(async () => {
    try {
      const s = await androidInvoke<TunnelStatus>("proot_tunnel_status");
      setStatus(s);
      if (s.error === "needs_token" && !autoStartAttempted.current) {
        autoStartAttempted.current = true;
        try {
          await androidInvoke("proot_tunnel_start");
        } catch {}
        return;
      }
      if (s.error === "auth_expired") {
        setError("Session expired. Please reconnect your account.");
      } else if (s.error && s.error !== "status_stale" && s.error !== "needs_token") {
        setError(s.error);
      } else {
        setError(null);
      }
    } catch {}
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const c = await androidInvoke<TunnelConfig>("proot_tunnel_get_config");
      setConfig(c);
      if (c.subdomain) setSubdomainInput(c.subdomain);
    } catch {}
  }, []);

  useEffect(() => {
    if (!isAndroid) return;
    loadConfig();
    pollStatus();
    const interval = setInterval(pollStatus, 10_000);
    return () => clearInterval(interval);
  }, [isAndroid, pollStatus, loadConfig]);

  if (!isAndroid) return null;

  const handleToggle = async () => {
    if (toggling) return;
    setToggling(true);
    setError(null);
    try {
      if (status?.running) {
        await androidInvoke("proot_tunnel_stop");
      } else {
        const sub = subdomainInput.trim() || undefined;
        await androidInvoke("proot_tunnel_start", sub ? { subdomain: sub } : {});
      }
      await new Promise((r) => setTimeout(r, 1000));
      await pollStatus();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("no_auth_token")) {
        setError("Connect your ellul.ai account to enable public URLs.");
      } else if (msg.includes("engine_not_running")) {
        setError("Workspace not running. Start it first.");
      } else {
        setError(msg);
      }
    } finally {
      setToggling(false);
    }
  };

  const handleCopy = () => {
    if (!status?.url) return;
    navigator.clipboard.writeText(status.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSubdomainSave = async () => {
    const sub = subdomainInput.trim();
    try {
      await androidInvoke("proot_tunnel_set_subdomain", { subdomain: sub });
    } catch {}
  };

  const handleAutoExposeToggle = async (enabled: boolean) => {
    try {
      await androidInvoke("proot_tunnel_set_auto_expose", { enabled });
      await loadConfig();
    } catch {}
  };

  const needsAuth = config !== null && !config.hasToken;

  return (
    <Card className="border-cream/[0.06] bg-cream/[0.02]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-cream/60" />
            <CardTitle className="text-sm">Tunnel</CardTitle>
          </div>
          {status?.connected && (
            <Badge variant="outline" className="text-[10px] border-emerald-500/30 text-emerald-400 bg-emerald-500/10">
              <Wifi className="h-3 w-3 mr-1" />
              Connected
            </Badge>
          )}
          {status?.running && !status.connected && (
            <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-400 bg-amber-500/10">
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              Connecting
            </Badge>
          )}
          {!status?.running && (
            <Badge variant="outline" className="text-[10px] border-cream/10 text-cream/40">
              <WifiOff className="h-3 w-3 mr-1" />
              Off
            </Badge>
          )}
        </div>
        <CardDescription className="text-xs text-cream/45">
          Make your workspace accessible from any browser via a public URL.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {needsAuth && (
          <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
              <div>
                <p className="text-xs text-cream/75">
                  Connect your ellul.ai account to enable public URLs.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2 text-xs h-7"
                  onClick={() => {
                    window.location.href = "https://console.ellul.ai/connect?redirect=localhost:8443/settings";
                  }}
                >
                  Connect Account
                </Button>
              </div>
            </div>
          </div>
        )}

        {error && !needsAuth && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
            <p className="text-xs text-red-400">{error}</p>
          </div>
        )}

        {/* Toggle + URL */}
        <div className="flex items-center justify-between">
          <Label htmlFor="tunnel-toggle" className="text-xs text-cream/75">
            Public URL
          </Label>
          <div className="flex items-center gap-2">
            {toggling && <Loader2 className="h-3 w-3 animate-spin text-cream/40" />}
            <Switch
              id="tunnel-toggle"
              checked={status?.running ?? false}
              onCheckedChange={handleToggle}
              disabled={toggling || needsAuth}
            />
          </div>
        </div>

        {status?.connected && status.url && (
          <div className="rounded-lg border border-cream/[0.08] bg-cream/[0.03] p-3">
            <div className="flex items-center justify-between gap-2">
              <a
                href={status.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-mono text-sodium hover:underline truncate"
              >
                {status.url}
              </a>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-7 p-0 shrink-0"
                onClick={handleCopy}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5 text-cream/40" />
                )}
              </Button>
            </div>

            {status.stats && (
              <div className="flex items-center gap-4 mt-2 text-[10px] text-cream/40">
                <span className="flex items-center gap-1">
                  <ArrowUpDown className="h-3 w-3" />
                  {status.stats.requests} req
                </span>
                <span>
                  {fmtBytes(status.stats.bytesUp)} up / {fmtBytes(status.stats.bytesDown)} down
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {fmtDuration(status.stats.uptime)}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Subdomain input */}
        {!status?.running && !needsAuth && (
          <div className="space-y-1.5">
            <Label htmlFor="subdomain-input" className="text-xs text-cream/60">
              Subdomain
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="subdomain-input"
                placeholder="my-workspace"
                value={subdomainInput}
                onChange={(e) => setSubdomainInput(e.target.value.replace(/[^a-z0-9-]/g, ""))}
                onBlur={handleSubdomainSave}
                className="h-8 text-xs font-mono bg-cream/[0.03] border-cream/[0.08]"
              />
              <span className="text-xs text-cream/40 shrink-0">.ellul.app</span>
            </div>
          </div>
        )}

        {/* Auto-expose */}
        {!needsAuth && (
          <div className="flex items-center justify-between pt-1 border-t border-cream/[0.04]">
            <Label htmlFor="auto-expose" className="text-xs text-cream/60">
              Auto-connect on startup
            </Label>
            <Switch
              id="auto-expose"
              checked={config?.autoExpose ?? false}
              onCheckedChange={handleAutoExposeToggle}
              disabled={needsAuth}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
