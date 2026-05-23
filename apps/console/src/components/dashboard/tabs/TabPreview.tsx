// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect, useRef, useCallback, useMemo, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { createPortal } from "react-dom";
import {
  RefreshCw, ExternalLink, Smartphone, Tablet, Monitor, Maximize2, Package,
  RotateCcw, ChevronDown, ChevronRight, AlertTriangle, XCircle, Wrench, Layers, Server, Play,
  Terminal, Sparkles, Plus, Trash2,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAppsList, type ApiApp, type ApiPackage } from "@/contexts/AppsListContext";
import { getDevUrl, getDevDomain, getCodeApiUrl, getIframeBaseUrl, isValidServerOrigin } from "@/lib/domains";
import { API_URL } from "@/lib/api";
import { useVpsBridge } from "@/lib/vps-bridge";
import { useCodeToken } from "@/contexts/CodeTokenContext";
import { useRealtimeSubscribe } from "@/providers/realtime-provider";
import { useQueryClient } from "@tanstack/react-query";
import { cn, isTauriApp } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { ApiDocsPreview } from "./ApiDocsPreview";

const VIEWPORTS = {
  responsive: { label: "Responsive", width: "100%", height: "100%", icon: Maximize2 },
  mobile: { label: "Mobile", width: 375, height: 667, icon: Smartphone },
  tablet: { label: "Tablet", width: 768, height: 1024, icon: Tablet },
  desktop: { label: "Desktop", width: 1280, height: 800, icon: Monitor },
} as const;
type ViewportKey = keyof typeof VIEWPORTS;

// PreviewStatus comes from useCurrentApp which sources it from @ellul.ai/types
import type { PreviewStatus } from "@/hooks/useCurrentApp";

interface CompanionPreviewStatus extends PreviewStatus {
  pathPrefix: string;
}

interface TabPreviewProps {
  ipAddress: string;
  domain?: string;
  serverId: string;
  // Required — this panel only mounts when the workspace state machine is
  app: ApiApp;
  selectedDirectory?: string | null;
  preview?: PreviewStatus | null;
  companions?: CompanionPreviewStatus[];
  onPreviewStart?: (directory: string) => void;
  onPreviewClear?: () => void;
  requestedPreviewApp?: string | null;
  // When provided, the preview's toolbar renders into this host element
  toolbarHost?: HTMLElement | null;
  // Hand diagnostic context off to the chat iframe when the user clicks
  onFixRequest?: (data: { scope: string; error: string; logTail?: string; kind: "install_failed" | "unit_failed" }) => void;
  onUpgrade?: () => void;
}

const FRAMEWORK_LABELS: Record<string, string> = {
  next: "Next.js", nextjs: "Next.js", nuxt: "Nuxt", remix: "Remix", astro: "Astro",
  vite: "Vite", cra: "React", svelte: "SvelteKit", gatsby: "Gatsby", "vue-cli": "Vue",
  express: "Express", fastify: "Fastify", hono: "Hono", nestjs: "NestJS", koa: "Koa",
  golang: "Go", go: "Go", rust: "Rust", dotnet: ".NET", fastapi: "FastAPI", flask: "Flask",
  django: "Django", streamlit: "Streamlit", gradio: "Gradio", python: "Python",
  rails: "Rails", sinatra: "Sinatra", ruby: "Ruby",
  laravel: "Laravel", php: "PHP", phoenix: "Phoenix", elixir: "Elixir",
  "spring-boot": "Spring Boot", "spring-boot-gradle": "Spring Boot",
  "java-maven": "Java", "java-gradle": "Java",
  bun: "Bun", dart: "Dart", flutter: "Flutter", html: "HTML",
  turbo: "Turborepo", nx: "Nx", lerna: "Lerna", "pnpm-workspace": "pnpm Workspaces",
  unknown: "Unknown",
};
function getFrameworkLabel(fw: string): string {
  return FRAMEWORK_LABELS[fw] || fw.charAt(0).toUpperCase() + fw.slice(1);
}

// ───────────────────────────────────────────────────────────────────
// Rendered whenever preview start failed because we couldn't infer a
// runnable command (`spec_missing`) or because the inferred binary
// ───────────────────────────────────────────────────────────────────
function ResourceGatePanel({
  resourceContext,
  onRetry,
  onUpgrade,
}: {
  resourceContext: {
    reason: string;
    estimatedPeakMB: number;
    estimatedSteadyMB: number;
    availableMB: number;
    totalMB: number;
    frameworkId: string | null;
    perPreviewCapMB: number;
    activePreviewCount: number;
    maxConcurrent: number;
  };
  onRetry: () => void;
  onUpgrade?: () => void;
}) {
  const t = useTranslations("console.preview");
  const { totalMB, availableMB, estimatedPeakMB, frameworkId, activePreviewCount } = resourceContext;

  const usedMB = totalMB - availableMB;
  const usedPct = totalMB > 0 ? Math.min(100, (usedMB / totalMB) * 100) : 0;
  const neededPct = totalMB > 0 ? Math.min(100 - usedPct, (estimatedPeakMB / totalMB) * 100) : 0;

  const frameworkLabel = frameworkId ? getFrameworkLabel(frameworkId.replace(/^runtime:/, "")) : "Unknown";
  const isHobbyTier = totalMB <= 4400;

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-card overflow-y-auto px-4 py-8">
      <div className="w-full max-w-lg space-y-5">
        <div className="flex flex-col items-center text-center">
          <div className="w-10 h-10 rounded-xl bg-terra/10 border border-terra/20 flex items-center justify-center mb-3">
            <AlertTriangle className="h-5 w-5 text-terra" />
          </div>
          <h2 className="text-lg font-semibold text-cream/85 tracking-tight">
            {t("resourceBlockedTitle")}
          </h2>
          <p className="mt-1 text-sm text-cream/55 max-w-md">
            {t("resourceBlockedSub")}
          </p>
        </div>

        <div className="space-y-2 p-4 rounded-xl bg-background/40 border border-border">
          <div className="h-2 rounded-full bg-cream/[0.06] overflow-hidden flex">
            <div className="bg-cream/20 transition-all" style={{ width: `${usedPct}%` }} />
            <div className="bg-sodium/70 transition-all" style={{ width: `${neededPct}%` }} />
          </div>
          <div className="flex justify-between text-[11px] text-cream/50">
            <span>{t("resourceUsed", { mb: Math.round(usedMB) })}</span>
            <span>{t("resourceNeeded", { mb: Math.round(estimatedPeakMB) })}</span>
            <span>{t("resourceTotal", { mb: Math.round(totalMB) })}</span>
          </div>
        </div>

        <div className="space-y-1.5 text-[12px] text-cream/55 px-1">
          <p>{t("resourceVpsHas", { totalMB: Math.round(totalMB) })}</p>
          <p>{t("resourceFrameworkNeeds", { framework: frameworkLabel, peakMB: Math.round(estimatedPeakMB) })}</p>
          <p>{t("resourceAvailable", { availableMB: Math.round(availableMB) })}</p>
          {activePreviewCount > 0 && (
            <p>{t("resourceOtherPreviews", { count: activePreviewCount })}</p>
          )}
        </div>

        <div className="p-3 rounded-lg bg-blue-500/5 border border-blue-500/15 text-[12px] text-cream/65">
          {isHobbyTier ? t("resourceUpgradeHobby") : t("resourceUpgradePro")}
        </div>

        <div className="flex gap-2">
          {isHobbyTier && onUpgrade ? (
            <Button onClick={onUpgrade} className="flex-1 text-xs">
              {t("resourceUpgradeCta")}
            </Button>
          ) : (
            <Button asChild className="flex-1 text-xs">
              <a href="mailto:hello@ellul.ai">{t("resourceContactCta")}</a>
            </Button>
          )}
          <Button variant="outline" onClick={onRetry} className="flex-1 text-xs">
            <RefreshCw className="h-3 w-3 mr-1.5" />
            {t("resourceRetry")}
          </Button>
        </div>
      </div>
    </div>
  );
}

type ManualSpecResponse = {
  ok: boolean;
  error?: string;
  spec?: unknown;
  preview?: {
    failReason?: string;
    error?: string;
    manualConfig?: { suggestedStart?: string; suggestedPort?: number; packageManager?: "npm" | "yarn" | "pnpm" | "bun" };
  };
  health?: unknown;
};

type EnvPair = { key: string; value: string };

function ManualConfigPanel({
  scope,
  reason,
  failReason,
  hint,
  codeApiUrl,
  fetchWithCodeToken,
  onDismiss,
  onSubmitted,
  editMode,
}: {
  scope: string;
  reason: string;
  failReason: "spec_missing" | "binary_not_found";
  hint: { suggestedStart?: string; suggestedPort?: number; packageManager?: "npm" | "yarn" | "pnpm" | "bun" };
  codeApiUrl: string;
  fetchWithCodeToken: (url: string, options?: RequestInit) => Promise<Response>;
  onDismiss: () => void;
  onSubmitted: (outcome: ManualSpecResponse) => void;
  editMode?: boolean;
}) {
  const t = useTranslations("console.preview");
  const [start, setStart] = useState<string>(hint.suggestedStart ?? "");
  const [port, setPort] = useState<string>(
    hint.suggestedPort != null ? String(hint.suggestedPort) : "",
  );
  const [mode, setMode] = useState<"hot" | "warm">("hot");
  const [envPairs, setEnvPairs] = useState<EnvPair[]>([]);
  const [prodStart, setProdStart] = useState("");
  const [runtime, setRuntime] = useState("auto");
  const [prodEnvPairs, setProdEnvPairs] = useState<EnvPair[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(editMode === true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editMode) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithCodeToken(`${codeApiUrl}/api/preview/spec?app=${encodeURIComponent(scope)}`);
        if (!res.ok || cancelled) { setLoading(false); return; }
        const data = await res.json();
        const spec = data?.spec;
        if (!spec || cancelled) { setLoading(false); return; }
        if (spec.start) setStart(spec.start);
        if (spec.port) setPort(String(spec.port));
        if (spec.mode === "hot" || spec.mode === "warm") setMode(spec.mode);
        if (spec.prodStart) { setProdStart(spec.prodStart); setShowAdvanced(true); }
        if (spec.runtime) setRuntime(spec.runtime);
        if (spec.env && typeof spec.env === "object") {
          setEnvPairs(Object.entries(spec.env).map(([key, value]) => ({ key, value: String(value) })));
        }
        if (spec.prodEnv && typeof spec.prodEnv === "object") {
          setProdEnvPairs(Object.entries(spec.prodEnv).map(([key, value]) => ({ key, value: String(value) })));
          if (Object.keys(spec.prodEnv).length > 0) setShowAdvanced(true);
        }
      } catch { /* network error — proceed with defaults */ }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [editMode, codeApiUrl, scope, fetchWithCodeToken]);

  const headline = editMode
    ? t("editConfigHeadline")
    : failReason === "binary_not_found"
      ? t("manualConfigBinaryNotFound")
      : t("manualConfigSpecMissing");
  const subhead = editMode
    ? t("editConfigSubhead")
    : failReason === "binary_not_found"
      ? t("manualConfigBinarySub")
      : t("manualConfigSpecMissingSub");

  const pairsToRecord = (pairs: EnvPair[]): Record<string, string> | undefined => {
    const filtered = pairs.filter(p => p.key.trim());
    if (filtered.length === 0) return undefined;
    const rec: Record<string, string> = {};
    for (const p of filtered) rec[p.key.trim()] = p.value;
    return rec;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = start.trim();
    if (!trimmed) {
      setError(t("startCommandRequired"));
      return;
    }
    const portNum = port ? Number(port) : undefined;
    if (port && (!Number.isFinite(portNum) || !portNum || portNum <= 0 || portNum >= 65536)) {
      setError(t("portInvalid"));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        app: scope,
        start: trimmed,
        ...(portNum != null ? { port: portNum } : {}),
        mode,
      };
      const env = pairsToRecord(envPairs);
      if (env) body.env = env;
      const prodEnv = pairsToRecord(prodEnvPairs);
      if (prodEnv) body.prodEnv = prodEnv;
      if (prodStart.trim()) body.prodStart = prodStart.trim();

      const res = await fetchWithCodeToken(`${codeApiUrl}/api/preview/spec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const respBody = await res.text().catch(() => "");
        setError(respBody.slice(0, 200) || res.statusText || `HTTP ${res.status}`);
        return;
      }
      const outcome = (await res.json().catch(() => ({ ok: true }))) as ManualSpecResponse;
      onSubmitted(outcome);
    } catch (err) {
      setError((err as Error).message || t("networkError"));
    } finally {
      setSubmitting(false);
    }
  };

  const updateEnvPair = (index: number, field: "key" | "value", val: string, pairs: EnvPair[], setPairs: (p: EnvPair[]) => void) => {
    const next = pairs.map((p, i) => i === index ? { key: field === "key" ? val : p.key, value: field === "value" ? val : p.value } : p);
    setPairs(next);
  };

  const renderEnvEditor = (pairs: EnvPair[], setPairs: (p: EnvPair[]) => void, label: string, hintKey: "envHint" | "prodEnvHint") => (
    <div className="space-y-2">
      <Label className="text-xs text-cream/75">{label}</Label>
      {pairs.map((pair, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            value={pair.key}
            onChange={(e) => updateEnvPair(i, "key", e.target.value, pairs, setPairs)}
            placeholder={t("envKeyPlaceholder")}
            disabled={submitting}
            className="font-mono text-xs flex-1"
          />
          <span className="text-cream/30 text-xs">=</span>
          <Input
            value={pair.value}
            onChange={(e) => updateEnvPair(i, "value", e.target.value, pairs, setPairs)}
            placeholder={t("envValuePlaceholder")}
            disabled={submitting}
            className="font-mono text-xs flex-1"
          />
          <button
            type="button"
            onClick={() => setPairs(pairs.filter((_, j) => j !== i))}
            disabled={submitting}
            className="text-cream/40 hover:text-terra transition-colors shrink-0"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setPairs([...pairs, { key: "", value: "" }])}
        disabled={submitting}
        className="text-[11px] text-cream/55 hover:text-cream/75 transition-colors flex items-center gap-1"
      >
        <Plus className="h-3 w-3" />
        {t("addVariable")}
      </button>
      <p className="text-[11px] text-cream/45">{t(hintKey)}</p>
    </div>
  );

  if (loading) {
    return (
      <div className="absolute inset-0 z-10 flex items-center justify-center bg-card">
        <Spinner size="sm" label={t("loadingConfig")} color="primary" />
      </div>
    );
  }

  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-card">
      <div className="flex-1 flex items-center justify-center p-6 overflow-y-auto">
        <form onSubmit={handleSubmit} className="max-w-lg w-full space-y-5">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-sodium/10 border border-sodium/20 flex items-center justify-center shrink-0">
              {editMode ? <Wrench className="h-5 w-5 text-sodium" /> : <Terminal className="h-5 w-5 text-sodium" />}
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-cream/85">{headline}</h3>
              <p className="text-xs text-cream/60 mt-0.5">{subhead}</p>
              {!editMode && reason && reason !== failReason && (
                <p className="text-[11px] text-cream/45 mt-1 font-mono break-all">{reason}</p>
              )}
            </div>
          </div>

          {!editMode && hint.packageManager && (
            <div className="text-[11px] text-cream/55 px-3 py-2 rounded-lg bg-cream/[0.03] border border-cream/[0.08]/20">
              {t.rich("manualPackageManager", {
                pm: () => <span className="font-mono text-cream/75">{hint.packageManager}</span>,
              })}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="preview-start" className="text-xs text-cream/75">{t("startCommandLabel")}</Label>
            <Input
              id="preview-start"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              placeholder={t("devCommandPlaceholder")}
              disabled={submitting}
              className="font-mono text-xs"
              autoFocus={!editMode}
            />
            <p className="text-[11px] text-cream/45">
              {t.rich("startCommandHint", {
                port: (chunks) => <span className="font-mono">{chunks}</span>,
                bin: (chunks) => <span className="font-mono">{chunks}</span>,
              })}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="preview-port" className="text-xs text-cream/75">{t("portLabel")}</Label>
            <Input
              id="preview-port"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder={hint.suggestedPort != null ? String(hint.suggestedPort) : "3000"}
              disabled={submitting}
              className="font-mono text-xs w-32"
            />
            <p className="text-[11px] text-cream/45">
              {t("portHint")}
            </p>
          </div>

          {/* Mode toggle */}
          <div className="space-y-2">
            <Label className="text-xs text-cream/75">{t("modeLabel")}</Label>
            <div className="flex items-center gap-3">
              <span className={cn("text-xs", mode === "hot" ? "text-cream/85 font-medium" : "text-cream/50")}>{t("modeHot")}</span>
              <Switch
                checked={mode === "warm"}
                onCheckedChange={(checked) => setMode(checked ? "warm" : "hot")}
                disabled={submitting}
              />
              <span className={cn("text-xs", mode === "warm" ? "text-cream/85 font-medium" : "text-cream/50")}>{t("modeWarm")}</span>
            </div>
            <p className="text-[11px] text-cream/45">{t("modeHint")}</p>
          </div>

          {/* Env vars */}
          {renderEnvEditor(envPairs, setEnvPairs, t("envLabel"), "envHint")}

          {/* Advanced section */}
          <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
            <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-cream/55 hover:text-cream/75 transition-colors">
              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", showAdvanced && "rotate-90")} />
              {t("advancedLabel")}
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-5 pt-4">
              <div className="space-y-2">
                <Label htmlFor="preview-prod-start" className="text-xs text-cream/75">{t("prodStartLabel")}</Label>
                <Input
                  id="preview-prod-start"
                  value={prodStart}
                  onChange={(e) => setProdStart(e.target.value)}
                  placeholder={t("startCommandPlaceholder")}
                  disabled={submitting}
                  className="font-mono text-xs"
                />
                <p className="text-[11px] text-cream/45">{t("prodStartHint")}</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="preview-runtime" className="text-xs text-cream/75">{t("runtimeLabel")}</Label>
                <select
                  id="preview-runtime"
                  value={runtime}
                  onChange={(e) => setRuntime(e.target.value)}
                  disabled={submitting}
                  className="h-9 w-48 rounded-md border border-input bg-background px-3 text-xs font-mono text-cream/85 focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="auto">auto</option>
                  <option value="node">node</option>
                  <option value="bun">bun</option>
                  <option value="deno">deno</option>
                  <option value="python">python</option>
                  <option value="go">go</option>
                  <option value="ruby">ruby</option>
                  <option value="rust">rust</option>
                  <option value="java">java</option>
                  <option value="dotnet">dotnet</option>
                  <option value="php">php</option>
                  <option value="elixir">elixir</option>
                </select>
              </div>

              {renderEnvEditor(prodEnvPairs, setProdEnvPairs, t("prodEnvLabel"), "prodEnvHint")}
            </CollapsibleContent>
          </Collapsible>

          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-terra/10 border border-terra/20">
              <XCircle className="h-4 w-4 text-terra shrink-0 mt-0.5" />
              <span className="text-xs text-terra break-all">{error}</span>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button type="submit" disabled={submitting}>
              {submitting ? (
                <>
                  <Spinner size="xs" color="primary" className="mr-2" />
                  {t("saving")}
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5 mr-1.5" />
                  {editMode ? t("saveAndRestart") : t("saveAndStart")}
                </>
              )}
            </Button>
            <Button type="button" variant="ghost" onClick={onDismiss} disabled={submitting}>
              {t("cancel")}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Companion Panel ──────────────────────────────────────────────────
interface CompanionPanelProps {
  packages: ApiPackage[];
  primaryDir: string;
  companions: CompanionPreviewStatus[];
  codeApiUrl: string;
  fetchWithCodeToken: (url: string, init?: RequestInit) => Promise<Response>;
}

interface RamEstimate {
  estimatedSteadyMB: number;
  estimatedPeakMB: number;
  availableMB: number;
  totalMB: number;
  wouldFit: boolean;
  frameworkId: string | null;
}

function validatePrefix(value: string): string | null {
  if (!value.startsWith("/")) return "Must start with /";
  if (value.length < 2) return "Too short";
  if (value === "/") return "Cannot be /";
  const clean = value.replace(/\/+$/, "");
  if (/[^a-zA-Z0-9/_-]/.test(clean)) return "Invalid characters";
  return null;
}

function CompanionPanel({ packages, primaryDir, companions, codeApiUrl, fetchWithCodeToken }: CompanionPanelProps) {
  const t = useTranslations("console.preview");
  const [expanded, setExpanded] = useState(false);
  const [prefixes, setPrefixes] = useState<Record<string, string>>({});
  // Optimistic local override while a toggle POST/DELETE is in flight.
  // Cleared when the next `companions` prop arrives from the WebSocket broadcast.
  const [optimistic, setOptimistic] = useState<Record<string, "starting" | "stopping">>({});
  const [ramGateDir, setRamGateDir] = useState<string | null>(null);
  const [estimates, setEstimates] = useState<Record<string, RamEstimate>>({});
  const fetchedEstimatesRef = useRef<Set<string>>(new Set());

  const candidatePackages = useMemo(
    () => packages.filter((p) => p.directory !== primaryDir && p.previewable),
    [packages, primaryDir],
  );

  // Clear optimistic state once the real WebSocket broadcast arrives and
  // the companions prop reflects the change we were waiting for.
  const prevCompanionsRef = useRef(companions);
  useEffect(() => {
    if (prevCompanionsRef.current === companions) return;
    prevCompanionsRef.current = companions;
    setOptimistic((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [dir, intent] of Object.entries(next)) {
        const exists = companions.some((c) => c.app === dir);
        if ((intent === "starting" && exists) || (intent === "stopping" && !exists)) {
          delete next[dir];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [companions]);

  const fetchEstimate = useCallback(async (dir: string) => {
    if (fetchedEstimatesRef.current.has(dir)) return;
    fetchedEstimatesRef.current.add(dir);
    try {
      const res = await fetchWithCodeToken(`${codeApiUrl}/api/preview/estimate?app=${encodeURIComponent(dir)}`);
      if (res.ok) {
        const data: RamEstimate = await res.json();
        setEstimates((prev) => ({ ...prev, [dir]: data }));
      }
    } catch {
      fetchedEstimatesRef.current.delete(dir);
    }
  }, [codeApiUrl, fetchWithCodeToken]);

  useEffect(() => {
    if (expanded) {
      candidatePackages.forEach((p) => fetchEstimate(p.directory));
    }
  }, [expanded, candidatePackages, fetchEstimate]);

  const doStart = useCallback(async (dir: string) => {
    const pathPrefix = prefixes[dir] || "/api";
    setOptimistic((prev) => ({ ...prev, [dir]: "starting" }));
    try {
      const res = await fetchWithCodeToken(`${codeApiUrl}/api/preview/companion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app: dir, pathPrefix }),
      });
      const data = await res.json();
      if (!data.success) {
        setOptimistic((prev) => { const n = { ...prev }; delete n[dir]; return n; });
        toast.error(data.error || t("companionStartFailed"));
      }
      if (data.warning) {
        toast.warning(data.warning);
      }
    } catch (e) {
      setOptimistic((prev) => { const n = { ...prev }; delete n[dir]; return n; });
      toast.error((e as Error).message || t("companionToggleFailed"));
    }
  }, [codeApiUrl, fetchWithCodeToken, prefixes]);

  const doStop = useCallback(async (dir: string) => {
    setOptimistic((prev) => ({ ...prev, [dir]: "stopping" }));
    try {
      await fetchWithCodeToken(`${codeApiUrl}/api/preview/companion`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app: dir }),
      });
    } catch (e) {
      setOptimistic((prev) => { const n = { ...prev }; delete n[dir]; return n; });
      toast.error((e as Error).message || t("companionToggleFailed"));
    }
  }, [codeApiUrl, fetchWithCodeToken]);

  const handleToggle = useCallback((dir: string, on: boolean) => {
    if (on) {
      const estimate = estimates[dir];
      if (estimate && !estimate.wouldFit) {
        setRamGateDir(dir);
        return;
      }
      void doStart(dir);
    } else {
      void doStop(dir);
    }
  }, [estimates, doStart, doStop]);

  if (candidatePackages.length === 0) return null;

  const activeCount = companions.filter((c) => c.active).length;

  return (
    <div className="border-t border-border bg-card/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-xs font-medium text-cream/65 hover:text-cream/80 transition-colors"
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        <Server className="h-3.5 w-3.5" />
        Companions
        {activeCount > 0 && (
          <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-sodium/15 text-sodium border border-sodium/30">
            {activeCount} running
          </span>
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-2">
          {candidatePackages.map((pkg) => {
            const companion = companions.find((c) => c.app === pkg.directory);
            const opt = optimistic[pkg.directory];
            const isRunning = companion?.active === true;
            const isServerStarting = !!companion && !companion.active && companion.phase !== "crashed";
            const isCrashed = companion?.phase === "crashed";
            const shortName = pkg.name?.split("/").pop() || pkg.directory.split("/").pop() || pkg.directory;
            const currentPrefix = isRunning ? companion.pathPrefix : (prefixes[pkg.directory] || "/api");
            const prefixError = !isRunning ? validatePrefix(currentPrefix) : null;
            const isRamGated = ramGateDir === pkg.directory;
            const estimate = estimates[pkg.directory];

            // Effective visual state: optimistic intent wins over server state
            // so the switch feels instant even before WebSocket confirms.
            const visualOn = opt === "starting" || (isRunning && opt !== "stopping") || isServerStarting;
            const isBusy = !!opt;

            return (
              <div
                key={pkg.directory}
                className={cn(
                  "rounded-lg border p-3 transition-colors",
                  isRunning
                    ? "border-sodium/30 bg-sodium/[0.04]"
                    : isCrashed
                      ? "border-terra/30 bg-terra/[0.04]"
                      : "border-border bg-background/30",
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-cream/80 truncate">{shortName}</span>
                      <span className="text-[10px] text-cream/45">{getFrameworkLabel(pkg.framework)}</span>
                      {isRunning && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-sodium/15 text-sodium border border-sodium/30">
                          {companion.pathPrefix}
                        </span>
                      )}
                      {(isServerStarting || opt === "starting") && <Spinner size="xs" color="primary" />}
                      {isCrashed && !opt && (
                        <button
                          onClick={() => { void doStop(pkg.directory).then(() => doStart(pkg.directory)); }}
                          className="flex items-center gap-1 text-[10px] text-terra hover:text-terra/80 transition-colors"
                        >
                          <XCircle className="h-3 w-3" />
                          <span>{t("restart")}</span>
                        </button>
                      )}
                    </div>
                    {estimate && !isRunning && !isCrashed && (
                      <div className="mt-1 text-[10px] text-cream/40">
                        ~{estimate.estimatedSteadyMB}MB steady · {estimate.availableMB}MB available
                        {!estimate.wouldFit && (
                          <span className="ml-1.5 text-sodium">tight on memory</span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {!isRunning && !isServerStarting && !opt && (
                      <div className="relative">
                        <Input
                          value={currentPrefix}
                          onChange={(e) => setPrefixes((prev) => ({ ...prev, [pkg.directory]: e.target.value }))}
                          className={cn(
                            "w-20 h-7 text-[11px] font-mono px-1.5",
                            prefixError && currentPrefix !== "/api" && "border-terra/50 focus-visible:ring-terra/30",
                          )}
                          placeholder={t("proxyPathPlaceholder")}
                        />
                        {prefixError && currentPrefix !== "/api" && currentPrefix.length > 0 && (
                          <div className="absolute top-full mt-1 right-0 text-[9px] text-terra whitespace-nowrap">
                            {prefixError}
                          </div>
                        )}
                      </div>
                    )}
                    <Switch
                      checked={visualOn}
                      disabled={isBusy || (!!prefixError && !isRunning && !isServerStarting)}
                      onCheckedChange={(checked) => handleToggle(pkg.directory, checked)}
                    />
                  </div>
                </div>

                {isRamGated && estimate && (
                  <div className="mt-2 flex items-center gap-2 px-2.5 py-2 rounded-lg bg-sodium/10 border border-sodium/20">
                    <AlertTriangle className="h-3.5 w-3.5 text-sodium shrink-0" />
                    <span className="text-[11px] text-sodium flex-1">
                      ~{estimate.estimatedPeakMB}MB peak, {estimate.availableMB}MB available. May cause slowdowns.
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-[10px] px-2 border-sodium/30 text-sodium hover:bg-sodium/10"
                      onClick={() => { setRamGateDir(null); void doStart(pkg.directory); }}
                    >
                      Start anyway
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[10px] px-2 text-cream/50"
                      onClick={() => setRamGateDir(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TabPreview({
  ipAddress, domain, serverId, app, selectedDirectory, preview,
  companions = [], onPreviewStart, onPreviewClear, requestedPreviewApp,
  toolbarHost, onFixRequest, onUpgrade,
}: TabPreviewProps) {
  const t = useTranslations("console.preview");
  const { isLoading: isAppLoading } = useAppsList();
  const { ready: vpsBridgeReady, send: vpsBridgeSend } = useVpsBridge();
  const { fetchWithCodeToken } = useCodeToken();
  const queryClient = useQueryClient();

  // ── Monorepo + package selection ────────────────────────────────────
  const isMonorepo = app?.isMonorepo === true;
  const nestedPackages = useMemo<ApiPackage[]>(
    () => (app?.workspacePackages ?? []).filter(p => p.previewable),
    [app],
  );

  const [selectedPackageDir, setSelectedPackageDir] = useState<string | null>(null);
  const isPackageUrlScoped = !!(selectedDirectory && isMonorepo && selectedDirectory !== app?.directory);

  useEffect(() => {
    if (isPackageUrlScoped && selectedDirectory) {
      setSelectedPackageDir(selectedDirectory);
    } else if (isMonorepo && preview?.app && nestedPackages.some(p => p.directory === preview.app)) {
      setSelectedPackageDir(preview.app);
    }
  }, [isMonorepo, isPackageUrlScoped, selectedDirectory, preview?.app, nestedPackages]);

  useEffect(() => {
    if (!isPackageUrlScoped) setSelectedPackageDir(null);
  }, [app?.directory, isPackageUrlScoped]);

  // ── Unified scope: the single thing being previewed right now ──────
  // For non-monorepo apps, scope = the app directory. For monorepos,
  const activeScope: string | null = isMonorepo
    ? selectedPackageDir
    : (app?.directory ?? null);

  const activeScopeInfo = useMemo<ApiPackage | ApiApp | null>(() => {
    if (isMonorepo && selectedPackageDir) {
      return nestedPackages.find(p => p.directory === selectedPackageDir) ?? null;
    }
    return app ?? null;
  }, [isMonorepo, selectedPackageDir, nestedPackages, app]);

  const isScopePreviewable = activeScopeInfo?.previewable ?? false;
  const isScopeBackend = activeScopeInfo?.type === "backend";
  const scopeLabel = activeScopeInfo?.name?.split("/").pop() ?? activeScope?.split("/").pop() ?? null;

  // ── Backend preview state ───────────────────────────────────────────
  const backendApp = preview?.app ?? null;
  const previewPhase = preview?.phase;
  const isBackendReady = preview?.active === true;
  const isErrorPhase = previewPhase === 'error' || previewPhase === 'crashed';

  const isPreviewReady = !!activeScope && isScopePreviewable && backendApp === activeScope && isBackendReady;
  const isSwitching = !!activeScope && isScopePreviewable && !!backendApp && backendApp !== activeScope;
  const hasError = !!activeScope && backendApp === activeScope && isErrorPhase && !isScopeBackend;

  // ── Domains ────────────────────────────────────────────────────────
  const serverDomain = domain || ipAddress.replace(/\./g, "-") + ".sslip.io";
  const codeApiUrl = getCodeApiUrl(serverDomain);
  const devDomain = getDevDomain(serverDomain);
  const basePreviewUrl = getDevUrl(serverDomain);
  const srvOrigin = getIframeBaseUrl(serverDomain, isTauriApp());

  // Installing gate — dependencies still resolving, preview would fail the
  const isInstalling = preview?.phase === "installing";

  // otherwise a late response would clobber the new scope's state.
  type ManualConfigHint = {
    suggestedStart?: string;
    suggestedPort?: number;
    packageManager?: "npm" | "yarn" | "pnpm" | "bun";
  };

  interface ResourceContext {
    reason: string;
    estimatedPeakMB: number;
    estimatedSteadyMB: number;
    availableMB: number;
    totalMB: number;
    frameworkId: string | null;
    perPreviewCapMB: number;
    activePreviewCount: number;
    maxConcurrent: number;
  }

  type StartOutcome =
    | { kind: "ok" }
    | { kind: "gated"; reason: string }
    | { kind: "transient"; reason: string; status?: number }
    | { kind: "permanent"; reason: string; status?: number }
    | { kind: "manualConfig"; reason: string; failReason: "spec_missing" | "binary_not_found"; hint: ManualConfigHint }
    | { kind: "resourceBlocked"; reason: string; resourceContext: ResourceContext };

  const startPreviewDetailed = useCallback(async (dir: string, signal?: AbortSignal): Promise<StartOutcome> => {
    if (isInstalling) {
      return { kind: "gated", reason: "installing" };
    }
    try {
      const res = await fetchWithCodeToken(`${codeApiUrl}/api/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app: dir }),
        signal,
      });
      if (res.ok) {
        const data = await res.json();
        if (data.health) {
          queryClient.setQueryData(
            ["app", app?.directory ?? serverId],
            (old: Record<string, unknown> | undefined) =>
              old ? { ...old, preview: data.health } : old,
          );
        }
        // The POST response can carry a non-running preview payload —
        const previewResult = (data as { preview?: { failReason?: string; error?: string; manualConfig?: ManualConfigHint; resourceContext?: ResourceContext } }).preview;
        const failReason = previewResult?.failReason;
        if (failReason === "spec_missing" || failReason === "binary_not_found") {
          return {
            kind: "manualConfig",
            failReason,
            reason: previewResult?.error ?? failReason,
            hint: previewResult?.manualConfig ?? {},
          };
        }
        if (failReason === "backpressure" || failReason === "concurrency_limit") {
          return {
            kind: "resourceBlocked",
            reason: previewResult?.error ?? "Insufficient resources",
            resourceContext: previewResult?.resourceContext ?? {
              reason: failReason, estimatedPeakMB: 0, estimatedSteadyMB: 0,
              availableMB: 0, totalMB: 0, frameworkId: null,
              perPreviewCapMB: 0, activePreviewCount: 0, maxConcurrent: 0,
            },
          };
        }
        return { kind: "ok" };
      }
      // 5xx and 429 are transient; 4xx (except 429) is permanent.
      const body = await res.text().catch(() => "");
      const reason = body.slice(0, 200) || res.statusText || `HTTP ${res.status}`;
      if (res.status >= 500 || res.status === 429) {
        return { kind: "transient", reason, status: res.status };
      }
      return { kind: "permanent", reason, status: res.status };
    } catch (err) {
      // AbortError surfaces as transient so the orchestrator can distinguish
      const reason = (err as Error).message || "network error";
      return { kind: "transient", reason };
    }
  }, [app?.directory, codeApiUrl, fetchWithCodeToken, isInstalling, queryClient, serverId]);

  // Thin boolean adapter for the legacy callers (monorepo picker, Restart
  const startPreview = useCallback(async (dir: string): Promise<boolean> => {
    const outcome = await startPreviewDetailed(dir);
    if (outcome.kind === "ok") return true;
    if (outcome.kind === "gated") {
      toast.info(t("installingHint"));
      return false;
    }
    toast.error(t("startFailed", { reason: outcome.reason }));
    return false;
  }, [startPreviewDetailed, t]);

  // Monorepo picker click — select package + start
  const handlePreviewPackage = useCallback(async (dir: string) => {
    setSelectedPackageDir(dir);
    onPreviewStart?.(dir);
    const ok = await startPreview(dir);
    if (!ok) {
      setSelectedPackageDir(null);
      onPreviewClear?.();
    }
  }, [onPreviewStart, onPreviewClear, startPreview]);

  // Parent scope-dropdown play button → fire POST.
  const lastRequestedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!requestedPreviewApp) return;
    if (requestedPreviewApp === lastRequestedRef.current) return;
    lastRequestedRef.current = requestedPreviewApp;
    if (backendApp === requestedPreviewApp && isBackendReady) return;
    if (isMonorepo) {
      void handlePreviewPackage(requestedPreviewApp);
    } else {
      void startPreview(requestedPreviewApp);
    }
  }, [requestedPreviewApp, isMonorepo, backendApp, isBackendReady, handlePreviewPackage, startPreview]);

  // ── Auto-start orchestrator ────────────────────────────────────────
  // feedback within seconds — never a dead placeholder.
  type AutoStart =
    | { kind: "idle" }
    | { kind: "booting"; scope: string; attempt: number }
    | { kind: "retrying"; scope: string; attempt: number; reason: string }
    | { kind: "failed"; scope: string; reason: string }
    | { kind: "needsManualConfig"; scope: string; reason: string; failReason: "spec_missing" | "binary_not_found"; hint: ManualConfigHint; editMode?: boolean }
    | { kind: "resourceBlocked"; scope: string; reason: string; resourceContext: ResourceContext };

  const [autoStart, setAutoStart] = useState<AutoStart>({ kind: "idle" });
  const autoStartAbortRef = useRef<AbortController | null>(null);
  const autoStartRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoStartAttemptRef = useRef<{ scope: string; nonce: number } | null>(null);

  // Clear any pending retry timer — called from scope change + unmount.
  const cancelAutoStartRetry = useCallback(() => {
    if (autoStartRetryTimerRef.current) {
      clearTimeout(autoStartRetryTimerRef.current);
      autoStartRetryTimerRef.current = null;
    }
  }, []);

  const runAutoStart = useCallback(async (scope: string, attempt: number) => {
    // Each invocation owns an AbortController so that a later scope change
    const controller = new AbortController();
    autoStartAbortRef.current = controller;
    const nonce = (autoStartAttemptRef.current?.nonce ?? 0) + 1;
    autoStartAttemptRef.current = { scope, nonce };

    setAutoStart({ kind: "booting", scope, attempt });
    const outcome = await startPreviewDetailed(scope, controller.signal);

    // Scope changed (or was superseded) while we were awaiting — silently
    if (autoStartAttemptRef.current?.nonce !== nonce) return;
    if (controller.signal.aborted) return;

    if (outcome.kind === "ok") {
      // Server accepted; phase events drive the UI from here. Clear our
      setAutoStart({ kind: "idle" });
      return;
    }

    if (outcome.kind === "gated") {
      // to false and the orchestrator useEffect re-fires. Don't retry here.
      setAutoStart({ kind: "idle" });
      return;
    }

    if (outcome.kind === "manualConfig") {
      setAutoStart({
        kind: "needsManualConfig",
        scope,
        reason: outcome.reason,
        failReason: outcome.failReason,
        hint: outcome.hint,
      });
      return;
    }

    if (outcome.kind === "resourceBlocked") {
      setAutoStart({
        kind: "resourceBlocked",
        scope,
        reason: outcome.reason,
        resourceContext: outcome.resourceContext,
      });
      return;
    }

    if (outcome.kind === "permanent") {
      setAutoStart({ kind: "failed", scope, reason: outcome.reason });
      return;
    }

    // Transient: retry up to MAX_ATTEMPTS with exponential backoff.
    const MAX_ATTEMPTS = 3;
    const BACKOFF_MS = [1000, 3000, 9000];
    if (attempt >= MAX_ATTEMPTS) {
      setAutoStart({ kind: "failed", scope, reason: outcome.reason });
      return;
    }
    const delay = BACKOFF_MS[attempt - 1] ?? 9000;
    setAutoStart({ kind: "retrying", scope, attempt, reason: outcome.reason });
    cancelAutoStartRetry();
    autoStartRetryTimerRef.current = setTimeout(() => {
      // Re-check scope identity before firing — the user may have switched
      if (autoStartAttemptRef.current?.scope !== scope) return;
      void runAutoStart(scope, attempt + 1);
    }, delay);
  }, [startPreviewDetailed, cancelAutoStartRetry]);

  // Trigger the driver on scope entry. Idempotent: nothing fires if the
  useEffect(() => {
    if (!activeScope) {
      // No scope — tear down any in-flight attempt cleanly.
      autoStartAbortRef.current?.abort();
      cancelAutoStartRetry();
      autoStartAttemptRef.current = null;
      setAutoStart({ kind: "idle" });
      return;
    }
    if (!isScopePreviewable) return;
    if (isInstalling) return;
    if (backendApp === activeScope) {
      // Preview already matches the scope; nothing to auto-start. Reset
      setAutoStart(prev => (prev.kind === "idle" ? prev : { kind: "idle" }));
      return;
    }
    const current = autoStartAttemptRef.current;
    if (current?.scope === activeScope) return; // already working

    // Scope changed: cancel previous in-flight attempt before kicking off
    autoStartAbortRef.current?.abort();
    cancelAutoStartRetry();
    void runAutoStart(activeScope, 1);
  }, [activeScope, isScopePreviewable, isInstalling, backendApp, runAutoStart, cancelAutoStartRetry]);

  // Unmount safety — don't leak pending timers or orphan a fetch when the
  useEffect(() => {
    return () => {
      autoStartAbortRef.current?.abort();
      cancelAutoStartRetry();
    };
  }, [cancelAutoStartRetry]);

  // Manual retry handle for the failure-state UI.
  const retryAutoStart = useCallback(() => {
    if (!activeScope) return;
    cancelAutoStartRetry();
    autoStartAbortRef.current?.abort();
    void runAutoStart(activeScope, 1);
  }, [activeScope, runAutoStart, cancelAutoStartRetry]);

  // ── Preview token (Shield auth for the iframe URL) ─────────────────
  const [previewToken, setPreviewToken] = useState<string | null>(null);
  const [previewTokenError, setPreviewTokenError] = useState<string | null>(null);

  const fetchPreviewToken = useCallback(async (): Promise<string | null> => {
    setPreviewTokenError(null);

    if (vpsBridgeReady && vpsBridgeSend) {
      try {
        const result = await vpsBridgeSend<{ token: string; expiresAt: string }>("get_preview_token");
        if (result?.token) { setPreviewToken(result.token); return result.token; }
      } catch (e) {
        console.warn("[preview] Bridge token fetch failed:", e instanceof Error ? e.message : e);
      }
    }

    try {
      let platformJwt: string | undefined;
      try {
        const tokenRes = await fetch(`${API_URL}/api/servers/${serverId}/terminal/token`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        });
        if (tokenRes.ok) {
          const data = await tokenRes.json();
          platformJwt = data.terminal?.token;
        } else {
          console.warn("[preview] Platform JWT fetch failed:", tokenRes.status);
        }
      } catch (e) {
        console.warn("[preview] Platform JWT fetch error:", e instanceof Error ? e.message : e);
      }

      const headers: Record<string, string> = {};
      if (platformJwt) headers["Authorization"] = `Bearer ${platformJwt}`;

      const { fetchWithRetry } = await import("@/lib/vps-api");
      const res = await fetchWithRetry(`${srvOrigin}/_auth/preview/authorize`, {
        method: "POST",
        credentials: "include",
        headers,
      });
      if (res.ok) {
        const data = await res.json();
        setPreviewToken(data.token);
        return data.token;
      }
      const body = await res.text().catch(() => "");
      const msg = `authorize ${res.status}${body ? `: ${body.slice(0, 140)}` : ""}`;
      setPreviewTokenError(msg);
      console.warn("[preview]", msg);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPreviewTokenError(msg);
      console.warn("[preview] Preview token fetch error:", msg);
    }
    return null;
  }, [srvOrigin, serverId, vpsBridgeReady, vpsBridgeSend]);

  // ── Iframe lifecycle ───────────────────────────────────────────────
  // isIframeLoading drives only the refresh-button spinner animation.
  // It deliberately does NOT gate the overlay anymore: iframe `onLoad`
  // fires when every subresource (fonts, images, analytics) finishes,
  // which is long after the page has visually painted. The overlay used
  // `backdrop-blur` so users saw the rendered app through a blurred
  // spinner that just wouldn't clear. The overlay now shows ONLY when
  // there's no preview token yet (real "authorizing" state); once the
  // iframe is mounted, the browser's own loading paint is the source of
  // truth — no JS overlay second-guessing it.
  const [isIframeLoading, setIsIframeLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // 2026-04-20.
  const lastReadyScopeRef = useRef<string | null>(null);
  useEffect(() => {
    if (isScopeBackend) return;
    if (!isPreviewReady || !activeScope) {
      // No longer ready — clear the marker so the next ready→not→ready
      lastReadyScopeRef.current = null;
      return;
    }
    if (lastReadyScopeRef.current === activeScope) return;
    lastReadyScopeRef.current = activeScope;
    setPreviewToken(null);
    setIsIframeLoading(true);
    setRefreshKey(k => k + 1);
    void fetchPreviewToken();
  }, [isPreviewReady, isScopeBackend, activeScope, fetchPreviewToken]);

  // Shield login-page postMessage → refetch token and reload iframe
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (!isValidServerOrigin(e.origin)) return;
      if (e.data?.type === "shield-authenticated" && e.data.sessionId) {
        void fetchPreviewToken();
        setIsIframeLoading(true);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [fetchPreviewToken]);

  // ── WebSocket side effects ─────────────────────────────────────────
  const treeRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
  useRealtimeSubscribe(useCallback((message) => {
    if (message.type === "preview_install_status") {
      // Removed per 2026-04-20 feedback ("remove the toaster and just
      // make sure the preview section shows the loading state. we don't
      const data = message.data as { phase: string; app?: string };
      if (data.phase === "ready" && (!data.app || data.app === activeScope)) {
        setRefreshKey(k => k + 1);
      }
      return;
    }

    if (message.type === "preview_all_status") {
      if (isScopeBackend) {
        queryClient.invalidateQueries({ queryKey: ["openapi-spec"] });
      }
      const allHealth = message.data as { primary?: { app?: string | null } } | undefined;
      const activeApp = allHealth?.primary?.app;
      if (activeApp && activeApp !== selectedPackageDir && isMonorepo && nestedPackages.some(p => p.directory === activeApp)) {
        setSelectedPackageDir(activeApp);
      }
      return;
    }

    if (message.type === "tree") {
      if (isPreviewReady) {
        if (treeRefreshTimerRef.current) clearTimeout(treeRefreshTimerRef.current);
        treeRefreshTimerRef.current = setTimeout(() => {
          if (isScopeBackend) {
            setRefreshKey(k => k + 1);
            queryClient.invalidateQueries({ queryKey: ["openapi-spec"] });
          }
        }, 1500);
      }
      return;
    }

    if (message.type === "apps_changed") {
      queryClient.invalidateQueries({ queryKey: ["current-app"] });
    }
  }, [isPreviewReady, isScopeBackend, isMonorepo, nestedPackages, selectedPackageDir, queryClient, backendApp]));

  // ── Switching timeout ──────────────────────────────────────────────
  const [switchTimedOut, setSwitchTimedOut] = useState(false);
  useEffect(() => {
    if (isSwitching) {
      setSwitchTimedOut(false);
      const t = setTimeout(() => setSwitchTimedOut(true), 30_000);
      return () => clearTimeout(t);
    }
    setSwitchTimedOut(false);
  }, [isSwitching, activeScope]);

  const phaseLabel = previewPhase === 'installing'
    ? 'Installing dependencies...'
    : previewPhase === 'starting'
    ? 'Starting dev server...'
    : previewPhase === 'compiling'
    ? 'Building bundle...'
    : 'Switching preview...';

  // ── Viewport + iframe layout ───────────────────────────────────────
  const [viewport, setViewport] = useState<ViewportKey>("responsive");
  const [isRotated, setIsRotated] = useState(false);
  const [showViewportDropdown, setShowViewportDropdown] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; right: number } | null>(null);
  const [containerSize, setContainerSize] = useState<{ width: number; height: number } | null>(null);
  const viewportButtonRef = useRef<HTMLButtonElement>(null);
  const previewContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = previewContainerRef.current;
    if (!container) return;
    const updateSize = () => setContainerSize({ width: container.clientWidth, height: container.clientHeight });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const getScale = useCallback(() => {
    if (viewport === "responsive" || !containerSize) return 1;
    const vp = VIEWPORTS[viewport];
    const vpWidth = isRotated ? vp.height : vp.width;
    const vpHeight = isRotated ? vp.width : vp.height;
    const padding = 32;
    const scaleX = (containerSize.width - padding) / (vpWidth as number);
    const scaleY = (containerSize.height - padding) / ((vpHeight as number) + 24);
    return Math.min(scaleX, scaleY, 1);
  }, [viewport, containerSize, isRotated]);

  const buildPreviewUrl = () => {
    const params = new URLSearchParams();
    if (previewToken) params.set("_preview_token", previewToken);
    params.set("_t", backendApp || "idle");
    // _r changes on every refresh so the iframe key + src both differ from
    // the previous mount — guarantees the browser reloads instead of
    // short-circuiting on identical-src memoisation.
    if (refreshKey) params.set("_r", String(refreshKey));
    return `${basePreviewUrl}?${params.toString()}`;
  };

  const handleIframeLoad = () => setIsIframeLoading(false);

  // Refresh = reload the iframe element. Don't tear down the preview-token
  // or re-fetch from shield — the dev gateway sets a `preview_session`
  // cookie on first token use that survives reloads, so the iframe just
  // re-authenticates via cookie and you get a hot reload feel. If the
  // cookie has expired the iframe will return a 401-equivalent and the
  // shield-authenticated postMessage handler upstream will trigger a
  // proper re-fetch — same recovery path as a stale cookie elsewhere.
  const handleRefresh = () => {
    setIsIframeLoading(true);
    setRefreshKey(k => k + 1);
  };

  const handleOpenInBrowser = async () => {
    const token = await fetchPreviewToken();
    window.open(token ? `${basePreviewUrl}?_preview_token=${token}` : basePreviewUrl, "_blank");
  };

  const currentViewport = VIEWPORTS[viewport];
  const viewportWidth = viewport === "responsive" ? "100%" : isRotated ? VIEWPORTS[viewport].height : VIEWPORTS[viewport].width;
  const viewportHeight = viewport === "responsive" ? "100%" : isRotated ? VIEWPORTS[viewport].width : VIEWPORTS[viewport].height;

  const selectedPkg = nestedPackages.find(p => p.directory === selectedPackageDir) ?? null;

  // ── View selection: exactly one branch renders ─────────────────────
  type View =
    | "loading-app" | "empty" | "picker" | "not-previewable"
    | "backend-docs" | "headless" | "error" | "orphan" | "switching" | "iframe" | "waiting"
    | "manual-config" | "resource-blocked";

  const isOrphanPhase = previewPhase === 'orphan';
  const isOrphanForScope = !!activeScope && backendApp === activeScope && isOrphanPhase && !isScopeBackend;

  const view: View = (() => {
    if (isAppLoading && !app) return "loading-app";
    if (!app) return "empty";
    if (isMonorepo && !selectedPackageDir) return "picker";
    if (!activeScope) return "empty";
    // Manual-config parking state — wins over every post-app view so
    if (autoStart.kind === "needsManualConfig" && autoStart.scope === activeScope) return "manual-config";
    if (autoStart.kind === "resourceBlocked" && autoStart.scope === activeScope) return "resource-blocked";
    // waiting / switching / error flow the frontend uses — otherwise
    if (isScopeBackend && isPreviewReady && preview?.headless) return "headless";
    if (isScopeBackend && isPreviewReady) return "backend-docs";
    if (!isScopePreviewable) return "not-previewable";
    if (hasError) return "error";
    if (isOrphanForScope) return "orphan";
    if (isSwitching) return "switching";
    if (isPreviewReady) return "iframe";
    // Auto-start driver ran out of retries — surface the failure as
    if (autoStart.kind === "failed" && autoStart.scope === activeScope) return "error";
    return "waiting";
  })();

  // ── Render helpers ─────────────────────────────────────────────────
  const renderPackagePicker = () => {
    const packageCount = nestedPackages.length;
    const frontendCount = nestedPackages.filter(p => p.type === "frontend").length;
    const backendCount = packageCount - frontendCount;

    return (
      <div className="absolute inset-0 z-10 bg-card overflow-y-auto">
        <div className="min-h-full flex items-start sm:items-center justify-center px-4 py-8 sm:px-6 sm:py-10 lg:px-10 lg:py-14">
          <div className="w-full max-w-6xl">
            <div className="flex flex-col items-center text-center mb-8 sm:mb-10">
              <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mb-4">
                <Layers className="h-6 w-6 sm:h-7 sm:w-7 text-blue-400" />
              </div>
              <h2 className="text-xl sm:text-2xl font-semibold text-cream/85 tracking-tight">
                Select a package
              </h2>
              <p className="mt-2 text-sm text-cream/60 max-w-lg">
                This workspace contains multiple packages. Select one to preview.
              </p>
              {packageCount > 0 && (
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-[11px] font-medium">
                  <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-cream/[0.04] border border-cream/[0.08]/20 text-cream/75">
                    <Package className="h-3 w-3" />
                    {packageCount} {packageCount === 1 ? "package" : "packages"}
                  </span>
                  {frontendCount > 0 && (
                    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400">
                      <Monitor className="h-3 w-3" />
                      {frontendCount} frontend
                    </span>
                  )}
                  {backendCount > 0 && (
                    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-sodium/10 border border-sodium/20 text-sodium">
                      <Server className="h-3 w-3" />
                      {backendCount} backend
                    </span>
                  )}
                </div>
              )}
            </div>

            {packageCount === 0 ? (
              <div className="text-center text-sm text-cream/45 py-16 border border-dashed border-border rounded-xl bg-background/30">
                No packages detected in this project.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4">
                {nestedPackages.map(pkg => {
                  const isFrontend = pkg.type === "frontend";
                  const TypeIcon = isFrontend ? Monitor : Server;
                  const typeColor = isFrontend ? "text-blue-400" : "text-sodium";
                  const typeBg = isFrontend ? "bg-blue-500/10 border-blue-500/20" : "bg-sodium/10 border-sodium/20";
                  const shortName = pkg.name?.split("/").pop() || pkg.directory.split("/").pop() || pkg.directory;
                  const isPrimary = preview?.app === pkg.directory && preview?.active === true;

                  return (
                    <div
                      key={pkg.directory}
                      className={cn(
                        "group relative bg-background/40 border rounded-xl p-4 sm:p-5 transition-all text-left flex flex-col",
                        isPrimary
                          ? "border-blue-500/50 shadow-[0_0_0_1px_rgba(59,130,246,0.15)]"
                          : "border-border hover:border-cream/[0.08] hover:bg-background/60"
                      )}
                    >
                      <div className="flex items-start gap-3 mb-4">
                        <div className={cn("w-10 h-10 rounded-lg flex items-center justify-center shrink-0 border", typeBg)}>
                          <TypeIcon className={cn("h-5 w-5", typeColor)} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-sm sm:text-base font-semibold text-cream/85 truncate">{shortName}</h3>
                            {isPrimary && (
                              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/30">
                                Primary
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-cream/45 mt-1 truncate">
                            {getFrameworkLabel(pkg.framework)} · {isFrontend ? t("frontendLabel") : t("backendLabel")}
                          </div>
                          <div className="text-[11px] text-cream/35 mt-1 truncate font-mono">
                            {pkg.directory}
                          </div>
                        </div>
                      </div>

                      <div className="flex gap-2 mt-auto">
                        <Button
                          size="sm"
                          variant={isPrimary ? "outline" : "default"}
                          className={cn(
                            "flex-1 h-9 text-xs font-medium gap-1.5",
                            isPrimary && "text-blue-400 border-blue-500/30",
                          )}
                          disabled={isInstalling && !isPrimary}
                          title={isInstalling && !isPrimary ? t("installingHint") : undefined}
                          onClick={() => handlePreviewPackage(pkg.directory)}
                        >
                          <Play className="h-3.5 w-3.5" />
                          {isInstalling && !isPrimary ? t("installingShort") : isPrimary ? t("viewPreview") : t("previewLabel")}
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderIframe = () => (
    <div
      className={cn(
        viewport === "responsive"
          ? "absolute inset-0 w-full h-full"
          : "relative rounded-lg overflow-hidden shadow-2xl border border-border bg-cream flex-shrink-0 origin-center"
      )}
      style={viewport !== "responsive" ? {
        width: typeof viewportWidth === "number" ? `${viewportWidth}px` : viewportWidth,
        height: typeof viewportHeight === "number" ? `${(viewportHeight as number) + 24}px` : viewportHeight,
        transform: `scale(${getScale()})`,
      } : undefined}
    >
      {viewport !== "responsive" && (
        <div className="absolute top-0 left-0 right-0 h-6 bg-card border-b border-border flex items-center justify-center z-10">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-cream/45 font-medium">
              {currentViewport.label} · {viewportWidth} × {viewportHeight}
            </span>
          </div>
        </div>
      )}
      <iframe
        // Key on activeScope (UI intent, stable during a single session on
        key={`preview-${activeScope}-${refreshKey}`}
        src={buildPreviewUrl()}
        className="bg-cream"
        style={{
          position: "absolute",
          border: "none",
          top: viewport !== "responsive" ? "24px" : 0,
          left: 0,
          width: "100%",
          height: viewport !== "responsive" ? "calc(100% - 24px)" : "100%",
        }}
        title={`Preview: ${backendApp}`}
        allow="publickey-credentials-get *; publickey-credentials-create *"
        onLoad={handleIframeLoad}
      />
    </div>
  );

  // Backend API docs pass — translate ApiPackage → ApiApp-shape when needed.
  const renderBackendDocs = () => {
    if (!activeScopeInfo) return null;
    const appForDocs: ApiApp = isMonorepo && selectedPkg
      ? {
          directory: selectedPkg.directory,
          sandboxId: selectedPkg.sandboxId,
          subdir: selectedPkg.directory.split("/").slice(1).join("/"),
          name: selectedPkg.name,
          displayName: selectedPkg.displayName,
          path: selectedPkg.path,
          framework: selectedPkg.framework,
          type: "backend",
          previewable: selectedPkg.previewable,
          port: selectedPkg.port,
          scripts: selectedPkg.scripts,
          dependencies: selectedPkg.dependencies,
          hasPackageJson: selectedPkg.hasPackageJson,
          isMonorepo: false,
          workspacePackages: [],
          projectId: selectedPkg.projectId,
        }
      : app!;
    return (
      <div className={cn("absolute inset-0 z-10 flex flex-col bg-card", !toolbarHost && "pt-11")}>
        <ApiDocsPreview
          app={appForDocs}
          devDomain={devDomain}
          serverDomain={serverDomain}
          isPreviewActive={isPreviewReady}
        />
      </div>
    );
  };

  // ── Render ─────────────────────────────────────────────────────────
  // Toolbar content is built once and then either rendered as a floating
  const toolbarLeftCluster = (
    <>
      {isMonorepo && selectedPackageDir && (
        <button
          onClick={() => { setSelectedPackageDir(null); onPreviewClear?.(); }}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg backdrop-blur-md bg-card/70 border border-cream/[0.06] hover:bg-card/90 hover:border-cream/[0.08] transition-colors text-xs text-cream/75"
        >
          <Layers className="h-3.5 w-3.5 text-blue-400" />
          <span className="font-medium max-w-[100px] truncate">
            {selectedPkg?.name?.split("/").pop() || selectedPackageDir?.split("/").pop()}
          </span>
        </button>
      )}
      {hasError && (
        <span className="flex items-center gap-1 text-[10px] text-terra h-8 px-2.5 rounded-lg backdrop-blur-md bg-card/70 border border-terra/20">
          <XCircle className="h-3 w-3" />
          {previewPhase === 'crashed' ? 'Crashed' : 'Build Error'}
        </span>
      )}
      {switchTimedOut && !hasError && (
        <span className="flex items-center gap-1 text-[10px] text-sodium h-8 px-2.5 rounded-lg backdrop-blur-md bg-card/70 border border-sodium/20">
          <AlertTriangle className="h-3 w-3" />
          Slow start
        </span>
      )}
    </>
  );

  const canEditConfig = !!activeScope && (isPreviewReady || hasError || isOrphanForScope);

  const toolbarRightCluster = (
    <>
      {canEditConfig && (
        <button
          className="h-8 w-8 flex items-center justify-center rounded-lg backdrop-blur-md bg-card/70 border border-cream/[0.06] text-cream/60 hover:text-cream hover:bg-card/90 transition-colors"
          onClick={() => {
            setAutoStart({
              kind: "needsManualConfig",
              scope: activeScope!,
              reason: "",
              failReason: "spec_missing",
              hint: {},
              editMode: true,
            });
          }}
          title={t("editConfig")}
        >
          <Wrench className="h-3.5 w-3.5" />
        </button>
      )}
      <div className="relative">
        <button
          ref={viewportButtonRef}
          onClick={() => {
            if (viewportButtonRef.current) {
              const rect = viewportButtonRef.current.getBoundingClientRect();
              setDropdownPosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right });
            }
            setShowViewportDropdown(!showViewportDropdown);
          }}
          className="flex items-center gap-2 h-8 px-2.5 rounded-lg backdrop-blur-md bg-card/70 border border-cream/[0.06] hover:bg-card/90 transition-colors"
        >
          <currentViewport.icon className="h-3.5 w-3.5 text-blue-400" />
          <span className="text-xs text-cream font-medium hidden xl:inline">{currentViewport.label}</span>
          <ChevronDown className={cn(
            "h-3 w-3 text-cream/60 transition-transform hidden xl:block",
            showViewportDropdown && "rotate-180"
          )} />
        </button>
      </div>
      {viewport !== "responsive" && (
        <button
          className={cn(
            "h-8 w-8 flex items-center justify-center rounded-lg backdrop-blur-md bg-card/70 border border-cream/[0.06] hover:bg-card/90 transition-colors",
            isRotated ? "text-blue-400" : "text-cream/60 hover:text-cream"
          )}
          onClick={() => setIsRotated(!isRotated)}
          title={t("rotateDevice")}
        >
          <RotateCcw className="h-3.5 w-3.5" />
        </button>
      )}
      <button
        className="h-8 w-8 flex items-center justify-center rounded-lg backdrop-blur-md bg-card/70 border border-cream/[0.06] text-cream/60 hover:text-cream hover:bg-card/90 transition-colors disabled:opacity-40"
        onClick={handleRefresh}
        disabled={!isPreviewReady}
        title={t("refreshPreview")}
      >
        <RefreshCw className={cn("h-3.5 w-3.5", isIframeLoading && "animate-spin")} />
      </button>
      <button
        className="h-8 w-8 flex items-center justify-center rounded-lg backdrop-blur-md bg-card/70 border border-cream/[0.06] text-cream/60 hover:text-cream hover:bg-card/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-cream/60 disabled:hover:bg-card/70"
        onClick={handleOpenInBrowser}
        disabled={!isPreviewReady}
        title={isPreviewReady ? "Open in browser" : "Preview is still starting — wait until it's ready."}
      >
        <ExternalLink className="h-3.5 w-3.5" />
      </button>
    </>
  );

  const floatingToolbar = (
    <div className="absolute top-3 left-3 right-3 z-30 flex items-start justify-between pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-2">{toolbarLeftCluster}</div>
      <div className="pointer-events-auto flex items-center gap-1.5 ml-auto">{toolbarRightCluster}</div>
    </div>
  );

  const hostedToolbar = (
    <div className="flex items-center justify-between gap-2 w-full">
      <div className="flex items-center gap-2 min-w-0">{toolbarLeftCluster}</div>
      <div className="flex items-center gap-1.5 shrink-0">{toolbarRightCluster}</div>
    </div>
  );

  return (
    <div className="flex-1 flex flex-col min-h-0 relative panel-ascente">
      {toolbarHost ? createPortal(hostedToolbar, toolbarHost) : floatingToolbar}

      {/* Content — exactly one view branch renders */}
      <div
        ref={previewContainerRef}
        className={cn(
          "flex-1 relative min-h-0 overflow-hidden",
          viewport !== "responsive" && "bg-ink flex items-center justify-center p-4"
        )}
      >
        {view === "loading-app" && (
          <div className="absolute inset-0 flex items-center justify-center bg-card">
            <Spinner size="sm" label={t("loadingApp")} color="primary" />
          </div>
        )}

        {view === "empty" && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-card">
            <div className="text-center max-w-sm p-4">
              <div className="w-16 h-16 rounded-2xl bg-sodium/10 border border-sodium/20 flex items-center justify-center mx-auto mb-4">
                <Package className="h-8 w-8 text-sodium" />
              </div>
              <h3 className="text-sm font-medium text-cream/75 mb-2">{t("emptySandbox")}</h3>
              <p className="text-xs text-cream/60 leading-relaxed">
                Ask the assistant in the chat to scaffold a project, then come back here to see it live.
              </p>
            </div>
          </div>
        )}

        {view === "picker" && renderPackagePicker()}

        {view === "not-previewable" && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-card">
            <div className="text-center max-w-sm p-4">
              <div className="w-16 h-16 rounded-2xl bg-cream/[0.04] border border-cream/[0.08]/20 flex items-center justify-center mx-auto mb-4">
                <Package className="h-8 w-8 text-cream/60" />
              </div>
              <h3 className="text-sm font-medium text-cream/75 mb-2">{t("previewNotAvailable")}</h3>
              <p className="text-xs text-cream/60 leading-relaxed mb-4">
                This {activeScopeInfo?.type || "app"} doesn&apos;t have a preview. It may be a library or missing a dev script.
              </p>
              {activeScope && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    // User override: force the manual-config panel for
                    setAutoStart({
                      kind: "needsManualConfig",
                      scope: activeScope,
                      reason: "User-initiated manual start command",
                      failReason: "spec_missing",
                      hint: {},
                    });
                  }}
                >
                  <Terminal className="h-3.5 w-3.5 mr-1.5" />
                  Set a start command
                </Button>
              )}
            </div>
          </div>
        )}

        {view === "manual-config" && autoStart.kind === "needsManualConfig" && (
          <ManualConfigPanel
            scope={autoStart.scope}
            reason={autoStart.reason}
            failReason={autoStart.failReason}
            hint={autoStart.hint}
            codeApiUrl={codeApiUrl}
            fetchWithCodeToken={fetchWithCodeToken}
            onDismiss={() => setAutoStart({ kind: "idle" })}
            editMode={autoStart.editMode}
            onSubmitted={(outcome) => {
              if (outcome.health) {
                queryClient.setQueryData(
                  ["app", app?.directory ?? serverId],
                  (old: Record<string, unknown> | undefined) =>
                    old ? { ...old, preview: outcome.health } : old,
                );
              }
              const fr = outcome.preview?.failReason;
              if (fr === "spec_missing" || fr === "binary_not_found") {
                setAutoStart({
                  kind: "needsManualConfig",
                  scope: autoStart.scope,
                  reason: outcome.preview?.error ?? fr,
                  failReason: fr,
                  hint: outcome.preview?.manualConfig ?? {},
                });
                return;
              }
              setAutoStart({ kind: "idle" });
              if (autoStart.editMode && activeScope) {
                void startPreview(activeScope);
              }
            }}
          />
        )}

        {view === "resource-blocked" && autoStart.kind === "resourceBlocked" && (
          <ResourceGatePanel
            resourceContext={autoStart.resourceContext}
            onRetry={retryAutoStart}
            onUpgrade={onUpgrade}
          />
        )}

        {view === "backend-docs" && renderBackendDocs()}

        {view === "headless" && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-card">
            <div className="text-center max-w-sm p-4">
              <div className="w-16 h-16 rounded-2xl bg-sodium/10 border border-sodium/20 flex items-center justify-center mx-auto mb-4">
                <Terminal className="h-8 w-8 text-sodium" />
              </div>
              <h3 className="text-sm font-medium text-cream/75 mb-2">{t("serverRunning")}</h3>
              <p className="text-xs text-cream/60 leading-relaxed">
                Your {activeScopeInfo?.framework || "backend"} server is running on port {preview?.port ?? 4000}. Use the terminal to interact with it.
              </p>
            </div>
          </div>
        )}

        {view === "error" && (() => {
          const isAutoStartFailure =
            autoStart.kind === "failed" && autoStart.scope === activeScope;
          const isInstallFailure = previewPhase === 'crashed' && preview?.failReason === 'install_failed';
          const isOomCrash = previewPhase === 'crashed' && !isInstallFailure && (
            preview?.error?.toLowerCase().includes('oom') ||
            preview?.error?.includes('Killed') ||
            preview?.error?.includes('signal 9') ||
            preview?.logTail?.includes('oom_reaper') ||
            preview?.logTail?.includes('oom-kill') ||
            preview?.logTail?.includes('cgroup') ||
            preview?.logTail?.includes('ENOMEM') ||
            (preview as unknown as Record<string, unknown>)?.resourceContext != null
          );
          if (isOomCrash) {
            const rc = (preview as unknown as Record<string, unknown>)?.resourceContext as ResourceContext | undefined;
            return (
              <ResourceGatePanel
                resourceContext={rc ?? {
                  reason: 'oom_crash', estimatedPeakMB: 0, estimatedSteadyMB: 0,
                  availableMB: 0, totalMB: 0, frameworkId: activeScopeInfo?.framework ?? null,
                  perPreviewCapMB: 0, activePreviewCount: 0, maxConcurrent: 0,
                }}
                onRetry={() => queryClient.invalidateQueries({ queryKey: ["current-app"] })}
                onUpgrade={onUpgrade}
              />
            );
          }
          const headline = isAutoStartFailure
            ? "Couldn't start preview"
            : isInstallFailure ? "Dependency install failed"
            : previewPhase === 'crashed' ? 'Dev Server Crashed' : 'Build Error';
          const detail = isAutoStartFailure
            ? autoStart.reason
            : preview?.error || 'The dev server failed to start.';
          const iconTone = isAutoStartFailure || previewPhase === 'crashed'
            ? "bg-terra/10 border border-terra/20"
            : "bg-sodium/10 border border-sodium/20";
          const IconCmp = isAutoStartFailure || previewPhase === 'crashed'
            ? XCircle
            : AlertTriangle;
          const iconColor = isAutoStartFailure || previewPhase === 'crashed'
            ? "text-terra"
            : "text-sodium";
          const onRetry = isAutoStartFailure
            ? retryAutoStart
            : () => queryClient.invalidateQueries({ queryKey: ["current-app"] });
          const canAskAgent = !!onFixRequest && !!activeScope && previewPhase === 'crashed' &&
            !!(preview?.failReason) && !!(preview?.error);
          return (
          <div className="absolute inset-0 z-10 flex flex-col bg-card">
            <div className="flex-1 flex items-center justify-center p-6">
              <div className="max-w-lg w-full space-y-4">
                <div className="flex items-start gap-3">
                  <div className={cn(
                    "w-10 h-10 rounded-xl flex items-center justify-center shrink-0",
                    iconTone,
                  )}>
                    <IconCmp className={cn("h-5 w-5", iconColor)} />
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-sm font-medium text-cream/85">{headline}</h3>
                    <p className="text-xs text-cream/60 mt-0.5 break-all">{detail}</p>
                  </div>
                </div>

                {preview?.healStatus === 'healing' && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
                    <Wrench className="h-4 w-4 text-blue-400 animate-pulse" />
                    <span className="text-xs text-blue-300">
                      Auto-fixing... (attempt {preview.healAttempts}/{3})
                    </span>
                    <Spinner size="xs" color="primary" className="ml-auto" />
                  </div>
                )}
                {preview?.healStatus === 'exhausted' && (
                  <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-terra/10 border border-terra/20">
                    <XCircle className="h-4 w-4 text-terra" />
                    <span className="text-xs text-terra">
                      Auto-fix failed after {preview.healAttempts} attempts
                    </span>
                  </div>
                )}
                {preview?.logTail && (
                  <details className="group" open={isInstallFailure}>
                    <summary className="text-xs text-cream/45 cursor-pointer hover:text-cream/60 transition-colors">
                      {isInstallFailure ? "Install log" : "Build logs"}
                    </summary>
                    <pre className="mt-2 p-3 rounded-lg bg-black/40 border border-border text-[11px] text-cream/60 font-mono overflow-auto max-h-48 whitespace-pre-wrap break-all">
                      {preview.logTail}
                    </pre>
                  </details>
                )}
                {preview?.recoveryHint && (
                  <p className="text-[11px] text-cream/55 leading-relaxed">
                    {preview.recoveryHint}
                  </p>
                )}
                <div className="flex flex-col gap-2">
                  {canAskAgent && (
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => {
                        onFixRequest?.({
                          scope: activeScope!,
                          error: preview!.error || headline,
                          logTail: preview!.logTail || undefined,
                          kind: preview!.failReason as "install_failed" | "unit_failed",
                        });
                      }}
                      className="w-full text-xs"
                    >
                      <Sparkles className="h-3 w-3 mr-1.5" />
                      Ask agent to fix
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onRetry}
                    className="w-full text-xs"
                  >
                    <RefreshCw className="h-3 w-3 mr-1.5" />
                    Retry Preview
                  </Button>
                  {activeScope && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setAutoStart({
                          kind: "needsManualConfig",
                          scope: activeScope,
                          reason: "",
                          failReason: "spec_missing",
                          hint: {},
                          editMode: true,
                        });
                      }}
                      className="w-full text-xs"
                    >
                      <Wrench className="h-3 w-3 mr-1.5" />
                      {t("editConfig")}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </div>
          );
        })()}

        {view === "switching" && (
          <div className="absolute inset-0 flex items-center justify-center z-10 bg-card">
            <div className="text-center">
              <Spinner size="sm" label={phaseLabel} color="primary" />
              <p className="text-[11px] text-muted-foreground/40 mt-1">{scopeLabel}</p>
            </div>
          </div>
        )}

        {view === "orphan" && (
          <div className="absolute inset-0 flex items-center justify-center bg-card">
            <div className="text-center max-w-md p-4">
              <div className="w-16 h-16 rounded-2xl bg-sodium/10 border border-sodium/20 flex items-center justify-center mx-auto mb-4">
                <AlertTriangle className="h-8 w-8 text-sodium" />
              </div>
              <h3 className="text-sm font-medium text-cream/85 mb-2">{t("previewOutOfSync")}</h3>
              <p className="text-xs text-cream/60 leading-relaxed mb-4">
                {preview?.recoveryHint ||
                  t("portHeldMessage")}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => activeScope && startPreview(activeScope)}
                className="text-xs"
              >
                <RefreshCw className="h-3 w-3 mr-1.5" />
                {t("restartPreview")}
              </Button>
              {preview?.orphanReason && (
                <p className="text-[10px] text-cream/45 mt-3 font-mono">
                  reason: {preview.orphanReason}
                </p>
              )}
            </div>
          </div>
        )}

        {view === "waiting" && (() => {
          const phase = preview?.phase;
          const autoStartActive =
            (autoStart.kind === "booting" || autoStart.kind === "retrying") &&
            autoStart.scope === activeScope;
          const isBooting = autoStartActive ||
            phase === "installing" || phase === "starting" || phase === "compiling";
          // Framework-aware compile copy: Next.js on Webpack, Rails, Spring Boot
          const frameworkLabel = activeScopeInfo?.framework
            ? getFrameworkLabel(activeScopeInfo.framework)
            : null;
          const { title, detail } = (() => {
            // reflect that over stale file-api phase data so users never see
            if (autoStart.kind === "retrying" && autoStart.scope === activeScope) {
              return {
                title: "Retrying",
                detail: `Temporary failure (${autoStart.reason}). Retrying automatically (attempt ${autoStart.attempt + 1}/3).`,
              };
            }
            if (autoStart.kind === "booting" && autoStart.scope === activeScope && !phase) {
              return {
                title: "Requesting dev server",
                detail: "Asking the sandbox to boot your app.",
              };
            }
            if (phase === "installing") {
              return {
                title: "Installing dependencies",
                detail: "Fetching packages. This usually takes 10 to 30 seconds.",
              };
            }
            if (phase === "starting") {
              return {
                title: "Starting dev server",
                detail: "Spinning up the runtime. Your app will appear in a moment.",
              };
            }
            if (phase === "compiling") {
              return {
                title: frameworkLabel
                  ? `Building your ${frameworkLabel} bundle`
                  : "Building your app",
                detail:
                  "First compile runs on the first request. This page updates the moment the build finishes. No refresh needed.",
              };
            }
            return {
              title: "Live Preview",
              detail: "Your sandbox preview will appear here once the dev server is running.",
            };
          })();
          return (
            <div className="absolute inset-0 flex items-center justify-center bg-card">
              <div className="text-center max-w-sm p-4">
                <div className="w-16 h-16 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mx-auto mb-4">
                  {isBooting ? <Spinner size="sm" color="primary" /> : <Monitor className="h-8 w-8 text-blue-400" />}
                </div>
                <h3 className="text-sm font-medium text-cream/75 mb-2">{title}</h3>
                <p className="text-xs text-cream/60 leading-relaxed">{detail}</p>
              </div>
            </div>
          );
        })()}

        {view === "iframe" && (
          <>
            {previewToken && renderIframe()}
            {/* Overlay only while there's NO preview token yet (real
                "authorizing" state) or the token fetch errored. Once the
                iframe is mounted, the browser's own paint is the source of
                truth — gating on iframe.onLoad held the overlay until every
                subresource downloaded, long after the page was visible. */}
            {(!previewToken || previewTokenError) && (
              <div className="absolute inset-0 flex items-center justify-center z-10 bg-card/80 backdrop-blur-sm">
                {previewTokenError ? (
                  <div className="text-center max-w-sm p-4">
                    <div className="w-10 h-10 rounded-xl bg-terra/10 border border-terra/20 flex items-center justify-center mx-auto mb-3">
                      <XCircle className="h-5 w-5 text-terra" />
                    </div>
                    <h3 className="text-sm font-medium text-cream/85 mb-1">{t("previewAuthFailed")}</h3>
                    <p className="text-xs text-cream/60 mb-3 break-all">{previewTokenError}</p>
                    <Button variant="outline" size="sm" onClick={handleRefresh}>
                      <RefreshCw className="h-3 w-3 mr-1.5" /> Retry
                    </Button>
                  </div>
                ) : (
                  <Spinner size="sm" label={t("authorizing")} color="primary" />
                )}
              </div>
            )}
          </>
        )}
      </div>

      {isMonorepo && selectedPackageDir && isPreviewReady && (
        <CompanionPanel
          packages={nestedPackages}
          primaryDir={selectedPackageDir}
          companions={companions}
          codeApiUrl={codeApiUrl}
          fetchWithCodeToken={fetchWithCodeToken}
        />
      )}

      {/* Viewport dropdown portal */}
      {showViewportDropdown && dropdownPosition && createPortal(
        <>
          <div
            className="fixed inset-0 z-[60] animate-in fade-in-0 duration-150"
            onClick={() => setShowViewportDropdown(false)}
          />
          <div
            className="fixed z-[70] w-44 bg-card border border-border rounded-lg shadow-2xl py-1 animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-150"
            style={{ top: dropdownPosition.top, right: dropdownPosition.right }}
          >
            {(Object.keys(VIEWPORTS) as ViewportKey[]).map((key) => {
              const vp = VIEWPORTS[key];
              const Icon = vp.icon;
              const isActive = viewport === key;
              const dimensions = key === "responsive" ? "Full size" : `${vp.width} × ${vp.height}`;
              return (
                <button
                  key={key}
                  onClick={() => {
                    setViewport(key);
                    setIsRotated(false);
                    setShowViewportDropdown(false);
                  }}
                  className={cn(
                    "w-full flex items-center gap-3 px-3 py-2 text-left transition-colors",
                    isActive ? "bg-blue-500/10 text-blue-400" : "text-cream/75 hover:bg-secondary"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{vp.label}</div>
                    <div className="text-[10px] text-cream/45">{dimensions}</div>
                  </div>
                  {isActive && <div className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0" />}
                </button>
              );
            })}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}
