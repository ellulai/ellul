// SPDX-License-Identifier: MIT
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { AlertTriangle, Check, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useVpsBridge } from "@/lib/vps-bridge";

interface Proposal {
  id: string;
  rule_id: string | null;
  action: string;
  reason: string;
  payload: string;
  created_at: string;
}

const ACTION_VARIANT: Record<string, "warning" | "secondary" | "destructive"> = {
  disable: "warning",
  modify: "secondary",
  delete: "destructive",
  create: "secondary",
};

// ── API abstraction ─────────────────────────────────────────

function useProposalApi(serverDomain: string, tier: string) {
  const t = useTranslations("console.policyProposals");
  const { send } = useVpsBridge();
  const base = `https://${serverDomain}`;
  const opts = { credentials: "include" as const };

  if (tier !== "standard") {
    return {
      list: () => send<{ proposals: Proposal[]; total: number }>("guardrail_proposals"),
      approve: (id: string) => send("guardrail_proposal_approve", { id }),
      deny: (id: string) => send("guardrail_proposal_deny", { id }),
    };
  }
  return {
    list: async () => {
      const res = await fetch(`${base}/_auth/guardrail/proposals`, opts);
      if (!res.ok) return { proposals: [] as Proposal[], total: 0 };
      return res.json() as Promise<{ proposals: Proposal[]; total: number }>;
    },
    approve: async (id: string) => {
      const res = await fetch(`${base}/_auth/guardrail/proposals/${encodeURIComponent(id)}/approve`, {
        method: "POST", ...opts,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: t("approveFailed") }));
        throw new Error(err.error || t("approveFailed"));
      }
    },
    deny: async (id: string) => {
      const res = await fetch(`${base}/_auth/guardrail/proposals/${encodeURIComponent(id)}/deny`, {
        method: "POST", ...opts,
      });
      if (!res.ok) throw new Error(t("denyFailed"));
    },
  };
}

export function PolicyProposalsCard({ serverDomain, tier }: { serverDomain: string; tier: string }) {
  const t = useTranslations("console.policyProposals");
  const queryClient = useQueryClient();
  const api = useProposalApi(serverDomain, tier);

  const { data } = useQuery({
    queryKey: ["policy-proposals", serverDomain],
    queryFn: async () => {
      try {
        return await api.list();
      } catch {
        return { proposals: [], total: 0 };
      }
    },
    staleTime: 10_000,
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => api.approve(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["policy-proposals"] });
      queryClient.invalidateQueries({ queryKey: ["policies"] });
      toast.success(t("approvedToast"));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const denyMutation = useMutation({
    mutationFn: (id: string) => api.deny(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["policy-proposals"] });
      toast.success(t("deniedToast"));
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const proposals = data?.proposals ?? [];
  if (proposals.length === 0) return null;

  return (
    <div className="rounded-xl border border-sodium/20 bg-sodium/[0.03] p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-sodium" />
          <span className="text-sm font-medium text-cream">{t("agentProposals")}</span>
        </div>
        <Badge variant="warning" className="text-[10px]">
          {t("pendingCount", { count: proposals.length })}
        </Badge>
      </div>
      <p className="text-xs text-cream/60">
        {t("introBody")}
      </p>
      <div className="space-y-2">
        {proposals.map((proposal) => (
          <div
            key={proposal.id}
            className="flex items-center justify-between rounded-lg border border-cream/[0.06] bg-cream/[0.02] px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-0.5">
                <Badge
                  variant={ACTION_VARIANT[proposal.action] ?? "secondary"}
                  className="text-[9px] px-1.5 py-0"
                >
                  {proposal.action}
                </Badge>
                {proposal.rule_id && (
                  <span className="text-xs font-medium text-cream/75 truncate">
                    {proposal.rule_id}
                  </span>
                )}
              </div>
              <p className="text-[10px] text-cream/45 italic truncate max-w-[300px]">
                &quot;{proposal.reason}&quot;
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0 ml-3">
              <button
                type="button"
                onClick={() => approveMutation.mutate(proposal.id)}
                disabled={approveMutation.isPending}
                className="p-1.5 rounded-md border border-cream/[0.08] hover:bg-sodium/10 hover:border-sodium/30 transition-colors text-cream/60 hover:text-sodium disabled:opacity-50"
                title={t("approve")}
              >
                <Check className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => denyMutation.mutate(proposal.id)}
                disabled={denyMutation.isPending}
                className="p-1.5 rounded-md border border-cream/[0.08] hover:bg-terra/10 hover:border-terra/30 transition-colors text-cream/60 hover:text-terra disabled:opacity-50"
                title={t("deny")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
