// SPDX-License-Identifier: MIT
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  ScrollText,
  Shield,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,

  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useVpsBridge } from "@/lib/vps-bridge";
import { getVpsApiUrl } from "@/lib/domains";

interface AuditLogViewerProps {
  serverDomain: string;
  tier?: "standard" | "web_locked" | "private_locked";
}

interface AuditLogEntry {
  timestamp: number;
  event: string;
  ip: string | null;
  details: string | null;
}

interface VerifyResult {
  valid: boolean;
  totalEntries: number;
  verifiedCount: number;
  brokenAt: number | null;
  brokenReason: string | null;
  lastVerified: number;
  message?: string;
  warning?: string;
}

const EVENT_COLORS: Record<string, string> = {
  auth_success: "text-sodium",
  auth_failure: "text-terra",
  session_created: "text-blue-400",
  session_rotated: "text-cream/60",
  session_destroyed: "text-sodium",
  secret_set: "text-sodium",
  secret_deleted: "text-terra",
  secrets_bulk_set: "text-sodium",
  secret_classified: "text-blue-400",
  exposure_acknowledged: "text-sodium",
  gate_granted: "text-sodium",
  gate_denied: "text-terra",
  gate_revoked: "text-sodium",
  git_push: "text-cream/65",
  deploy: "text-cyan-400",
  tier_switched: "text-cream/65",
  terminal_toggled: "text-cream/60",
  ssh_toggled: "text-cream/60",
  luks_init: "text-sodium",
  luks_unlock: "text-blue-400",
  audit_log_verified: "text-sodium",
  cross_project_access_granted: "text-blue-400",
  cross_project_access_revoked: "text-sodium",
  exchange_code_created: "text-cream/60",
  preview_token_issued: "text-cream/60",
  pop_sw_confirmed: "text-sodium",
  useragent_anomaly: "text-terra",
  ip_mismatch_logged: "text-terra",
  fingerprint_anomaly: "text-terra",
  sts_token_issued: "text-cream/60",
  permission_expired: "text-cream/60",
  pop_validation_failed: "text-terra",
};

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function AuditLogViewer({ serverDomain, tier }: AuditLogViewerProps) {
  if (tier !== "standard") {
    return <AuditLogBridge serverDomain={serverDomain} />;
  }
  return <AuditLogDirect serverDomain={serverDomain} />;
}

// ── Bridge-based (web_locked tier) ──

function AuditLogBridge({ serverDomain }: { serverDomain: string }) {
  const { send } = useVpsBridge();

  const logsQuery = useQuery<{ logs: AuditLogEntry[] }>({
    queryKey: ["audit-log", serverDomain],
    queryFn: () => send<{ logs: AuditLogEntry[] }>("audit_log"),
    staleTime: 30_000,
  });

  const verifyMutation = useMutation<VerifyResult>({
    mutationFn: () => send<VerifyResult>("audit_verify"),
  });

  return (
    <AuditLogUI
      logs={logsQuery.data?.logs ?? []}
      isLoading={logsQuery.isLoading}
      isFetching={logsQuery.isFetching}
      refetch={logsQuery.refetch}
      verifyMutation={verifyMutation}
    />
  );
}

// ── Direct fetch (standard tier) ──

function AuditLogDirect({ serverDomain }: { serverDomain: string }) {
  const vpsUrl = getVpsApiUrl(serverDomain);

  const logsQuery = useQuery<{ logs: AuditLogEntry[] }>({
    queryKey: ["audit-log", serverDomain],
    queryFn: async () => {
      const res = await fetch(`${vpsUrl}/_auth/audit`, { credentials: "include" });
      if (!res.ok) return { logs: [] };
      return res.json();
    },
    staleTime: 30_000,
  });

  const verifyMutation = useMutation<VerifyResult>({
    mutationFn: async () => {
      const res = await fetch(`${vpsUrl}/_auth/audit/verify`, { credentials: "include" });
      if (!res.ok) throw new Error("Verification failed");
      return res.json();
    },
  });


  return (
    <AuditLogUI
      logs={logsQuery.data?.logs ?? []}
      isLoading={logsQuery.isLoading}
      isFetching={logsQuery.isFetching}
      refetch={logsQuery.refetch}
      verifyMutation={verifyMutation}
    />
  );
}

// ── Shared UI ──

interface AuditLogUIProps {
  logs: AuditLogEntry[];
  isLoading: boolean;
  isFetching: boolean;
  refetch: () => void;
  verifyMutation: { mutate: () => void; isPending: boolean; data?: VerifyResult };
}

function AuditLogUI({ logs, isLoading, isFetching, refetch, verifyMutation }: AuditLogUIProps) {
  const t = useTranslations("console.auditLog");
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ScrollText className="h-4 w-4 text-sodium" />
          <span className="text-sm font-medium text-cream">{t("title")}</span>
          <Badge variant="outline" className="text-[10px]">
            {t("entries", { count: logs.length })}
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs border-border"
            onClick={() => verifyMutation.mutate()}
            disabled={verifyMutation.isPending}
          >
            {verifyMutation.isPending ? (
              <Spinner size="xs" className="mr-1" />
            ) : (
              <Shield className="h-3 w-3 mr-1" />
            )}
            {t("verifyIntegrity")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>

      {/* Verification result */}
      {verifyMutation.data && (
        <div
          className={`flex items-center gap-2 p-3 rounded-lg border ${
            verifyMutation.data.valid
              ? "bg-sodium/5 border-sodium/20"
              : "bg-terra/5 border-terra/20"
          }`}
        >
          {verifyMutation.data.valid ? (
            <>
              <ShieldCheck className="h-4 w-4 text-sodium shrink-0" />
              <div>
                <p className="text-xs font-medium text-sodium">{t("chainVerified")}</p>
                <p className="text-[10px] text-cream/60">
                  {t("chainVerifiedDesc", { count: verifyMutation.data.verifiedCount })}
                </p>
              </div>
            </>
          ) : (
            <>
              <ShieldAlert className="h-4 w-4 text-terra shrink-0" />
              <div>
                <p className="text-xs font-medium text-terra">{t("integrityCompromised")}</p>
                <p className="text-[10px] text-terra/70">
                  {verifyMutation.data.warning || t("chainBroken", { at: verifyMutation.data.brokenAt ?? "?", reason: verifyMutation.data.brokenReason ?? "" })}
                </p>
              </div>
            </>
          )}
        </div>
      )}

      {/* Log list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Spinner size="default" color="muted" delay={300} />
        </div>
      ) : logs.length === 0 ? (
        <div className="text-center py-8 border border-dashed border-border rounded-lg">
          <ScrollText className="h-8 w-8 mx-auto mb-2 text-cream/45" />
          <p className="text-sm text-cream/60">{t("noEvents")}</p>
        </div>
      ) : (
        <div className="space-y-1 max-h-[400px] overflow-y-auto pr-1">
          {logs.map((log, idx) => {
            const eventColor = EVENT_COLORS[log.event] ?? "text-cream/60";
            const eventKey = `events.${log.event}` as `events.auth_success`;
            const eventLabel = t.has(eventKey)
              ? t(eventKey)
              : log.event.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
            const isExpanded = expanded === idx;
            let parsedDetails: Record<string, unknown> | null = null;
            if (log.details) {
              try {
                parsedDetails = JSON.parse(log.details);
              } catch {
                parsedDetails = { raw: log.details };
              }
            }

            return (
              <button
                key={idx}
                type="button"
                onClick={() => setExpanded(isExpanded ? null : idx)}
                className="w-full text-left rounded-lg border border-cream/[0.06] bg-cream/[0.02] px-3 py-2 hover:bg-cream/[0.04] transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-medium ${eventColor}`}>
                      {eventLabel}
                    </span>
                    {log.ip && (
                      <span className="text-[10px] text-cream/45 font-mono">{log.ip}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-cream/45 tabular-nums">
                      {formatTimestamp(log.timestamp)}
                    </span>
                    {parsedDetails && (
                      isExpanded ? (
                        <ChevronUp className="h-3 w-3 text-cream/45" />
                      ) : (
                        <ChevronDown className="h-3 w-3 text-cream/45" />
                      )
                    )}
                  </div>
                </div>
                {isExpanded && parsedDetails && (
                  <pre className="mt-2 text-[10px] text-cream/60 font-mono whitespace-pre-wrap break-all bg-black/20 rounded p-2">
                    {JSON.stringify(parsedDetails, null, 2)}
                  </pre>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
