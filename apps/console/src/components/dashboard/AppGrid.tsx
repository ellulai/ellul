// SPDX-License-Identifier: MIT
"use client";

import { useTranslations } from "next-intl";
import { ExternalLink, Rocket, Box } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

// Stack color mappings
const STACK_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  "Next.js": { bg: "rgba(0, 0, 0, 0.3)", text: "#ffffff", border: "rgba(255, 255, 255, 0.2)" },
  "Next.js/TS": { bg: "rgba(0, 112, 243, 0.2)", text: "#F0A65A", border: "rgba(59, 130, 246, 0.3)" },
  "React": { bg: "rgba(97, 218, 251, 0.15)", text: "#61dafb", border: "rgba(97, 218, 251, 0.3)" },
  "React/TS": { bg: "rgba(97, 218, 251, 0.15)", text: "#61dafb", border: "rgba(97, 218, 251, 0.3)" },
  "Vue": { bg: "rgba(66, 184, 131, 0.15)", text: "#42b883", border: "rgba(66, 184, 131, 0.3)" },
  "Nuxt": { bg: "rgba(0, 220, 130, 0.15)", text: "#00dc82", border: "rgba(0, 220, 130, 0.3)" },
  "Svelte": { bg: "rgba(255, 62, 0, 0.15)", text: "#ff3e00", border: "rgba(255, 62, 0, 0.3)" },
  "Express": { bg: "rgba(255, 255, 255, 0.1)", text: "#ffffff", border: "rgba(255, 255, 255, 0.2)" },
  "Hono": { bg: "rgba(255, 107, 0, 0.15)", text: "#ff6b00", border: "rgba(255, 107, 0, 0.3)" },
  "Fastify": { bg: "rgba(255, 255, 255, 0.1)", text: "#ffffff", border: "rgba(255, 255, 255, 0.2)" },
  "Node.js": { bg: "rgba(104, 160, 99, 0.15)", text: "#68a063", border: "rgba(104, 160, 99, 0.3)" },
  "Node.js/TS": { bg: "rgba(49, 120, 198, 0.15)", text: "#3178c6", border: "rgba(49, 120, 198, 0.3)" },
  "Python": { bg: "rgba(255, 212, 59, 0.15)", text: "#ffd43b", border: "rgba(255, 212, 59, 0.3)" },
  "FastAPI": { bg: "rgba(0, 150, 136, 0.15)", text: "#009688", border: "rgba(0, 150, 136, 0.3)" },
  "Flask": { bg: "rgba(255, 255, 255, 0.1)", text: "#ffffff", border: "rgba(255, 255, 255, 0.2)" },
  "Django": { bg: "rgba(12, 75, 51, 0.2)", text: "#44b78b", border: "rgba(68, 183, 139, 0.3)" },
  "Go": { bg: "rgba(0, 173, 216, 0.15)", text: "#00add8", border: "rgba(0, 173, 216, 0.3)" },
  "Rust": { bg: "rgba(222, 165, 132, 0.15)", text: "#dea584", border: "rgba(222, 165, 132, 0.3)" },
  "Unknown": { bg: "rgba(113, 113, 122, 0.15)", text: "#a1a1aa", border: "rgba(161, 161, 170, 0.3)" },
};

interface App {
  name: string;
  displayName?: string;
  directory: string;
  url: string;
  port: string | number;
  stack: string;
  summary: string;
  createdAt?: string;
  projectPath?: string;
}

interface AppGridProps {
  apps: App[];
  isLoading?: boolean;
  onShipClick?: () => void;
}

function getStackColors(stack: string): { bg: string; text: string; border: string } {
  // Check for exact match first
  if (STACK_COLORS[stack]) {
    return STACK_COLORS[stack];
  }
  // Check for partial matches
  for (const [key, value] of Object.entries(STACK_COLORS)) {
    if (stack.toLowerCase().includes(key.toLowerCase())) {
      return value;
    }
  }
  return STACK_COLORS["Unknown"] ?? { bg: "rgba(113, 113, 122, 0.15)", text: "#a1a1aa", border: "rgba(161, 161, 170, 0.3)" };
}

function AppCard({ app }: { app: App }) {
  const stackColors = getStackColors(app.stack);

  return (
    <div
      className="relative group rounded-lg overflow-hidden transition-all duration-200 hover:scale-[1.02]"
      style={{
        backgroundColor: "rgba(24, 24, 27, 0.8)",
        borderWidth: "1px",
        borderStyle: "solid",
        borderColor: "rgba(63, 63, 70, 0.5)",
      }}
    >
      {/* Hover glow effect */}
      <div
        className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
        style={{
          boxShadow: `inset 0 0 30px ${stackColors.border}`,
        }}
      />

      <div className="relative p-4 space-y-3">
        {/* Header: Name + Stack Badge */}
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-cream text-lg">{app.displayName || app.name}</h3>
          <span
            className="px-2.5 py-0.5 rounded-full text-xs font-medium"
            style={{
              backgroundColor: stackColors.bg,
              color: stackColors.text,
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: stackColors.border,
            }}
          >
            {app.stack}
          </span>
        </div>

        {/* Summary */}
        {app.summary && (
          <p
            className="text-sm italic line-clamp-2"
            style={{ color: "rgba(161, 161, 170, 1)" }}
          >
            {app.summary}
          </p>
        )}

        {/* Footer: URL + Port */}
        <div className="flex items-center justify-between pt-2 border-t border-border/50">
          <a
            href={app.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-sm transition-colors hover:underline"
            style={{ color: stackColors.text }}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="truncate max-w-[180px]">
              {app.url.replace("https://", "")}
            </span>
          </a>
          <span className="text-xs text-cream/60 font-mono">:{app.port}</span>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onShipClick }: { onShipClick?: () => void }) {
  const t = useTranslations("console.appGrid");
  return (
    <div
      className="relative rounded-lg overflow-hidden"
      style={{
        backgroundColor: "rgba(24, 24, 27, 0.4)",
        borderWidth: "1px",
        borderStyle: "dashed",
        borderColor: "rgba(63, 63, 70, 0.5)",
      }}
    >
      <div className="p-8 text-center space-y-4">
        <div className="flex justify-center">
          <div
            className="p-4 rounded-full"
            style={{ backgroundColor: "rgba(63, 63, 70, 0.3)" }}
          >
            <Box className="h-8 w-8 text-cream/60" />
          </div>
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-medium text-cream/75">{t("noSandboxesYet")}</h3>
          <p className="text-sm text-cream/60 max-w-xs mx-auto">
            {t("noSandboxesHint")}
          </p>
        </div>
        {onShipClick && (
          <button
            onClick={onShipClick}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all hover:scale-105"
            style={{
              backgroundColor: "rgba(240, 166, 90, 0.2)",
              color: "#F4B873",
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: "rgba(240, 166, 90, 0.3)",
            }}
          >
            <Rocket className="h-4 w-4" />
            {t("shipFirstSandbox")}
          </button>
        )}
      </div>
    </div>
  );
}

export function AppGrid({ apps, isLoading, onShipClick }: AppGridProps) {
  const t = useTranslations("console.appGrid");

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner size="default" color="muted" delay={300} />
      </div>
    );
  }

  if (!apps || apps.length === 0) {
    return <EmptyState onShipClick={onShipClick} />;
  }

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-cream/60 uppercase tracking-wider">
          {t("deployedSandboxes")}
        </h2>
        <span className="text-xs text-cream/60">
          {t("sandboxCount", { count: apps.length })}
        </span>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {apps.map((app) => (
          <AppCard key={app.directory} app={app} />
        ))}
      </div>
    </div>
  );
}
