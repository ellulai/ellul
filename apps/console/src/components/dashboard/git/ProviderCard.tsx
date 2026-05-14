// SPDX-License-Identifier: MIT
"use client";

import { useTranslations } from "next-intl";
import { ExternalLink } from "lucide-react";
import { API_URL } from "@/lib/api";

type GitProvider = "github" | "gitlab" | "bitbucket";

interface ProviderCardProps {
  provider: GitProvider;
  available: boolean;
  onBeforeConnect?: () => void;
  // App directory to pass through OAuth state so callback can redirect back to the app
  appDirectory?: string | null;
}

const PROVIDER_INFO: Record<
  GitProvider,
  { name: string; color: string; bgColor: string; borderColor: string; description: string }
> = {
  github: {
    name: "GitHub",
    color: "text-cream",
    bgColor: "bg-cream/[0.02]",
    borderColor: "border-border",
    description: "Most popular for open source and teams",
  },
  gitlab: {
    name: "GitLab",
    color: "text-sodium",
    bgColor: "bg-cream/[0.02]",
    borderColor: "border-border",
    description: "Built-in CI/CD and DevOps platform",
  },
  bitbucket: {
    name: "Bitbucket",
    color: "text-blue-400",
    bgColor: "bg-cream/[0.02]",
    borderColor: "border-border",
    description: "Integrated with Atlassian tools",
  },
};

function ProviderLogo({ provider, className }: { provider: GitProvider; className?: string }) {
  const size = className || "h-5 w-5";
  switch (provider) {
    case "github":
      return (
        <svg className={size} viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
        </svg>
      );
    case "gitlab":
      return (
        <svg className={size} viewBox="0 0 24 24" fill="currentColor">
          <path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.78 2.44-7.51A.42.42 0 0 1 4.82 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.49h8.1l2.44-7.51A.42.42 0 0 1 18.6 2a.43.43 0 0 1 .58 0 .42.42 0 0 1 .11.18l2.44 7.51L23 13.45a.84.84 0 0 1-.35.94z" />
        </svg>
      );
    case "bitbucket":
      return (
        <svg className={size} viewBox="0 0 24 24" fill="currentColor">
          <path d="M.778 1.213a.768.768 0 0 0-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 0 0 .77-.646L23.99 2.104a.768.768 0 0 0-.768-.891zm13.142 13.477H9.932L8.99 9.31h5.86z" />
        </svg>
      );
  }
}

export function ProviderCard({ provider, available, onBeforeConnect, appDirectory }: ProviderCardProps) {
  const t = useTranslations("console.git.providerCard");
  const info = PROVIDER_INFO[provider];

  const handleConnect = () => {
    onBeforeConnect?.();
    const params = new URLSearchParams();
    if (appDirectory) params.set('app', appDirectory);
    params.set('return_origin', window.location.origin);
    params.set('return_path', window.location.pathname + window.location.search);
    window.location.href = `${API_URL}/api/git/connect/${provider}?${params.toString()}`;
  };

  return (
    <div
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border ${info.borderColor} ${info.bgColor} ${!available ? "opacity-40" : ""}`}
    >
      <div className={`${info.color} shrink-0`}>
        <ProviderLogo provider={provider} />
      </div>
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium text-cream/85">
          {info.name}
        </span>
        {!available && (
          <span className="text-[10px] text-cream/45 ml-2">{t("comingSoon")}</span>
        )}
      </div>
      {available ? (
        <button
          onClick={handleConnect}
          className="shrink-0 px-3 py-1 text-xs font-medium text-cream/75 bg-cream/[0.06] hover:bg-cream/[0.1] border border-cream/[0.08] rounded-md transition-colors flex items-center gap-1.5"
        >
          {t("connect")}
          <ExternalLink className="h-3 w-3 text-cream/45" />
        </button>
      ) : (
        <span className="shrink-0 px-3 py-1 text-xs text-cream/35 border border-cream/[0.04] rounded-md">
          {t("unavailable")}
        </span>
      )}
    </div>
  );
}

export { ProviderLogo, PROVIDER_INFO };
export type { GitProvider };
