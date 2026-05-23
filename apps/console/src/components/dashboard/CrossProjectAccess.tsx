// SPDX-License-Identifier: MIT
"use client";

import { useTranslations } from "next-intl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FolderOpen,
  AlertCircle,
  Eye,
  Check,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useVpsBridge } from "@/lib/vps-bridge";
import { getVpsApiUrl } from "@/lib/domains";
import {
  parseSandboxId,
  sandboxIdFromPath,
  type SandboxId,
} from "@ellul.ai/types";

interface CrossProjectAccessProps {
  serverDomain: string;
  // The user's currently-selected sandbox. Cross-project grants are
  currentSandboxId: SandboxId;
  // Every other sandbox on this VPS (the user's grant choices).
  otherSandboxIds: SandboxId[];
  tier?: "standard" | "web_locked" | "private_locked";
}

interface AccessRule {
  sandboxId: SandboxId;
  sharedSandboxId: SandboxId;
  grantedAt: number;
  sharePreview: boolean;
}

export function CrossProjectAccess({
  serverDomain,
  currentSandboxId,
  otherSandboxIds,
  tier,
}: CrossProjectAccessProps) {
  if (tier !== "standard") {
    return (
      <CrossProjectBridge
        serverDomain={serverDomain}
        currentSandboxId={currentSandboxId}
        otherSandboxIds={otherSandboxIds}
      />
    );
  }
  return (
    <CrossProjectDirect
      serverDomain={serverDomain}
      currentSandboxId={currentSandboxId}
      otherSandboxIds={otherSandboxIds}
    />
  );
}

// ── Bridge-based (web_locked tier) ──

function CrossProjectBridge({
  serverDomain,
  currentSandboxId,
  otherSandboxIds,
}: {
  serverDomain: string;
  currentSandboxId: SandboxId;
  otherSandboxIds: SandboxId[];
}) {
  const { send } = useVpsBridge();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ rules: AccessRule[] }>({
    queryKey: ["cross-project-access", serverDomain],
    queryFn: () => send<{ rules: AccessRule[] }>("cross_project_list"),
    staleTime: 30_000,
  });

  const grantMutation = useMutation({
    mutationFn: (sharedSandboxId: SandboxId) =>
      send("cross_project_grant", {
        sandboxId: currentSandboxId,
        sharedSandboxId,
        sharePreview: true,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cross-project-access", serverDomain] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (sharedSandboxId: SandboxId) =>
      send("cross_project_revoke", {
        sandboxId: currentSandboxId,
        sharedSandboxId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cross-project-access", serverDomain] });
    },
  });

  return (
    <CrossProjectUI
      rules={data?.rules ?? []}
      isLoading={isLoading}
      currentSandboxId={currentSandboxId}
      otherSandboxIds={otherSandboxIds}
      grantMutation={grantMutation}
      revokeMutation={revokeMutation}
    />
  );
}

// ── Direct fetch (standard tier) ──

function CrossProjectDirect({
  serverDomain,
  currentSandboxId,
  otherSandboxIds,
}: {
  serverDomain: string;
  currentSandboxId: SandboxId;
  otherSandboxIds: SandboxId[];
}) {
  const vpsUrl = getVpsApiUrl(serverDomain);
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<{ rules: AccessRule[] }>({
    queryKey: ["cross-project-access", serverDomain],
    queryFn: async () => {
      const res = await fetch(`${vpsUrl}/_auth/cross-project-access`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return { rules: [] };
      return res.json();
    },
    staleTime: 30_000,
  });

  const t = useTranslations("console.crossProject");

  const grantMutation = useMutation({
    mutationFn: async (sharedSandboxId: SandboxId) => {
      const res = await fetch(`${vpsUrl}/_auth/cross-project-access`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          sandboxId: currentSandboxId,
          sharedSandboxId,
          sharePreview: true,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error || t("grantFailed"));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cross-project-access", serverDomain] });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (sharedSandboxId: SandboxId) => {
      const res = await fetch(`${vpsUrl}/_auth/cross-project-access`, {
        method: "DELETE",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ sandboxId: currentSandboxId, sharedSandboxId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed" }));
        throw new Error(err.error || t("revokeFailed"));
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cross-project-access", serverDomain] });
    },
  });

  return (
    <CrossProjectUI
      rules={data?.rules ?? []}
      isLoading={isLoading}
      currentSandboxId={currentSandboxId}
      otherSandboxIds={otherSandboxIds}
      grantMutation={grantMutation}
      revokeMutation={revokeMutation}
    />
  );
}

// ── Shared UI ──

interface MutationLike {
  mutate: (arg: SandboxId) => void;
  isPending: boolean;
  error: Error | null;
}

interface CrossProjectUIProps {
  rules: AccessRule[];
  isLoading: boolean;
  currentSandboxId: SandboxId;
  otherSandboxIds: SandboxId[];
  grantMutation: MutationLike;
  revokeMutation: MutationLike;
}

function CrossProjectUI({
  rules,
  isLoading,
  currentSandboxId,
  otherSandboxIds,
  grantMutation,
  revokeMutation,
}: CrossProjectUIProps) {
  const t = useTranslations("console.crossProject");
  const canRead = rules.filter((r) => r.sandboxId === currentSandboxId);
  const sharedTo = rules.filter((r) => r.sharedSandboxId === currentSandboxId);

  const grantedSet = new Set(canRead.map((r) => r.sharedSandboxId));
  const otherSandboxes = otherSandboxIds.filter((s) => s !== currentSandboxId);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-4">
        <div className="flex items-center gap-2 mb-3">
          <FolderOpen className="h-4 w-4 text-cream/60" />
          <span className="text-sm font-medium text-cream">{t("title")}</span>
        </div>
        <div className="flex items-center justify-center py-4">
          <Spinner size="default" color="muted" delay={300} />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-4 space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <FolderOpen className="h-4 w-4 text-cream/60" />
          <span className="text-sm font-medium text-cream">{t("title")}</span>
        </div>
        <p className="text-xs text-cream/60">
          {t.rich("subtitle", {
            code: (chunks) => <code className="text-sodium">{chunks}</code>,
          })}
        </p>
      </div>

      {/* Sandbox list — toggle each on/off */}
      {otherSandboxes.length > 0 ? (
        <div className="space-y-1">
          {otherSandboxes.map((sandboxId) => {
            const isGranted = grantedSet.has(sandboxId);
            return (
              <button
                key={sandboxId}
                type="button"
                onClick={() => {
                  if (isGranted) {
                    revokeMutation.mutate(sandboxId);
                  } else {
                    grantMutation.mutate(sandboxId);
                  }
                }}
                disabled={grantMutation.isPending || revokeMutation.isPending}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-cream/[0.06] bg-cream/[0.02] text-left hover:bg-cream/[0.04] transition-colors disabled:opacity-50"
              >
                <div className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 transition-colors ${
                  isGranted
                    ? "bg-sodium border-sodium"
                    : "border-cream/[0.15] bg-cream/[0.03]"
                }`}>
                  {isGranted && <Check className="h-3 w-3 text-cream" />}
                </div>
                <FolderOpen className={`h-3.5 w-3.5 shrink-0 ${isGranted ? "text-blue-400" : "text-cream/45"}`} />
                <span className={`text-xs font-medium flex-1 truncate ${isGranted ? "text-cream" : "text-cream/60"}`}>
                  {sandboxId}
                </span>
                {isGranted && (
                  <span className="text-[10px] text-cream/45 shrink-0">{t("sourcePreview")}</span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="text-center py-3">
          <p className="text-xs text-cream/45">{t("noOtherSandboxes")}</p>
        </div>
      )}

      {/* Visible to — read-only info */}
      {sharedTo.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-cream/60 uppercase tracking-wider">
            {t("visibleTo")}
          </p>
          {sharedTo.map((rule) => (
            <div
              key={rule.sandboxId}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-cream/[0.04] bg-cream/[0.01]"
            >
              <Eye className="h-3 w-3 text-cream/45" />
              <span className="text-xs text-cream/75 font-medium">{rule.sandboxId}</span>
              <span className="text-[10px] text-cream/35">{t("readsThisSandbox")}</span>
            </div>
          ))}
        </div>
      )}

      {(grantMutation.error || revokeMutation.error) && (
        <div className="flex items-center gap-2 p-2 rounded-lg bg-terra/10 border border-terra/20">
          <AlertCircle className="h-3.5 w-3.5 text-terra shrink-0" />
          <span className="text-xs text-terra">
            {(grantMutation.error || revokeMutation.error)?.message}
          </span>
        </div>
      )}

      <p className="text-[11px] text-cream/45">
        {t("changesNote")}
      </p>
    </div>
  );
}

// Re-export scope helpers for parent components that produce the props.
export { parseSandboxId, sandboxIdFromPath };
