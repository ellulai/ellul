// SPDX-License-Identifier: MIT
"use client";

import { useState, useMemo } from "react";
import { useTranslations } from "next-intl";
import {
  Check,
  X,
  AlertTriangle,
  ChevronDown,
  Activity,
  Clock,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DiscoveredTool {
  id: string;
  toolName: string;
  description?: string;
  systemCapability?: string;
  confidence: "high" | "medium" | "low";
  classificationReason?: string;
  approvalStatus: "approved" | "quarantined" | "rejected" | "discovered";
  callCount: number;
  lastUsedAt?: string;
}

interface ToolReviewProps {
  connectionId: string;
  serverId: string;
  tools: DiscoveredTool[];
  onApprove: (toolId: string, overrideCapability?: string) => void;
  onReject: (toolId: string) => void;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CAPABILITY_KEYS = [
  "database:read",
  "database:write",
  "database:schema",
  "execution:shell",
  "network:egress",
  "deployment:trigger",
  "secrets:read",
  "secrets:write",
  "git:read",
  "git:write",
  "filesystem:read",
  "filesystem:write",
  "external:read",
  "external:write",
  "external:admin",
] as const;

const CONFIDENCE_VISUAL: Record<
  DiscoveredTool["confidence"],
  { color: string; bgColor: string }
> = {
  high: { color: "text-sodium", bgColor: "bg-sodium/10" },
  medium: { color: "text-sodium", bgColor: "bg-sodium/10" },
  low: { color: "text-terra", bgColor: "bg-terra/10" },
};

// ─── Hooks ──────────────────────────────────────────────────────────────────

function useCapabilityLabels(): Record<string, string> {
  const t = useTranslations("console.integrations.toolReview.capabilities");
  type Key = Parameters<typeof t>[0];
  return useMemo(() => {
    const out: Record<string, string> = {};
    for (const k of CAPABILITY_KEYS) {
      out[k] = t(k.replace(/:/g, "_") as Key);
    }
    return out;
  }, [t]);
}

function useConfidenceLabels(): Record<DiscoveredTool["confidence"], string> {
  const t = useTranslations("console.integrations.toolReview.confidence");
  return {
    high: t("high"),
    medium: t("medium"),
    low: t("low"),
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getCapabilityLabel(
  labels: Record<string, string>,
  fallbackUnclassified: string,
  capability: string | undefined,
): string {
  if (!capability) return fallbackUnclassified;
  return labels[capability] ?? capability;
}

function useFormatCallCount(): (count: number) => string {
  const t = useTranslations("console.integrations.toolReview");
  return (count: number) => {
    if (count === 0) return t("noCalls");
    if (count === 1) return t("oneCall");
    return t("manyCalls", { count });
  };
}

function useFormatLastUsed(): (lastUsedAt: string | undefined) => string | null {
  const t = useTranslations("console.integrations.toolReview");
  return (lastUsedAt: string | undefined) => {
    if (!lastUsedAt) return null;
    const date = new Date(lastUsedAt);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60_000);
    if (diffMins < 1) return t("justNow");
    if (diffMins < 60) return t("minutesAgo", { count: diffMins });
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return t("hoursAgo", { count: diffHours });
    const diffDays = Math.floor(diffHours / 24);
    return t("daysAgo", { count: diffDays });
  };
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ToolReview({
  tools,
  onApprove,
  onReject,
}: ToolReviewProps) {
  const t = useTranslations("console.integrations.toolReview");
  const { approved, needsReview, rejected } = useMemo(() => {
    const approvedTools: DiscoveredTool[] = [];
    const reviewTools: DiscoveredTool[] = [];
    const rejectedTools: DiscoveredTool[] = [];

    for (const tool of tools) {
      switch (tool.approvalStatus) {
        case "approved":
          approvedTools.push(tool);
          break;
        case "rejected":
          rejectedTools.push(tool);
          break;
        default:
          // quarantined + discovered both need review
          reviewTools.push(tool);
          break;
      }
    }

    return {
      approved: approvedTools,
      needsReview: reviewTools,
      rejected: rejectedTools,
    };
  }, [tools]);

  if (tools.length === 0) {
    return (
      <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-8 text-center">
        <Shield className="h-8 w-8 text-cream/35 mx-auto mb-2" />
        <p className="text-sm text-cream/60">{t("noToolsDiscoveredYet")}</p>
        <p className="text-xs text-cream/35 mt-1">
          {t("toolsAppearOnceConnected")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Summary */}
      <div className="flex items-center gap-4 text-xs text-cream/60">
        <span>{t("summaryDiscovered", { count: tools.length })}</span>
        {approved.length > 0 && (
          <span className="text-sodium">{t("summaryApproved", { count: approved.length })}</span>
        )}
        {needsReview.length > 0 && (
          <span className="text-sodium">{t("summaryNeedsReview", { count: needsReview.length })}</span>
        )}
        {rejected.length > 0 && (
          <span className="text-terra">{t("summaryRejected", { count: rejected.length })}</span>
        )}
      </div>

      {/* Approved Tools */}
      {approved.length > 0 && (
        <ToolSection
          title={t("sectionApproved")}
          icon={<Check className="h-3.5 w-3.5 text-sodium" />}
          badgeColor="text-sodium"
          count={approved.length}
        >
          {approved.map((tool) => (
            <ApprovedToolCard key={tool.id} tool={tool} />
          ))}
        </ToolSection>
      )}

      {/* Needs Review */}
      {needsReview.length > 0 && (
        <ToolSection
          title={t("sectionNeedsReview")}
          icon={<AlertTriangle className="h-3.5 w-3.5 text-sodium" />}
          badgeColor="text-sodium"
          count={needsReview.length}
        >
          {needsReview.map((tool) => (
            <ReviewToolCard
              key={tool.id}
              tool={tool}
              onApprove={onApprove}
              onReject={onReject}
            />
          ))}
        </ToolSection>
      )}

      {/* Rejected Tools */}
      {rejected.length > 0 && (
        <ToolSection
          title={t("sectionRejected")}
          icon={<X className="h-3.5 w-3.5 text-terra" />}
          badgeColor="text-terra"
          count={rejected.length}
        >
          {rejected.map((tool) => (
            <RejectedToolCard key={tool.id} tool={tool} />
          ))}
        </ToolSection>
      )}
    </div>
  );
}

// ─── Section Container ────────────────────────────────────────────────────

function ToolSection({
  title,
  icon,
  badgeColor,
  count,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  badgeColor: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <span className={cn("text-xs font-medium", badgeColor)}>
          {title}
        </span>
        <span className="text-[10px] text-cream/35">({count})</span>
      </div>
      <div className="space-y-2">
        {children}
      </div>
    </div>
  );
}

// ─── Approved Tool Card ───────────────────────────────────────────────────

function ApprovedToolCard({ tool }: { tool: DiscoveredTool }) {
  const t = useTranslations("console.integrations.toolReview");
  const labels = useCapabilityLabels();
  const confidenceLabels = useConfidenceLabels();
  const formatLastUsed = useFormatLastUsed();
  const formatCallCount = useFormatCallCount();
  const lastUsed = formatLastUsed(tool.lastUsedAt);

  return (
    <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-3 transition-all hover:border-cream/[0.1]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <code className="text-sm font-medium text-cream font-mono truncate">
            {tool.toolName}
          </code>
          <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-sodium/10 text-sodium border border-sodium/20 shrink-0">
            {getCapabilityLabel(labels, t("unclassified"), tool.systemCapability)}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0 text-[10px] text-cream/45">
          <span className="flex items-center gap-1">
            <Activity className="h-3 w-3" />
            {formatCallCount(tool.callCount)}
          </span>
          {lastUsed && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {lastUsed}
            </span>
          )}
        </div>
      </div>
      {tool.description && (
        <p className="text-xs text-cream/60 mt-1.5 ml-0.5">
          {tool.description}
        </p>
      )}
      <div className="mt-1.5">
        <span className={cn(
          "text-[10px]",
          CONFIDENCE_VISUAL[tool.confidence].color,
        )}>
          {t("classificationLabel", { label: confidenceLabels[tool.confidence] })}
        </span>
      </div>
    </div>
  );
}

// ─── Review Tool Card ─────────────────────────────────────────────────────

function ReviewToolCard({
  tool,
  onApprove,
  onReject,
}: {
  tool: DiscoveredTool;
  onApprove: (toolId: string, overrideCapability?: string) => void;
  onReject: (toolId: string) => void;
}) {
  const t = useTranslations("console.integrations.toolReview");
  const labels = useCapabilityLabels();
  const confidenceLabels = useConfidenceLabels();
  const [showApproveDropdown, setShowApproveDropdown] = useState(false);
  const confidenceVisual = CONFIDENCE_VISUAL[tool.confidence];
  const capabilityOptions = useMemo(
    () => CAPABILITY_KEYS.map((k) => [k, labels[k]] as const),
    [labels],
  );

  return (
    <div className="rounded-xl border border-sodium/20 bg-sodium/[0.02] p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <code className="text-sm font-medium text-cream font-mono truncate">
            {tool.toolName}
          </code>
          <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-sodium/10 text-sodium border border-sodium/20 shrink-0">
            {t("quarantined")}
          </span>
        </div>
      </div>

      {tool.description && (
        <p className="text-xs text-cream/60 mt-1.5 ml-0.5">
          {tool.description}
        </p>
      )}

      <div className="mt-2 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={cn("text-[10px]", confidenceVisual.color)}>
            {t("confidenceLabel", { label: confidenceLabels[tool.confidence] })}
          </span>
        </div>
        {tool.classificationReason && (
          <p className="text-[10px] text-cream/45 italic">
            {t("reasonLabel", { reason: tool.classificationReason })}
          </p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 mt-3">
        <div className="relative">
          <button
            onClick={() => setShowApproveDropdown(!showApproveDropdown)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-sodium text-ink shadow-sm shadow-sodium/10 transition-all"
          >
            {t("approveAs")}
            <ChevronDown className={cn(
              "h-3 w-3 transition-transform",
              showApproveDropdown && "rotate-180",
            )} />
          </button>
          {showApproveDropdown && (
            <div className="absolute top-full left-0 mt-1 w-48 rounded-lg border border-cream/[0.08] bg-card shadow-2xl z-10 py-1 max-h-64 overflow-y-auto">
              {capabilityOptions.map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => {
                    onApprove(tool.id, value);
                    setShowApproveDropdown(false);
                  }}
                  className="w-full text-left px-3 py-1.5 text-xs text-cream/75 hover:text-cream hover:bg-cream/[0.06] transition-colors"
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          onClick={() => onReject(tool.id)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-terra/70 border border-terra/15 hover:border-terra/30 hover:text-terra hover:bg-terra/5 transition-colors"
        >
          <X className="h-3 w-3" />
          {t("rejectAction")}
        </button>
      </div>
    </div>
  );
}

// ─── Rejected Tool Card ───────────────────────────────────────────────────

function RejectedToolCard({ tool }: { tool: DiscoveredTool }) {
  const t = useTranslations("console.integrations.toolReview");
  return (
    <div className="rounded-xl border border-terra/10 bg-terra/[0.02] p-3 opacity-70">
      <div className="flex items-center gap-2">
        <code className="text-sm font-medium text-cream/60 font-mono truncate">
          {tool.toolName}
        </code>
        <span className="px-1.5 py-0.5 rounded text-[9px] font-medium bg-terra/10 text-terra border border-terra/20 shrink-0">
          {t("rejected")}
        </span>
      </div>
      {tool.description && (
        <p className="text-xs text-cream/45 mt-1.5 ml-0.5">
          {tool.description}
          <span className="text-cream/35">{t("rejectedByUserSuffix")}</span>
        </p>
      )}
    </div>
  );
}
