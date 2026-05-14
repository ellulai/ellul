// SPDX-License-Identifier: MIT
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  Key,
  MessageSquare,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ModelProviders } from "../ModelProviders";
import { ClawChannels } from "../ClawChannels";
import { ClawCoreFiles } from "../ClawCoreFiles";

// ─── Types ──────────────────────────────────────────────────────────────────

interface IntAiAgentsProps {
  serverId: string;
  serverDomain: string;
  apps: Array<{ name: string; directory: string; type: string }>;
  selectedApp?: string | null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function SectionHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-3 px-3 py-2 rounded-lg bg-cream/[0.02] border border-cream/[0.04]">
      <h2 className="text-sm font-semibold text-cream uppercase tracking-wider">
        {title}
      </h2>
      <p className="text-xs text-cream/60 mt-0.5">{description}</p>
    </div>
  );
}

// ─── Component ──────────────────────────────────────────────────────────────

export function IntAiAgents({
  serverId,
  serverDomain,
  selectedApp,
}: IntAiAgentsProps) {
  const t = useTranslations("console.intAiAgents");
  const [aiTab, setAiTab] = useState<string>("provider");

  const aiSubTabs = [
    { id: "provider", label: t("tabs.provider"), icon: Key },
    { id: "channels", label: t("tabs.channels"), icon: MessageSquare },
    { id: "core-files", label: t("tabs.coreFiles"), icon: FileText },
  ] as const;

  return (
    <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-6">
      <section>
        <SectionHeader
          title={t("header.title")}
          description={t("header.description")}
        />

        {/* Sub-tab segmented control */}
        <div className="mb-4">
          <div className="inline-flex items-center gap-0.5 p-1 rounded-lg bg-cream/[0.03] border border-cream/[0.06]">
            {aiSubTabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setAiTab(tab.id)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                    aiTab === tab.id
                      ? "bg-cream/[0.08] text-cream shadow-sm"
                      : "text-cream/45 hover:text-cream/75",
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Sub-tab content */}
        <div className="rounded-xl border border-cream/[0.06] bg-cream/[0.02] p-4">
          {aiTab === "provider" && (
            <ModelProviders serverId={serverId} serverDomain={serverDomain} />
          )}
          {aiTab === "channels" && (
            <ClawChannels serverDomain={serverDomain} project={selectedApp ?? null} />
          )}
          {aiTab === "core-files" && (
            <ClawCoreFiles serverDomain={serverDomain} />
          )}
        </div>
      </section>
    </div>
  );
}
