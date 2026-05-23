// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  Terminal,
  Rocket,
  Activity,
  Cpu,
  HardDrive,
  MemoryStick,
  Circle,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Wifi,
  WifiOff,
  Bot,
  RefreshCcw,
  Shield,
  Zap,
  KeyRound,
  Check,
  X,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useRealtime, useRealtimeSubscribe, type RealtimeMessage } from "@/providers/realtime-provider";
import { useVpsBridge } from "@/lib/vps-bridge";
import { getVpsApiUrl } from "@/lib/domains";

// ── Types ──

interface PreviewHealth {
  app: string;
  active: boolean;
  phase?: "idle" | "installing" | "starting" | "ready" | "error" | "crashed";
  error?: string | null;
  logTail?: string | null;
  port?: number;
  healAttempts?: number;
  healStatus?: "healing" | "exhausted" | null;
}

interface DeployedAppInfo {
  name: string;
  directory?: string;
  domain?: string;
  [key: string]: unknown;
}

// ── Development Tab ──

export function ObservabilityDevelopment({ serverDomain }: { serverDomain: string }) {
  const t = useTranslations("console.observability");
  const [previews, setPreviews] = useState<PreviewHealth[]>([]);
  const [expandedApp, setExpandedApp] = useState<string | null>(null);

  // Subscribe to preview_all_status realtime messages
  useRealtimeSubscribe(
    useCallback((msg: RealtimeMessage) => {
      if (msg.type === "preview_all_status" && msg.data) {
        const statuses = msg.data as unknown as Record<string, PreviewHealth>;
        setPreviews(Object.values(statuses));
      }
    }, []),
  );

  const activeApps = previews.filter((p) => p.active);
  const idleApps = previews.filter((p) => !p.active);

  return (
    <div className="p-4 space-y-4">
      {/* Active dev servers */}
      {activeApps.length > 0 ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Circle className="h-2 w-2 fill-sodium text-sodium" />
            <span className="text-xs font-medium text-cream">{t("activeDevServers")}</span>
            <Badge variant="outline" className="text-[10px] border-sodium/30 text-sodium">
              {activeApps.length}
            </Badge>
          </div>
          {activeApps.map((preview) => (
            <PreviewCard
              key={preview.app}
              preview={preview}
              expanded={expandedApp === preview.app}
              onToggle={() => setExpandedApp((prev) => (prev === preview.app ? null : preview.app))}
            />
          ))}
        </div>
      ) : (
        <div className="text-center py-8 border border-dashed border-border rounded-lg">
          <Terminal className="h-8 w-8 mx-auto mb-2 text-cream/45" />
          <p className="text-sm text-cream/60">{t("noActiveDevServers")}</p>
          <p className="text-xs text-cream/45 mt-1">{t("noActiveDevServersHint")}</p>
        </div>
      )}

      {/* Idle apps */}
      {idleApps.length > 0 && (
        <div className="space-y-2">
          <span className="text-[10px] text-cream/45 uppercase tracking-wider font-medium">{t("idle")}</span>
          <div className="space-y-1">
            {idleApps.map((preview) => (
              <div key={preview.app} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-cream/[0.04] bg-cream/[0.01]">
                <Circle className="h-2 w-2 text-cream/35" />
                <span className="text-xs text-cream/45 font-mono">{preview.app}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewCard({ preview, expanded, onToggle }: {
  preview: PreviewHealth;
  expanded: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations("console.observability");
  const phaseColor: Record<string, string> = {
    ready: "text-sodium",
    installing: "text-sodium",
    starting: "text-blue-400",
    error: "text-terra",
    crashed: "text-terra",
    idle: "text-cream/45",
  };

  const phaseIcon: Record<string, typeof CheckCircle2> = {
    ready: CheckCircle2,
    error: AlertCircle,
    crashed: AlertCircle,
    idle: Circle,
  };

  const phase = preview.phase ?? "idle";
  const color = phaseColor[phase] ?? "text-cream/45";
  const isSpinning = phase === "installing" || phase === "starting";
  const PhaseIcon = phaseIcon[phase] ?? Circle;
  const phaseLabel = t(`phase.${phase}` as any);

  return (
    <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.02] overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-cream/[0.02] transition-colors"
      >
        {isSpinning ? (
          <Spinner size="xs" color="primary" className="shrink-0" />
        ) : (
          <PhaseIcon className={`h-3.5 w-3.5 shrink-0 ${color}`} />
        )}
        <span className="text-xs font-mono font-medium text-cream flex-1 text-left truncate">{preview.app}</span>
        <span className={`text-[10px] ${color} capitalize`}>{phaseLabel}</span>
        {preview.port && (
          <span className="text-[10px] text-cream/45 font-mono">:{preview.port}</span>
        )}
        {preview.healStatus === "healing" && (
          <Badge variant="warning" className="text-[9px]">{t("autoHealing")}</Badge>
        )}
        {preview.healStatus === "exhausted" && (
          <Badge variant="destructive" className="text-[9px]">{t("healFailed")}</Badge>
        )}
        <ChevronDown className={`h-3 w-3 text-cream/45 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="border-t border-border">
          {preview.error && (
            <div className="px-3 py-2 bg-terra/5 border-b border-terra/10">
              <p className="text-[11px] text-terra font-mono break-all">{preview.error}</p>
            </div>
          )}
          {preview.logTail ? (
            <pre className="px-3 py-2 text-[11px] font-mono text-cream/60 whitespace-pre-wrap break-all max-h-48 overflow-y-auto bg-black/20 leading-relaxed">
              {preview.logTail}
            </pre>
          ) : (
            <div className="px-3 py-4 text-center text-[11px] text-cream/45">{t("noLogYet")}</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Production Tab ──

export function ObservabilityProduction({ serverDomain, deployment }: {
  serverDomain: string;
  deployment?: DeployedAppInfo | null;
}) {
  const t = useTranslations("console.observability");

  if (!deployment) {
    return (
      <div className="p-4">
        <div className="text-center py-8 border border-dashed border-border rounded-lg">
          <Rocket className="h-8 w-8 mx-auto mb-2 text-cream/45" />
          <p className="text-sm text-cream/60">{t("noDeployment")}</p>
          <p className="text-xs text-cream/45 mt-1">{t("noDeploymentHint")}</p>
        </div>
      </div>
    );
  }

  const domain = deployment.domain || (deployment.directory ? `${deployment.directory}.${serverDomain}` : serverDomain);

  return (
    <div className="p-4 space-y-4">
      <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-sodium" />
          <span className="text-sm font-medium text-cream">{t("deployed")}</span>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-cream/60">{t("application")}</span>
            <code className="text-xs font-mono text-cream">{deployment.name}</code>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-cream/60">{t("domain")}</span>
            <code className="text-xs font-mono text-cream/75 truncate max-w-[200px]">{domain}</code>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-cream/60">{t("directory")}</span>
            <code className="text-xs font-mono text-cream/75">{deployment.directory}</code>
          </div>
        </div>
      </div>

      {/* Production logs placeholder — real log streaming requires a dedicated endpoint */}
      <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-cream/60" />
          <span className="text-sm font-medium text-cream">{t("applicationLogs")}</span>
        </div>
        <div className="text-center py-6">
          <p className="text-xs text-cream/45">{t("logsComingSoon")}</p>
          <p className="text-[10px] text-cream/35 mt-1">{t("logsHint")}</p>
        </div>
      </div>
    </div>
  );
}

// ── Health Tab ──

export function ObservabilityHealth({ serverDomain }: { serverDomain: string }) {
  const t = useTranslations("console.observability");
  const { serverStatus, isConnected } = useRealtime();

  const cpuUsage = serverStatus?.cpuUsage ?? 0;
  const ramUsage = serverStatus?.ramUsage ?? 0;
  const activeSessions = serverStatus?.activeSessions ?? [];
  const lastSync = serverStatus?.lastSync;

  return (
    <div className="p-4 space-y-4">
      {/* Connection status */}
      <div className="flex items-center gap-2 text-xs">
        {isConnected ? (
          <>
            <Wifi className="h-3 w-3 text-sodium" />
            <span className="text-sodium">{t("connected")}</span>
          </>
        ) : (
          <>
            <WifiOff className="h-3 w-3 text-terra" />
            <span className="text-terra">{t("disconnected")}</span>
          </>
        )}
        {lastSync && (
          <span className="text-cream/45 ml-auto text-[10px]">
            {t("lastSync", { time: new Date(lastSync).toLocaleTimeString() })}
          </span>
        )}
      </div>

      {/* Resource gauges */}
      <div className="grid grid-cols-2 gap-3">
        <ResourceGauge
          icon={Cpu}
          label={t("cpu")}
          value={cpuUsage}
          unit="%"
          thresholds={{ warn: 70, critical: 90 }}
        />
        <ResourceGauge
          icon={MemoryStick}
          label={t("memory")}
          value={ramUsage}
          unit="%"
          thresholds={{ warn: 75, critical: 90 }}
        />
      </div>

      {/* Active sessions */}
      <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-cream/60" />
            <span className="text-sm font-medium text-cream">{t("activeSessions")}</span>
          </div>
          <Badge variant="outline" className="text-[10px]">{activeSessions.length}</Badge>
        </div>
        {activeSessions.length > 0 ? (
          <div className="space-y-1">
            {activeSessions.map((session, i) => (
              <div key={i} className="flex items-center gap-2 px-2 py-1.5 rounded border border-cream/[0.04] bg-cream/[0.02]">
                <Circle className="h-2 w-2 fill-sodium text-sodium shrink-0" />
                <span className="text-xs font-mono text-cream/75 truncate">{session}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-cream/45">{t("noActiveSessions")}</p>
        )}
      </div>

      {/* Service status */}
      <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-cream/60" />
          <span className="text-sm font-medium text-cream">{t("services")}</span>
        </div>
        <div className="space-y-1.5">
          <ServiceRow label={t("serviceTerminal")} active={serverStatus?.terminalEnabled ?? false} />
          <ServiceRow label={t("serviceSsh")} active={serverStatus?.sshEnabled ?? false} />
          <ServiceRow label={t("serviceRealtime")} active={isConnected} />
        </div>
      </div>

    </div>
  );
}

// ── Shared sub-components ──

function ResourceGauge({ icon: Icon, label, value, unit, thresholds }: {
  icon: typeof Cpu;
  label: string;
  value: number;
  unit: string;
  thresholds: { warn: number; critical: number };
}) {
  const color = value >= thresholds.critical
    ? "text-terra"
    : value >= thresholds.warn
      ? "text-sodium"
      : "text-sodium";

  const barColor = value >= thresholds.critical
    ? "bg-terra"
    : value >= thresholds.warn
      ? "bg-sodium"
      : "bg-sodium";

  return (
    <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 text-cream/60" />
          <span className="text-xs font-medium text-cream/75">{label}</span>
        </div>
        <span className={`text-sm font-mono font-semibold tabular-nums ${color}`}>
          {Math.round(value)}{unit}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-cream/[0.06] overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </div>
    </div>
  );
}

function ServiceRow({ label, active }: { label: string; active: boolean }) {
  const t = useTranslations("console.observability");
  return (
    <div className="flex items-center justify-between px-2 py-1.5 rounded border border-cream/[0.04] bg-cream/[0.02]">
      <span className="text-xs text-cream/75">{label}</span>
      <div className="flex items-center gap-1.5">
        <Circle className={`h-2 w-2 ${active ? "fill-sodium text-sodium" : "fill-cream/35 text-cream/35"}`} />
        <span className={`text-[10px] ${active ? "text-sodium" : "text-cream/45"}`}>
          {active ? t("running") : t("stopped")}
        </span>
      </div>
    </div>
  );
}

// ── Claw Tab ──

interface ZeroClawHealth {
  status: string;
  zeroclaw?: {
    running: boolean;
    status: string;
    pid?: number;
    cpu_usage?: number;
    ram_usage_mb?: number;
    uptime?: number;
    restarts?: number;
  };
}

interface AuthStatus {
  claude?: { configured: boolean; path?: string };
  gh?: { configured: boolean; path?: string };
  npm?: { configured: boolean; path?: string };
}

type SecurityTier = "standard" | "web_locked" | "private_locked";

export function ObservabilityClaw({ serverDomain, securityTier }: {
  serverDomain: string;
  securityTier: SecurityTier;
}) {
  const t = useTranslations("console.observability");
  const { send } = useVpsBridge();
  const [health, setHealth] = useState<ZeroClawHealth | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [authLoading, setAuthLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState<{ success: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const vpsUrl = getVpsApiUrl(serverDomain);
  const useBridge = securityTier !== "standard";

  // ── Fetch ZeroClaw gateway health ──
  const fetchHealth = useCallback(async () => {
    try {
      if (useBridge) {
        const data = await send<ZeroClawHealth>("watchdog_health");
        setHealth(data);
      } else {
        const res = await fetch(`${vpsUrl}/_auth/bridge/watchdog/health`, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (res.ok) {
          setHealth(await res.json());
        }
      }
      setError(null);
    } catch (err) {
      setError(t("watchdogUnreachable"));
      setHealth(null);
    } finally {
      setLoading(false);
    }
  }, [send, vpsUrl, useBridge, t]);

  // ── Fetch CLI auth status ──
  const fetchAuthStatus = useCallback(async () => {
    try {
      if (useBridge) {
        const data = await send<AuthStatus>("agents_auth_status");
        setAuthStatus(data);
      } else {
        const res = await fetch(`${vpsUrl}/_auth/bridge/agents/auth-status`, {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        if (res.ok) {
          setAuthStatus(await res.json());
        }
      }
    } catch {
      // Non-critical — auth status may not be available
    } finally {
      setAuthLoading(false);
    }
  }, [send, vpsUrl, useBridge]);

  useEffect(() => {
    fetchHealth();
    fetchAuthStatus();
  }, [fetchHealth, fetchAuthStatus]);

  // Health updates now arrive over the file-api WebSocket as `watchdog_health`
  useRealtimeSubscribe((message: RealtimeMessage) => {
    if (message.type !== "watchdog_health") return;
    if (!message.data) return;
    setHealth(message.data as ZeroClawHealth);
    setError(null);
    setLoading(false);
  });

  // ── Restart services ──
  const handleRestart = async () => {
    if (!window.confirm(t("restartConfirm"))) {
      return;
    }
    setRestarting(true);
    setRestartResult(null);
    try {
      if (useBridge) {
        const result = await send<{ success: boolean }>("restart_services");
        setRestartResult({
          success: result.success,
          message: result.success ? t("restartSuccess") : t("restartPartial"),
        });
      } else {
        const res = await fetch(`${vpsUrl}/_auth/bridge/restart-services`, {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        const result = await res.json();
        setRestartResult({
          success: result.success,
          message: result.success ? t("restartSuccess") : t("restartPartial"),
        });
      }
      // Re-fetch health after restart
      setTimeout(fetchHealth, 3000);
    } catch (err) {
      setRestartResult({
        success: false,
        message: err instanceof Error ? err.message : t("restartFailed"),
      });
    } finally {
      setRestarting(false);
      setTimeout(() => setRestartResult(null), 5000);
    }
  };

  const oc = health?.zeroclaw;
  const isRunning = oc?.running ?? false;
  const gatewayStatus = oc?.status ?? "unknown";

  // Format uptime
  const formatUptime = (ms: number): string => {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="default" color="muted" />
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      {/* ZeroClaw Runtime Card */}
      <div className="relative rounded-lg border border-blue-500/20 bg-blue-950/20 p-4 space-y-3 overflow-hidden">
        {/* Subtle ambient glow */}
        {isRunning && (
          <div className="absolute inset-0 rounded-lg bg-blue-500/[0.03] animate-pulse pointer-events-none" style={{ animationDuration: '4s' }} />
        )}

        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="text-base drop-shadow-[0_0_8px_rgba(37,99,235,0.8)]">🦀</span>
            <div>
              <span className="text-sm font-semibold text-cream">{t("zeroclawTitle")}</span>
              <span className="ml-1.5 text-[10px] font-mono text-blue-400/80 uppercase tracking-wider">{t("zeroclawTagline")}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchHealth}
              className="h-7 text-xs text-cream/60 hover:text-cream px-2"
              title={t("refresh")}
            >
              <RefreshCcw className="h-3 w-3" />
            </Button>
            <Badge
              variant={isRunning ? "default" : "destructive"}
              className={`text-[10px] ${isRunning ? "bg-blue-500/20 text-blue-300 border-blue-500/30" : ""}`}
            >
              {isRunning ? t("active") : t("offline")}
            </Badge>
          </div>
        </div>

        {error ? (
          <div className="relative flex items-center gap-2 px-3 py-2 rounded-lg bg-terra/10 border border-terra/20">
            <AlertCircle className="h-3.5 w-3.5 text-terra shrink-0" />
            <span className="text-xs text-terra">{error}</span>
          </div>
        ) : oc ? (
          <div className="relative space-y-2">
            {/* Architecture badge */}
            <div className="flex items-center gap-2 text-[10px] text-blue-300/60 font-mono uppercase tracking-wider">
              <span>{t("dedicatedSubprocess")}</span>
              <span className="text-blue-500/30">|</span>
              <span>{t("perProjectIsolate")}</span>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div className="rounded border border-blue-500/10 bg-blue-950/30 px-2.5 py-2 text-center">
                <div className="text-lg font-bold text-blue-300 font-mono tabular-nums">
                  {oc.ram_usage_mb ? `${oc.ram_usage_mb}` : '<5'}
                  <span className="text-[10px] font-normal text-blue-400/50 ml-0.5">{t("memoryUnit")}</span>
                </div>
                <div className="text-[9px] text-blue-400/40 uppercase tracking-widest mt-0.5">{t("memoryLabel")}</div>
              </div>
              <div className="rounded border border-blue-500/10 bg-blue-950/30 px-2.5 py-2 text-center">
                <div className="text-lg font-bold text-blue-300 font-mono tabular-nums">
                  {oc.uptime !== undefined ? formatUptime(oc.uptime) : '--'}
                </div>
                <div className="text-[9px] text-blue-400/40 uppercase tracking-widest mt-0.5">{t("uptimeLabel")}</div>
              </div>
              <div className="rounded border border-blue-500/10 bg-blue-950/30 px-2.5 py-2 text-center">
                <div className="text-lg font-bold text-blue-300 font-mono tabular-nums">
                  {'<50'}
                  <span className="text-[10px] font-normal text-blue-400/50 ml-0.5">{t("coldStartUnit")}</span>
                </div>
                <div className="text-[9px] text-blue-400/40 uppercase tracking-widest mt-0.5">{t("coldStartLabel")}</div>
              </div>
            </div>
          </div>
        ) : (
          <p className="relative text-xs text-cream/45">{t("runtimeUnavailable")}</p>
        )}
      </div>

      {/* CLI Auth Status */}
      {!authLoading && authStatus && (
        <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-4 space-y-3">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-cream/60" />
            <span className="text-sm font-medium text-cream">{t("cliCredentialsTitle")}</span>
          </div>
          <div className="space-y-1.5">
            {(["claude", "gh", "npm"] as const).map((tool) => {
              const info = authStatus[tool];
              if (!info) return null;
              return (
                <div key={tool} className="flex items-center justify-between px-2 py-1.5 rounded border border-cream/[0.04] bg-cream/[0.02]">
                  <span className="text-xs text-cream/75 capitalize font-mono">{tool}</span>
                  <div className="flex items-center gap-1.5">
                    {info.configured ? (
                      <>
                        <Check className="h-3 w-3 text-sodium" />
                        <span className="text-[10px] text-sodium">{t("configured")}</span>
                      </>
                    ) : (
                      <>
                        <X className="h-3 w-3 text-terra" />
                        <span className="text-[10px] text-terra">{t("notConfigured")}</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Repair Actions */}
      <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-sodium" />
          <span className="text-sm font-medium text-cream">{t("quickActions")}</span>
        </div>

        <div className="space-y-2">
          <button
            onClick={handleRestart}
            disabled={restarting}
            className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg border border-cream/[0.06] bg-cream/[0.02] hover:bg-cream/[0.04] transition-colors disabled:opacity-50"
          >
            <div className="flex items-center gap-2">
              <RefreshCcw className={`h-3.5 w-3.5 text-cream/60 ${restarting ? "animate-spin" : ""}`} />
              <div className="text-left">
                <p className="text-xs font-medium text-cream">{t("restartServices")}</p>
                <p className="text-[10px] text-cream/45">{t("restartServicesHint")}</p>
              </div>
            </div>
            {restarting && <Spinner size="xs" color="muted" />}
          </button>
        </div>

        {/* Restart result feedback */}
        {restartResult && (
          <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${
            restartResult.success
              ? "bg-sodium/10 border border-sodium/20 text-sodium"
              : "bg-terra/10 border border-terra/20 text-terra"
          }`}>
            {restartResult.success ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            )}
            <span>{restartResult.message}</span>
          </div>
        )}
      </div>

      {/* Troubleshooting guide */}
      <div className="rounded-lg border border-cream/[0.06] bg-cream/[0.02] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-cream/60" />
          <span className="text-sm font-medium text-cream">{t("troubleshooting")}</span>
        </div>
        <div className="space-y-2 text-xs text-cream/60">
          <TroubleshootRow
            condition={!isRunning && !error}
            title={t("gatewayNotRunningTitle")}
            fix={t("gatewayNotRunningFix")}
          />
          <TroubleshootRow
            condition={oc?.restarts !== undefined && oc.restarts > 10}
            title={t("excessiveRestartsTitle")}
            fix={t("excessiveRestartsFix")}
          />
          <TroubleshootRow
            condition={!!error}
            title={t("watchdogUnreachableTitle")}
            fix={t("watchdogUnreachableFix")}
          />
          {/* Default — always visible when no issues */}
          {isRunning && !error && (oc?.restarts === undefined || oc.restarts <= 10) && (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded border border-sodium/10 bg-sodium/[0.03]">
              <CheckCircle2 className="h-3.5 w-3.5 text-sodium shrink-0" />
              <span className="text-sodium/80">{t("allOperational")}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCell({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="px-2 py-1.5 rounded border border-cream/[0.04] bg-cream/[0.02]">
      <p className="text-[10px] text-cream/45">{label}</p>
      <p className={`text-xs font-mono font-medium ${warn ? "text-sodium" : "text-cream"}`}>{value}</p>
    </div>
  );
}

function TroubleshootRow({ condition, title, fix }: {
  condition: boolean;
  title: string;
  fix: string;
}) {
  if (!condition) return null;
  return (
    <div className="px-2 py-2 rounded border border-sodium/15 bg-sodium/[0.03] space-y-1">
      <p className="text-xs font-medium text-sodium">{title}</p>
      <p className="text-[11px] text-cream/60 leading-relaxed">{fix}</p>
    </div>
  );
}
